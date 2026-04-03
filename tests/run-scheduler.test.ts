import { describe, it, expect, beforeEach } from 'vitest'
import {
  RunScheduler,
  RunCancelledError,
  type RunRecord,
  type RunContext,
} from '../run-scheduler.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'proj-1',
    threadId: `thread-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  }
}

function defer<T = void>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------------------
// Schedule and complete a run
// ---------------------------------------------------------------------------

describe('RunScheduler', () => {
  let scheduler: RunScheduler

  beforeEach(() => {
    scheduler = new RunScheduler()
  })

  it('schedules and completes a run', async () => {
    const ctx = makeContext()
    const handle = scheduler.schedule(ctx, async () => 'done')
    const result = await handle.promise
    expect(result).toBe('done')

    const record = scheduler.getRun(ctx.runId)
    expect(record?.status).toBe('completed')
    expect(record?.result).toBe('done')
    expect(record?.finishedAt).toBeDefined()
    expect(record?.startedAt).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // Cancel a queued run
  // -------------------------------------------------------------------------

  it('cancels a queued run', async () => {
    // Fill up global limit so next run stays queued
    const blockers: ReturnType<typeof defer<unknown>>[] = []
    const blockerHandles: ReturnType<typeof scheduler.schedule>[] = []
    for (let i = 0; i < 8; i++) {
      const d = defer<unknown>()
      blockers.push(d)
      blockerHandles.push(
        scheduler.schedule(
          makeContext({ runId: `blocker-${i}`, threadId: `bt-${i}` }),
          async () => d.promise,
        ),
      )
    }

    const ctx = makeContext({ threadId: 'queued-thread' })
    const handle = scheduler.schedule(ctx, async () => 'should-not-run')

    expect(scheduler.getRun(ctx.runId)?.status).toBe('queued')
    const cancelled = handle.cancel('test cancel')
    expect(cancelled).toBe(true)
    expect(scheduler.getRun(ctx.runId)?.status).toBe('cancelled')

    await expect(handle.promise).rejects.toThrow(RunCancelledError)

    // Clean up blockers
    for (const d of blockers) d.resolve(undefined)
    await Promise.allSettled(blockerHandles.map((h) => h.promise))
  })

  // -------------------------------------------------------------------------
  // Cancel a running run
  // -------------------------------------------------------------------------

  it('cancels a running run', async () => {
    const started = defer()
    const blocker = defer()

    const ctx = makeContext()
    const handle = scheduler.schedule(ctx, async (signal) => {
      started.resolve()
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        })
        blocker.promise.then(resolve)
      })
    })

    await started.promise
    expect(scheduler.getRun(ctx.runId)?.status).toBe('running')

    const cancelled = handle.cancel('user cancel')
    expect(cancelled).toBe(true)

    await expect(handle.promise).rejects.toThrow(RunCancelledError)
    expect(scheduler.getRun(ctx.runId)?.status).toBe('cancelled')
    expect(scheduler.getRun(ctx.runId)?.cancelReason).toBe('user cancel')
  })

  // -------------------------------------------------------------------------
  // Concurrency limits
  // -------------------------------------------------------------------------

  describe('concurrency limits', () => {
    it('respects global limit', async () => {
      const sched = new RunScheduler({ globalLimit: 2 })
      const blockers = [defer(), defer()]

      const h1 = sched.schedule(
        makeContext({ runId: 'r1', threadId: 't1' }),
        async () => blockers[0].promise,
      )
      const h2 = sched.schedule(
        makeContext({ runId: 'r2', threadId: 't2' }),
        async () => blockers[1].promise,
      )
      const h3 = sched.schedule(
        makeContext({ runId: 'r3', threadId: 't3' }),
        async () => 'third',
      )

      // r1 and r2 should be running, r3 queued
      expect(sched.getRun('r1')?.status).toBe('running')
      expect(sched.getRun('r2')?.status).toBe('running')
      expect(sched.getRun('r3')?.status).toBe('queued')

      blockers[0].resolve(undefined)
      await h1.promise
      // Now r3 should start
      // Give drain a tick
      await new Promise((r) => setTimeout(r, 10))
      expect(sched.getRun('r3')?.status).not.toBe('queued')

      blockers[1].resolve(undefined)
      await Promise.all([h2.promise, h3.promise])
    })

    it('respects per-project limit', async () => {
      const sched = new RunScheduler({ perProjectLimit: 1 })
      const blocker = defer()

      const h1 = sched.schedule(
        makeContext({ runId: 'r1', projectId: 'p1', threadId: 't1' }),
        async () => blocker.promise,
      )
      const h2 = sched.schedule(
        makeContext({ runId: 'r2', projectId: 'p1', threadId: 't2' }),
        async () => 'second',
      )

      expect(sched.getRun('r1')?.status).toBe('running')
      expect(sched.getRun('r2')?.status).toBe('queued')

      blocker.resolve(undefined)
      await h1.promise
      await h2.promise
      expect(sched.getRun('r2')?.status).toBe('completed')
    })

    it('enforces one run per thread', async () => {
      const blocker = defer()
      const h1 = scheduler.schedule(
        makeContext({ runId: 'r1', threadId: 'same-thread' }),
        async () => blocker.promise,
      )
      const h2 = scheduler.schedule(
        makeContext({ runId: 'r2', threadId: 'same-thread' }),
        async () => 'second',
      )

      expect(scheduler.getRun('r1')?.status).toBe('running')
      expect(scheduler.getRun('r2')?.status).toBe('queued')

      blocker.resolve(undefined)
      await h1.promise
      await h2.promise
      expect(scheduler.getRun('r2')?.status).toBe('completed')
    })
  })

  // -------------------------------------------------------------------------
  // Status transitions
  // -------------------------------------------------------------------------

  describe('status transitions', () => {
    it('tracks queued → running → completed', async () => {
      const statuses: string[] = []
      const sched = new RunScheduler({
        onStatusChange: (r: RunRecord) => statuses.push(r.status),
      })

      const handle = sched.schedule(makeContext(), async () => 'ok')
      await handle.promise

      expect(statuses).toEqual(['queued', 'running', 'completed'])
    })

    it('tracks queued → running → failed', async () => {
      const statuses: string[] = []
      const sched = new RunScheduler({
        onStatusChange: (r: RunRecord) => statuses.push(r.status),
      })

      const handle = sched.schedule(makeContext(), async () => {
        throw new Error('boom')
      })

      await expect(handle.promise).rejects.toThrow('boom')
      expect(statuses).toEqual(['queued', 'running', 'failed'])
    })

    it('tracks queued → running → cancelled (abort during run)', async () => {
      const statuses: string[] = []
      const sched = new RunScheduler({
        onStatusChange: (r: RunRecord) => statuses.push(r.status),
      })

      const started = defer()
      const ctx = makeContext()
      const handle = sched.schedule(ctx, async (signal) => {
        started.resolve()
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        })
      })

      await started.promise
      handle.cancel('test')
      await expect(handle.promise).rejects.toThrow(RunCancelledError)
      // queued, running, running (cancel reason emitted), cancelled
      expect(statuses.at(-1)).toBe('cancelled')
    })
  })

  // -------------------------------------------------------------------------
  // listRuns with filters
  // -------------------------------------------------------------------------

  describe('listRuns', () => {
    it('lists all runs', async () => {
      const h1 = scheduler.schedule(
        makeContext({ runId: 'r1', threadId: 't1' }),
        async () => 'a',
      )
      const h2 = scheduler.schedule(
        makeContext({ runId: 'r2', threadId: 't2' }),
        async () => 'b',
      )
      await Promise.all([h1.promise, h2.promise])

      const runs = scheduler.listRuns()
      expect(runs.length).toBe(2)
    })

    it('filters by projectId', async () => {
      const h1 = scheduler.schedule(
        makeContext({ runId: 'r1', projectId: 'p1', threadId: 't1' }),
        async () => 'a',
      )
      const h2 = scheduler.schedule(
        makeContext({ runId: 'r2', projectId: 'p2', threadId: 't2' }),
        async () => 'b',
      )
      await Promise.all([h1.promise, h2.promise])

      const runs = scheduler.listRuns({ projectId: 'p1' })
      expect(runs.length).toBe(1)
      expect(runs[0].context.projectId).toBe('p1')
    })

    it('filters by status', async () => {
      const blocker = defer()
      const h1 = scheduler.schedule(
        makeContext({ runId: 'r1', threadId: 't1' }),
        async () => blocker.promise,
      )
      scheduler.schedule(
        makeContext({ runId: 'r2', threadId: 't2' }),
        async () => 'done',
      )
      // Let r2 settle
      await new Promise((r) => setTimeout(r, 10))

      const running = scheduler.listRuns({ status: 'running' })
      expect(running.length).toBe(1)
      expect(running[0].context.runId).toBe('r1')

      blocker.resolve(undefined)
      await h1.promise
    })

    it('returns cloned records', async () => {
      const handle = scheduler.schedule(makeContext(), async () => 'ok')
      await handle.promise
      const [a] = scheduler.listRuns()
      const [b] = scheduler.listRuns()
      expect(a).toEqual(b)
      expect(a).not.toBe(b)
    })
  })

  // -------------------------------------------------------------------------
  // classifyResult
  // -------------------------------------------------------------------------

  it('supports classifyResult to mark as failed', async () => {
    const handle = scheduler.schedule(
      makeContext(),
      async () => ({ ok: false }),
      {
        classifyResult: () => ({
          status: 'failed' as const,
          error: 'business rule violated',
          failureKind: 'failed' as const,
        }),
      },
    )

    // classifyResult sets status to failed, but the promise still resolves
    // with the original value
    const result = await handle.promise
    expect(result).toEqual({ ok: false })

    const record = scheduler.getRun(handle.runId)
    expect(record?.status).toBe('failed')
    expect(record?.error).toBe('business rule violated')
  })

  // -------------------------------------------------------------------------
  // updateRun
  // -------------------------------------------------------------------------

  it('updateRun patches metadata', async () => {
    const handle = scheduler.schedule(makeContext(), async () => 'ok')
    await handle.promise

    const updated = scheduler.updateRun(handle.runId, { retryable: true })
    expect(updated?.retryable).toBe(true)

    const record = scheduler.getRun(handle.runId)
    expect(record?.retryable).toBe(true)
  })

  it('updateRun returns undefined for unknown run', () => {
    expect(scheduler.updateRun('nope', { retryable: true })).toBeUndefined()
  })

  it('cancel returns false for unknown run', () => {
    expect(scheduler.cancel('nope')).toBe(false)
  })
})
