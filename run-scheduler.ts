export type RunStatus =
  | 'queued'
  | 'running'
  | 'cancelled'
  | 'failed'
  | 'completed'

export type RunFailureKind = 'failed' | 'waiting_approval'

export interface RunContext {
  runId: string
  projectId: string
  threadId: string
  agentId?: string
  label?: string
}

export interface RunRecord<TResult = unknown> {
  context: RunContext
  status: RunStatus
  queuedAt: string
  startedAt?: string
  finishedAt?: string
  result?: TResult
  error?: string
  cancelReason?: string
  failureKind?: RunFailureKind
  retryable?: boolean
  retryOfRunId?: string
}

export interface SchedulerOptions {
  globalLimit?: number
  perProjectLimit?: number
  onStatusChange?: (record: RunRecord) => void
}

export interface RunResultClassification {
  status: Extract<RunStatus, 'completed' | 'failed'>
  error?: string
  failureKind?: RunFailureKind
}

export interface ScheduleOptions<TResult = unknown> {
  signal?: AbortSignal
  label?: string
  classifyResult?: (result: TResult) => RunResultClassification
}

export interface ScheduledRunHandle<TResult = unknown> {
  readonly runId: string
  readonly context: RunContext
  readonly promise: Promise<TResult>
  cancel: (reason?: string) => boolean
}

interface QueueItem<TResult = unknown> {
  context: RunContext
  execute: (signal: AbortSignal) => Promise<TResult>
  controller: AbortController
  options?: ScheduleOptions<TResult>
  resolve: (value: TResult) => void
  reject: (reason?: unknown) => void
}

const DEFAULT_GLOBAL_LIMIT = 8
const DEFAULT_PROJECT_LIMIT = 3

function nowIso(): string {
  return new Date().toISOString()
}

function cloneRecord(record: RunRecord): RunRecord {
  return { ...record, context: { ...record.context } }
}

export class RunCancelledError extends Error {
  constructor(message = 'Run cancelled') {
    super(message)
    this.name = 'RunCancelledError'
  }
}

export class RunScheduler {
  private readonly globalLimit: number
  private readonly perProjectLimit: number
  private readonly onStatusChange?: (record: RunRecord) => void

  private readonly runs = new Map<string, RunRecord>()
  private readonly queue: QueueItem<any>[] = []
  private readonly activeRuns = new Map<string, QueueItem<any>>()
  private readonly activeByProject = new Map<string, number>()
  private readonly activeByThread = new Set<string>()
  private activeGlobal = 0

  constructor(options: SchedulerOptions = {}) {
    this.globalLimit = options.globalLimit ?? DEFAULT_GLOBAL_LIMIT
    this.perProjectLimit = options.perProjectLimit ?? DEFAULT_PROJECT_LIMIT
    this.onStatusChange = options.onStatusChange
  }

  schedule<TResult>(
    context: Omit<RunContext, 'label'>,
    execute: (signal: AbortSignal) => Promise<TResult>,
    options: ScheduleOptions<TResult> = {},
  ): ScheduledRunHandle<TResult> {
    const fullContext: RunContext = {
      ...context,
      label: options.label,
    }
    const record: RunRecord = {
      context: fullContext,
      status: 'queued',
      queuedAt: nowIso(),
    }

    this.runs.set(fullContext.runId, record)
    this.emit(record)

    const promise = new Promise<TResult>((resolve, reject) => {
      const controller = new AbortController()
      const item: QueueItem<TResult> = {
        context: fullContext,
        execute,
        controller,
        options,
        resolve,
        reject,
      }

      if (options.signal) {
        if (options.signal.aborted) {
          controller.abort(options.signal.reason)
        } else {
          options.signal.addEventListener(
            'abort',
            () => controller.abort(options.signal?.reason),
            { once: true },
          )
        }
      }

      this.queue.push(item)
      this.drainQueue()
    })

    return {
      runId: fullContext.runId,
      context: fullContext,
      promise,
      cancel: (reason?: string) => this.cancel(fullContext.runId, reason),
    }
  }

  cancel(runId: string, reason = 'Cancelled by user'): boolean {
    const record = this.runs.get(runId)
    if (!record) {
      return false
    }

    if (record.status === 'queued') {
      const index = this.queue.findIndex((item) => item.context.runId === runId)
      if (index >= 0) {
        const [item] = this.queue.splice(index, 1)
        item.controller.abort(reason)
        record.status = 'cancelled'
        record.finishedAt = nowIso()
        record.cancelReason = reason
        this.emit(record)
        item.reject(new RunCancelledError(reason))
        return true
      }
    }

    if (record.status === 'running') {
      const item = this.activeRuns.get(runId)
      if (!item) {
        return false
      }

      if (!item.controller.signal.aborted) {
        item.controller.abort(reason)
      }

      record.cancelReason = reason
      this.emit(record)
      return true
    }

    return false
  }

  getRun(runId: string): RunRecord | undefined {
    const record = this.runs.get(runId)
    return record ? cloneRecord(record) : undefined
  }

  updateRun(
    runId: string,
    patch: Partial<Pick<RunRecord, 'failureKind' | 'retryable' | 'retryOfRunId'>>,
  ): RunRecord | undefined {
    const record = this.runs.get(runId)
    if (!record) {
      return undefined
    }

    Object.assign(record, patch)
    this.emit(record)
    return cloneRecord(record)
  }

  listRuns(filters: {
    projectId?: string
    threadId?: string
    agentId?: string
    status?: RunStatus
  } = {}): RunRecord[] {
    return [...this.runs.values()]
      .filter((record) => {
        if (filters.projectId && record.context.projectId !== filters.projectId) {
          return false
        }
        if (filters.threadId && record.context.threadId !== filters.threadId) {
          return false
        }
        if (filters.agentId && record.context.agentId !== filters.agentId) {
          return false
        }
        if (filters.status && record.status !== filters.status) {
          return false
        }
        return true
      })
      .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt))
      .map((record) => cloneRecord(record))
  }

  private drainQueue(): void {
    let startedAny = true

    while (startedAny) {
      startedAny = false

      if (this.activeGlobal >= this.globalLimit) {
        return
      }

      for (let index = 0; index < this.queue.length; index += 1) {
        const item = this.queue[index]
        if (!this.canStart(item.context.projectId, item.context.threadId)) {
          continue
        }

        this.queue.splice(index, 1)
        void this.startItem(item)
        startedAny = true
        break
      }
    }
  }

  private canStart(projectId: string, threadId: string): boolean {
    if (this.activeGlobal >= this.globalLimit) {
      return false
    }

    if (this.activeByThread.has(threadId)) {
      return false
    }

    const activeProject = this.activeByProject.get(projectId) ?? 0
    return activeProject < this.perProjectLimit
  }

  private async startItem<TResult>(item: QueueItem<TResult>): Promise<void> {
    const { runId, projectId, threadId } = item.context
    const record = this.runs.get(runId)
    if (!record) {
      item.reject(new Error(`Run disappeared before start: ${runId}`))
      return
    }

    if (item.controller.signal.aborted) {
      const reason = this.getCancelReason(item.controller.signal.reason, 'Cancelled before start')
      record.status = 'cancelled'
      record.cancelReason = reason
      record.error = undefined
      record.failureKind = undefined
      record.finishedAt = nowIso()
      this.emit(record)
      item.reject(new RunCancelledError(reason))
      return
    }

    this.activeGlobal += 1
    this.activeByThread.add(threadId)
    this.activeByProject.set(projectId, (this.activeByProject.get(projectId) ?? 0) + 1)
    this.activeRuns.set(runId, item)

    record.status = 'running'
    record.startedAt = nowIso()
    this.emit(record)

    try {
      const result = await item.execute(item.controller.signal)

      if (item.controller.signal.aborted) {
        record.status = 'cancelled'
        record.cancelReason = this.getCancelReason(
          item.controller.signal.reason,
          'Cancelled while running',
        )
        record.error = undefined
        record.failureKind = undefined
        record.finishedAt = nowIso()
        this.emit(record)
        item.reject(new RunCancelledError(record.cancelReason))
      } else {
        record.result = result
        const classification = item.options?.classifyResult?.(result)
        record.status = classification?.status ?? 'completed'
        record.error = classification?.error
        record.failureKind = classification?.failureKind
        record.finishedAt = nowIso()
        this.emit(record)
        item.resolve(result)
      }
    } catch (error) {
      if (item.controller.signal.aborted) {
        record.status = 'cancelled'
        record.cancelReason = this.getCancelReason(
          item.controller.signal.reason,
          'Cancelled while running',
        )
        record.error = undefined
        record.failureKind = undefined
      } else {
        record.status = 'failed'
        record.error = error instanceof Error ? error.message : String(error)
      }
      record.finishedAt = nowIso()
      this.emit(record)
      item.reject(
        item.controller.signal.aborted
          ? new RunCancelledError(record.cancelReason)
          : error,
      )
    } finally {
      this.activeRuns.delete(runId)
      this.activeGlobal -= 1
      this.activeByThread.delete(threadId)
      const activeProject = (this.activeByProject.get(projectId) ?? 1) - 1
      if (activeProject <= 0) {
        this.activeByProject.delete(projectId)
      } else {
        this.activeByProject.set(projectId, activeProject)
      }
      this.drainQueue()
    }
  }

  private emit(record: RunRecord): void {
    this.onStatusChange?.(cloneRecord(record))
  }

  private getCancelReason(reason: unknown, fallback: string): string {
    return typeof reason === 'string' && reason.trim() ? reason : fallback
  }
}
