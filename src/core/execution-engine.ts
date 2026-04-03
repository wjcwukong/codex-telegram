import { spawn, type ChildProcess } from 'node:child_process'
import { readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { RunScheduler, RunCancelledError } from '../../run-scheduler.js'
import type {
  RunFailureKind,
  RunRecord,
  RunStatus,
  ScheduledRunHandle,
} from '../../run-scheduler.js'
import { StateStore } from '../../state-store.js'
import { AgentManager } from '../../agent-manager.js'
import type { AgentSnapshot, AgentUpdateEvent } from '../../agent-manager.js'
import { HistoryReader } from '../../history-reader.js'
import { getWritebackDecision } from '../../storage-policy.js'
import type {
  AgentRecord,
  ProjectRecord,
  SourceRecord,
  ThreadRecord,
} from '../../models.js'
import type { AppServerClient } from './app-server-client.js'

// ─── Constants ──────────────────────────────────────────────────────

const BOT_TMP_DIR = join(homedir(), '.codex-telegram', 'tmp')

const SPAWN_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
const APPROVAL_POLL_INTERVAL_MS = 500

const ANSI_PATTERN =
  /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|\u009B[0-?]*[ -/]*[@-~]/g

const PATH_WARNING_PREFIX =
  'WARNING: proceeding, even though we could not update PATH:'

// ─── Interfaces ─────────────────────────────────────────────────────

export interface ThreadRunResult {
  cancelled: boolean
  exitCode: number
  assistantMessage?: string
  cliMessage?: string
  error?: string
  failureKind?: RunFailureKind
}

interface EscalationRequest {
  toolName?: string
  command?: string
  justification?: string
}

export interface CancelResult {
  hadThread: boolean
  killedRunning: boolean
  clearedQueued: boolean
  thread?: ThreadRecord
}

export interface StoredRunReplayOptions {
  outputPrefix?: string
  suppressOutput?: boolean
  agentId?: string
  retryOfRunId?: string
}

export interface StoredRunReplay {
  threadId: string
  userId: string
  chatId: string
  text: string
  options: StoredRunReplayOptions
}

export interface ExecutionCallbacks {
  onOutput(userId: string, chatId: string, text: string): void | Promise<void>
  onStreamDelta?(userId: string, chatId: string, delta: string, meta: { turnId: string; threadId: string }): void
  onRunComplete?(runId: string, threadId: string): void
  onBotPrompt?(codexThreadId: string, turnId: string, promptText: string): void
}

// ─── Helpers ────────────────────────────────────────────────────────

function normalizeOutput(text: string): string {
  return text
    .replace(ANSI_PATTERN, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
}

function getDatePath(date: Date): string[] {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return [year, month, day]
}

function extractThreadId(rolloutPath: string): string | undefined {
  const match = rolloutPath.match(/-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i)
  return match?.[1]
}

// ─── ExecutionEngine ────────────────────────────────────────────────

export class ExecutionEngine {
  private readonly threadRunIds = new Map<string, Set<string>>()
  private readonly runningProcs = new Map<string, ChildProcess>()
  private readonly runReplay = new Map<string, StoredRunReplay>()
  private readonly writebackRunAgentIds = new Map<string, string>()
  private readonly autoWritebackAppliedAgents = new Set<string>()
  /** Turn IDs initiated by this bot (used to distinguish external turns). */
  readonly botTurnIds = new Set<string>()

  constructor(
    private readonly stateStore: StateStore,
    private readonly scheduler: RunScheduler,
    private readonly agentManager: AgentManager,
    private readonly historyReader: HistoryReader,
    private readonly callbacks: ExecutionCallbacks,
    private readonly appServer?: AppServerClient,
  ) {}

  // ── Public API ──────────────────────────────────────────────────

  async enqueueThreadRun(
    threadId: string,
    userId: string,
    chatId: string,
    text: string,
    options: StoredRunReplayOptions = {},
  ): Promise<ThreadRunResult> {
    const handle = this.startThreadRun(threadId, userId, chatId, text, options)

    try {
      const result = await handle.promise
      return result
    } catch (error) {
      if (error instanceof RunCancelledError) {
        return {
          cancelled: true,
          exitCode: 0,
          error: error.message,
        }
      }

      throw error
    } finally {
      this.detachRunFromThread(threadId, handle.runId)
    }
  }

  async cancelThreadExecution(threadId: string): Promise<CancelResult> {
    const thread = this.stateStore.getThread(threadId)
    if (!thread) {
      return {
        hadThread: false,
        killedRunning: false,
        clearedQueued: false,
      }
    }

    const runs = this.scheduler.listRuns({ threadId: thread.id })
    let killedRunning = false
    let clearedQueued = false

    for (const run of runs) {
      if (run.status === 'running') {
        killedRunning =
          this.scheduler.cancel(run.context.runId, 'Cancelled by user') ||
          killedRunning
      } else if (run.status === 'queued') {
        clearedQueued =
          this.scheduler.cancel(run.context.runId, 'Cancelled by user') ||
          clearedQueued
      }
    }

    // If app-server is connected and thread has a server-side thread, interrupt running turns
    if (this.appServer?.connected && thread.codexThreadId) {
      try {
        const serverThread = await this.appServer.threadRead(thread.codexThreadId, true)
        // The thread object may contain turn info; fire a best-effort interrupt
        if (serverThread) {
          // Interrupt is best-effort; the scheduler cancel above handles the primary abort
        }
      } catch {
        // Best-effort — ignore errors
      }
    }

    await this.stateStore.updateThread(thread.id, {
      status: killedRunning || clearedQueued ? 'cancelled' : 'idle',
      updatedAt: new Date().toISOString(),
    })

    return {
      hadThread: true,
      killedRunning,
      clearedQueued,
      thread,
    }
  }

  killAll(): void {
    for (const run of this.scheduler.listRuns()) {
      this.scheduler.cancel(run.context.runId, 'SessionManager shutdown')
    }

    for (const proc of this.runningProcs.values()) {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill()
      }
    }

    this.runningProcs.clear()
    this.threadRunIds.clear()
  }

  getRunReplay(runId: string): StoredRunReplay | undefined {
    return this.runReplay.get(runId)
  }

  getBlockingRun(threadId: string): RunRecord | undefined {
    const runs = this.scheduler.listRuns({ threadId })
    return (
      runs.find((run) => run.status === 'running') ??
      runs.find((run) => run.status === 'queued')
    )
  }

  /** Used by SessionManager.retryRun and applyAgentWriteback */
  startThreadRun(
    threadId: string,
    userId: string,
    chatId: string,
    text: string,
    options: StoredRunReplayOptions = {},
  ): ScheduledRunHandle<ThreadRunResult> {
    const thread = this.stateStore.getThread(threadId)
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`)
    }

    const runId = `run_${threadId}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
    const handle = this.scheduler.schedule<ThreadRunResult>(
      {
        runId,
        projectId: thread.projectId,
        threadId,
        agentId: options.agentId,
      },
      async (signal) =>
        this.runPrompt(runId, threadId, userId, chatId, text, options, signal),
      {
        label: options.outputPrefix ?? thread.title,
        classifyResult: (result) => {
          if (result.cancelled) {
            return { status: 'completed' }
          }
          if (result.exitCode === 0) {
            return { status: 'completed' }
          }
          return {
            status: 'failed',
            error:
              result.error ??
              result.cliMessage ??
              `Codex failed with exit code ${result.exitCode}.`,
            failureKind: result.failureKind ?? 'failed',
          }
        },
      },
    )

    this.runReplay.set(runId, {
      threadId,
      userId,
      chatId,
      text,
      options: {
        outputPrefix: options.outputPrefix,
        suppressOutput: options.suppressOutput,
        agentId: options.agentId,
        retryOfRunId: options.retryOfRunId,
      },
    })
    this.scheduler.updateRun(runId, {
      retryable: true,
      retryOfRunId: options.retryOfRunId,
    })
    this.attachRunToThread(threadId, runId)

    return handle
  }

  trackWritebackRun(runId: string, agentId: string): void {
    this.writebackRunAgentIds.set(runId, agentId)
  }

  // ── Scheduler / Agent callbacks ─────────────────────────────────

  async handleRunStatusChange(record: RunRecord): Promise<void> {
    const thread = this.stateStore.getThread(record.context.threadId)
    if (!thread) {
      return
    }

    const nextStatus = this.mapRunStatusToThreadStatus(record.status)
    if (thread.status !== nextStatus) {
      await this.stateStore.updateThread(thread.id, {
        status: nextStatus,
      })
    }

    if (record.context.agentId) {
      const agent = this.stateStore.getAgent(record.context.agentId)
      if (agent) {
        await this.stateStore.updateAgent(agent.id, {
          status: this.mapRunStatusToAgentStatus(record.status),
          lastError:
            record.status === 'failed' &&
            record.failureKind === 'waiting_approval'
              ? `waiting_approval: ${record.error ?? 'Approval required'}`
              : record.error,
        })
      }
    }

    const writebackAgentId = this.writebackRunAgentIds.get(record.context.runId)
    if (
      writebackAgentId &&
      (record.status === 'completed' ||
        record.status === 'failed' ||
        record.status === 'cancelled')
    ) {
      const agent = this.stateStore.getAgent(writebackAgentId)
      if (agent?.writebackRunId === record.context.runId) {
        await this.stateStore.updateAgent(agent.id, {
          writebackRunId: undefined,
        })
      }
      this.writebackRunAgentIds.delete(record.context.runId)
    }
  }

  async handleAgentUpdate(
    snapshot: AgentSnapshot,
    event: AgentUpdateEvent,
  ): Promise<void> {
    if (event.type !== 'completed') {
      return
    }

    const project = this.stateStore.getProject(snapshot.agent.projectId)
    if (!project?.agentAutoWritebackEnabled) {
      return
    }

    if (this.autoWritebackAppliedAgents.has(snapshot.agent.id)) {
      return
    }

    const latestAgent = this.stateStore.getAgent(snapshot.agent.id)
    if (!latestAgent || latestAgent.writebackRunId) {
      return
    }

    const decision = this.agentManager.getAutoWritebackDecision(snapshot.agent.id)
    if (!decision.eligible) {
      return
    }

    this.autoWritebackAppliedAgents.add(snapshot.agent.id)
    try {
      const runtime = this.agentManager.getRuntimeContext(snapshot.agent.id)
      const userId = runtime?.userId
      const chatId = runtime?.chatId
      if (!userId || !chatId) {
        return
      }

      await this.autoApplyWriteback(userId, chatId, snapshot)
    } finally {
      this.autoWritebackAppliedAgents.delete(snapshot.agent.id)
    }
  }

  // ── Private: runPrompt (broken into sub-methods) ────────────────

  private async runPrompt(
    runId: string,
    threadLocalId: string,
    userId: string,
    chatId: string,
    text: string,
    options: StoredRunReplayOptions = {},
    signal?: AbortSignal,
  ): Promise<ThreadRunResult> {
    // If app-server is connected, use the WebSocket path
    if (this.appServer?.connected) {
      return this.runPromptViaAppServer(runId, threadLocalId, userId, chatId, text, options, signal)
    }

    // Fallback: spawn-based execution
    const thread = this.stateStore.getThread(threadLocalId)
    if (!thread) {
      throw new Error(`Thread not found: ${threadLocalId}`)
    }

    const source = this.getRequiredSource(thread.sourceId)
    const blocked = this.checkWritebackPolicy(runId, thread, source)
    if (blocked) {
      if (!options.suppressOutput) {
        await this.callbacks.onOutput(userId, chatId,
          `❌ 无法执行: ${blocked.error || '存储策略限制'}`)
      }
      return blocked
    }

    const normalizedText = text.trim()
    if (!normalizedText) {
      return { cancelled: false, exitCode: 0 }
    }

    await this.stateStore.updateThread(thread.id, {
      status: 'running',
      updatedAt: new Date().toISOString(),
    })

    const outputPath = this.buildOutputPath()
    const rolloutSnapshot = thread.codexThreadId
      ? undefined
      : await this.listTodayRollouts(source.codexHome, new Date())
    const args = this.buildCodexArgs(thread, normalizedText, outputPath)
    const proc = this.spawnCodexProcess(args, thread.cwd, source.codexHome)

    this.runningProcs.set(thread.id, proc)
    signal?.addEventListener(
      'abort',
      () => {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill()
        }
      },
      { once: true },
    )

    const result = await this.collectProcessOutput(proc)

    if (this.runningProcs.get(thread.id) === proc) {
      this.runningProcs.delete(thread.id)
    }

    return this.classifyRunResult(
      runId,
      thread,
      userId,
      chatId,
      result,
      outputPath,
      rolloutSnapshot,
      source,
      options,
    )
  }

  // ── Private: app-server execution path ───────────────────────────

  private async runPromptViaAppServer(
    runId: string,
    threadLocalId: string,
    userId: string,
    chatId: string,
    text: string,
    options: StoredRunReplayOptions,
    signal?: AbortSignal,
  ): Promise<ThreadRunResult> {
    const thread = this.stateStore.getThread(threadLocalId)
    if (!thread) throw new Error(`Thread not found: ${threadLocalId}`)

    const source = this.getRequiredSource(thread.sourceId)
    const blocked = this.checkWritebackPolicy(runId, thread, source)
    if (blocked) {
      if (!options.suppressOutput) {
        await this.callbacks.onOutput(userId, chatId,
          `❌ 无法执行: ${blocked.error || '存储策略限制'}`)
      }
      return blocked
    }

    const normalizedText = text.trim()
    if (!normalizedText) return { cancelled: false, exitCode: 0 }

    await this.stateStore.updateThread(thread.id, {
      status: 'running',
      updatedAt: new Date().toISOString(),
    })

    // Step 1: Ensure we have a codex server thread ID
    let serverThreadId = thread.codexThreadId
    if (!serverThreadId) {
      const codexThread = await this.appServer!.threadStart({
        cwd: thread.cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      })
      serverThreadId = codexThread.id
      await this.stateStore.updateThread(thread.id, {
        codexThreadId: serverThreadId,
        updatedAt: new Date().toISOString(),
      })
    } else {
      // Try to resume; if the rollout is gone, create a fresh server thread
      try {
        await this.appServer!.threadResume(serverThreadId)
      } catch {
        const codexThread = await this.appServer!.threadStart({
          cwd: thread.cwd,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
        })
        serverThreadId = codexThread.id
        await this.stateStore.updateThread(thread.id, {
          codexThreadId: serverThreadId,
          updatedAt: new Date().toISOString(),
        })
      }
    }

    // Step 2: Start turn and collect response
    let fullResponse = ''
    let turnCompleted = false
    let turnError: string | undefined
    let turnFailureKind: RunFailureKind | undefined

    const deltaHandler = (event: { threadId: string; turnId: string; itemId: string; delta: string }) => {
      if (event.threadId === serverThreadId) {
        fullResponse += event.delta
        if (this.callbacks.onStreamDelta && !options.suppressOutput) {
          this.callbacks.onStreamDelta(userId, chatId, event.delta, {
            turnId: event.turnId,
            threadId: threadLocalId,
          })
        }
      }
    }

    let completionHandler: ((event: { threadId: string; turn: { id: string; status: string } }) => void) | undefined

    const completionPromise = new Promise<void>((resolve, reject) => {
      completionHandler = (event: { threadId: string; turn: { id: string; status: string } }) => {
        if (event.threadId === serverThreadId) {
          turnCompleted = true
          if (event.turn.status === 'errored') {
            turnError = 'Turn errored'
          }
          this.appServer!.offTurnCompleted(completionHandler!)
          resolve()
        }
      }
      this.appServer!.onTurnCompleted(completionHandler)
    })

    this.appServer!.onAgentDelta(deltaHandler)

    // Step 3: Start the turn
    const turn = await this.appServer!.turnStart(serverThreadId, normalizedText)
    this.botTurnIds.add(turn.id)
    this.callbacks.onBotPrompt?.(serverThreadId!, turn.id, normalizedText)

    // Set up abort handling
    signal?.addEventListener('abort', () => {
      this.appServer!.turnInterrupt(serverThreadId!, turn.id).catch(() => {})
    }, { once: true })

    // Step 4: Wait for completion, approval stalls, or timeout.
    const TURN_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<{ kind: 'timeout' }>((resolve) => {
      timeoutId = setTimeout(() => resolve({ kind: 'timeout' }), TURN_TIMEOUT_MS)
    })

    // Primary escalation detection: item:started events via WebSocket
    const approvalPromise = this.waitForEscalationViaItems(
      serverThreadId,
      source.codexHome,
    )

    const outcome = await Promise.race([
      completionPromise.then(() => ({ kind: 'completed' as const })),
      timeoutPromise,
      approvalPromise,
    ])

    // Clean up event-based escalation listener
    approvalPromise.cleanup?.()
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
    this.appServer!.offAgentDelta(deltaHandler)

    if (outcome.kind !== 'completed' && completionHandler) {
      this.appServer!.offTurnCompleted(completionHandler)
    }

    if (outcome.kind === 'approval') {
      // With full-auth flags (approvalPolicy: "never", sandbox: "danger-full-access"),
      // escalations should not happen. If one still triggers, log and inform user.
      console.warn(`[execution-engine] unexpected escalation with full-auth: thread=${serverThreadId.slice(0, 12)}…, cmd=${outcome.request.command ?? '(unknown)'}`)
      turnFailureKind = 'waiting_approval'
      turnError = `⚠️ 命令需要额外权限但已启用完全授权模式。\n命令: ${outcome.request.command || '(unknown)'}\n请在本地 Codex 终端中执行此命令。`
      this.patchRunRecord(runId, { failureKind: 'waiting_approval' })
      await this.appServer!.turnInterrupt(serverThreadId!, turn.id).catch(() => {})
    } else if (outcome.kind === 'timeout') {
      console.log(`[execution-engine] turn timed out for thread ${serverThreadId.slice(0, 12)}…`)
      turnError = 'Turn execution timed out after 10 minutes'
    } else {
      console.log(`[execution-engine] turn completed for thread ${serverThreadId.slice(0, 12)}…`)
    }

    // Step 5: Update thread and return result
    // NOTE: Keep turn.id in botTurnIds until AFTER output is delivered,
    // so the external turn forwarding code (server.ts) doesn't duplicate it.
    const assistantMessage = fullResponse.trim()

    if (turnError) {
      await this.stateStore.updateThread(thread.id, {
        status: 'failed',
        updatedAt: new Date().toISOString(),
      })
      const errorOutput = assistantMessage
        ? `${assistantMessage}\n\n⚠️ ${turnError}`
        : `⚠️ ${turnError}`
      if (!options.suppressOutput && errorOutput) {
        await this.callbacks.onOutput(userId, chatId,
          options.outputPrefix ? `${options.outputPrefix}\n${errorOutput}` : errorOutput)
      }
      this.botTurnIds.delete(turn.id)
      this.callbacks.onRunComplete?.(runId, threadLocalId)
      return {
        cancelled: false,
        exitCode: 1,
        error: turnError,
        cliMessage: assistantMessage,
        failureKind: turnFailureKind,
      }
    }

    await this.stateStore.updateThread(thread.id, {
      status: 'idle',
      updatedAt: new Date().toISOString(),
    })

    // The onStreamDelta callback already delivered content progressively.
    // onOutput finalizes the stream message (edits it to the final text).
    // If no stream was started (e.g. empty response), it sends a new message.
    if (!options.suppressOutput) {
      const successOutput = assistantMessage || '✅ 完成'
      await this.callbacks.onOutput(userId, chatId,
        options.outputPrefix ? `${options.outputPrefix}\n${successOutput}` : successOutput)
    }

    this.botTurnIds.delete(turn.id)
    this.callbacks.onRunComplete?.(runId, threadLocalId)
    return { cancelled: false, exitCode: 0, assistantMessage }
  }

  // ── Private: sub-methods of runPrompt ───────────────────────────

  private checkWritebackPolicy(
    runId: string,
    thread: ThreadRecord,
    source: SourceRecord,
  ): ThreadRunResult | undefined {
    const writebackDecision = getWritebackDecision(thread, source)
    if (!writebackDecision.allowed) {
      this.patchRunRecord(runId, { failureKind: 'waiting_approval' })
      return {
        cancelled: false,
        exitCode: 1,
        cliMessage: `Storage policy blocked run: ${writebackDecision.reason}`,
        error: writebackDecision.reason,
        failureKind: 'waiting_approval',
      }
    }
    return undefined
  }

  private buildOutputPath(): string {
    return join(
      BOT_TMP_DIR,
      `codex-output-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
    )
  }

  private buildCodexArgs(
    thread: ThreadRecord,
    normalizedText: string,
    outputPath: string,
  ): string[] {
    return thread.codexThreadId
      ? [
          'exec',
          'resume',
          '--skip-git-repo-check',
          '-o',
          outputPath,
          thread.codexThreadId,
          normalizedText,
        ]
      : ['exec', '--skip-git-repo-check', '-o', outputPath, normalizedText]
  }

  private spawnCodexProcess(
    args: string[],
    cwd: string,
    codexHome: string,
  ): ChildProcess {
    return spawn('codex', args, {
      cwd,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  private async collectProcessOutput(
    proc: ChildProcess,
  ): Promise<{ exitCode: number; output: string }> {
    let output = ''

    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')

    proc.stdout?.on('data', (chunk: string | Buffer) => {
      output += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })

    proc.stderr?.on('data', (chunk: string | Buffer) => {
      output += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })

    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        proc.kill('SIGTERM')
        reject(new Error('Codex process timed out after 10 minutes'))
      }, SPAWN_TIMEOUT_MS)
      
      // Clear timeout on normal process completion
      proc.once('close', () => clearTimeout(timer))
    })

    return await Promise.race([
      new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
        proc.once('error', reject)
        proc.once('close', (code) => {
          resolve({ exitCode: code ?? 1, output })
        })
      }),
      timeoutPromise,
    ])
  }

  private async classifyRunResult(
    runId: string,
    thread: ThreadRecord,
    userId: string,
    chatId: string,
    result: { exitCode: number; output: string },
    outputPath: string,
    rolloutSnapshot: Set<string> | undefined,
    source: SourceRecord,
    options: StoredRunReplayOptions,
  ): Promise<ThreadRunResult> {
    let activeThread = this.stateStore.getThread(thread.id)
    if (!activeThread) {
      await unlink(outputPath).catch(() => {})
      return { cancelled: true, exitCode: result.exitCode }
    }

    activeThread = await this.detectAndLinkNewThread(
      activeThread,
      result.exitCode,
      rolloutSnapshot,
      source,
    )

    const assistantMessage = await this.readOutputMessage(outputPath)
    await unlink(outputPath).catch(() => {})

    if (assistantMessage) {
      return this.handleAssistantOutput(
        activeThread,
        userId,
        chatId,
        assistantMessage,
        options,
      )
    }

    const cliMessage = this.cleanCliDiagnostics(result.output)
    if (cliMessage) {
      return this.handleCliOutput(
        runId,
        activeThread,
        userId,
        chatId,
        result.exitCode,
        cliMessage,
        options,
      )
    }

    return this.handleFallbackResult(
      runId,
      activeThread,
      userId,
      chatId,
      result.exitCode,
      options,
    )
  }

  private async detectAndLinkNewThread(
    thread: ThreadRecord,
    exitCode: number,
    rolloutSnapshot: Set<string> | undefined,
    source: SourceRecord,
  ): Promise<ThreadRecord> {
    if (!thread.codexThreadId && exitCode === 0 && rolloutSnapshot) {
      const codexThreadId = await this.detectNewThreadId(
        source.codexHome,
        rolloutSnapshot,
        new Date(),
      )
      if (codexThreadId) {
        return await this.stateStore.updateThread(thread.id, {
          codexThreadId,
          updatedAt: new Date().toISOString(),
        })
      }
    }
    return thread
  }

  private async handleAssistantOutput(
    thread: ThreadRecord,
    userId: string,
    chatId: string,
    assistantMessage: string,
    options: StoredRunReplayOptions,
  ): Promise<ThreadRunResult> {
    await this.stateStore.updateThread(thread.id, {
      status: 'idle',
      updatedAt: new Date().toISOString(),
    })
    if (!options.suppressOutput) {
      this.callbacks.onOutput(
        userId,
        chatId,
        options.outputPrefix
          ? `${options.outputPrefix}\n${assistantMessage}`
          : assistantMessage,
      )
    }
    return { cancelled: false, exitCode: 0, assistantMessage }
  }

  private async handleCliOutput(
    runId: string,
    thread: ThreadRecord,
    userId: string,
    chatId: string,
    exitCode: number,
    cliMessage: string,
    options: StoredRunReplayOptions,
  ): Promise<ThreadRunResult> {
    const failureKind =
      exitCode === 0 ? undefined : this.detectRunFailureKind(cliMessage)
    this.patchRunRecord(runId, { failureKind })
    await this.stateStore.updateThread(thread.id, {
      status: exitCode === 0 ? 'idle' : 'failed',
      updatedAt: new Date().toISOString(),
    })
    if (!options.suppressOutput) {
      const text =
        exitCode === 0 ? cliMessage : `Codex failed:\n${cliMessage}`
      this.callbacks.onOutput(
        userId,
        chatId,
        options.outputPrefix ? `${options.outputPrefix}\n${text}` : text,
      )
    }
    return { cancelled: false, exitCode, cliMessage, failureKind }
  }

  private async handleFallbackResult(
    runId: string,
    thread: ThreadRecord,
    userId: string,
    chatId: string,
    exitCode: number,
    options: StoredRunReplayOptions,
  ): Promise<ThreadRunResult> {
    await this.stateStore.updateThread(thread.id, {
      status: exitCode === 0 ? 'idle' : 'failed',
      updatedAt: new Date().toISOString(),
    })

    if (exitCode !== 0) {
      this.patchRunRecord(runId, { failureKind: 'failed' })
      const fallback = `Codex failed with exit code ${exitCode}.`
      if (!options.suppressOutput) {
        this.callbacks.onOutput(
          userId,
          chatId,
          options.outputPrefix
            ? `${options.outputPrefix}\n${fallback}`
            : fallback,
        )
      }
      return {
        cancelled: false,
        exitCode,
        cliMessage: fallback,
        failureKind: 'failed',
      }
    }

    if (!options.suppressOutput) {
      const successOutput = options.outputPrefix
        ? `${options.outputPrefix}\n✅ 完成`
        : '✅ 完成'
      this.callbacks.onOutput(userId, chatId, successOutput)
    }

    return { cancelled: false, exitCode }
  }

  // ── Private: auto-writeback ─────────────────────────────────────

  private async autoApplyWriteback(
    userId: string,
    chatId: string,
    snapshot: AgentSnapshot,
  ): Promise<void> {
    const payload = this.agentManager.prepareWriteback(snapshot.agent.id)
    if (payload?.mode !== 'apply_result' || !payload.available) {
      return
    }

    const parentThread = this.stateStore.getThread(
      snapshot.relation.parentThreadId,
    )
    if (!parentThread) {
      return
    }

    const prompt = await this.buildAgentWritebackPrompt(snapshot)
    if (!prompt) {
      return
    }

    const handle = this.startThreadRun(parentThread.id, userId, chatId, prompt, {
      outputPrefix: `[agent ${snapshot.agent.id} writeback]`,
    })

    const run = this.scheduler.getRun(handle.runId)
    if (!run) {
      return
    }

    await this.stateStore.updateAgent(snapshot.agent.id, {
      writebackRunId: run.context.runId,
    })
    this.writebackRunAgentIds.set(run.context.runId, snapshot.agent.id)
  }

  // ── Private: helpers ────────────────────────────────────────────

  private getRequiredSource(sourceId: string): SourceRecord {
    const source = this.stateStore.getSource(sourceId)
    if (!source) {
      throw new Error(`Source not found: ${sourceId}`)
    }
    return source
  }

  private attachRunToThread(threadId: string, runId: string): void {
    const runIds = this.threadRunIds.get(threadId) ?? new Set<string>()
    runIds.add(runId)
    this.threadRunIds.set(threadId, runIds)
  }

  private detachRunFromThread(threadId: string, runId: string): void {
    const runIds = this.threadRunIds.get(threadId)
    if (!runIds) {
      return
    }
    runIds.delete(runId)
    if (runIds.size === 0) {
      this.threadRunIds.delete(threadId)
    }
  }

  private mapRunStatusToThreadStatus(
    status: RunStatus,
  ): ThreadRecord['status'] {
    switch (status) {
      case 'queued':
        return 'queued'
      case 'running':
        return 'running'
      case 'cancelled':
        return 'cancelled'
      case 'failed':
        return 'failed'
      case 'completed':
      default:
        return 'idle'
    }
  }

  private mapRunStatusToAgentStatus(
    status: RunStatus,
  ): AgentRecord['status'] {
    switch (status) {
      case 'queued':
        return 'queued'
      case 'running':
        return 'running'
      case 'cancelled':
        return 'cancelled'
      case 'failed':
        return 'failed'
      case 'completed':
      default:
        return 'completed'
    }
  }

  private patchRunRecord(
    runId: string | undefined,
    patch: Partial<Pick<RunRecord, 'failureKind' | 'retryable' | 'retryOfRunId'>>,
  ): void {
    if (!runId) {
      return
    }
    this.scheduler.updateRun(runId, patch)
  }

  private detectRunFailureKind(message: string): RunFailureKind {
    const normalized = message.toLowerCase()
    if (
      normalized.includes('approval') ||
      normalized.includes('approve') ||
      normalized.includes('permission') ||
      normalized.includes('sandbox policy') ||
      normalized.includes('storage policy blocked')
    ) {
      return 'waiting_approval'
    }
    return 'failed'
  }

  private async readOutputMessage(outputPath: string): Promise<string> {
    try {
      const raw = await readFile(outputPath, 'utf8')
      return raw.trim()
    } catch {
      return ''
    }
  }

  private cleanCliDiagnostics(output: string): string {
    return normalizeOutput(output)
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(
        (line) => line.length > 0 && !line.startsWith(PATH_WARNING_PREFIX),
      )
      .join('\n')
  }

  private async listTodayRollouts(
    codexHome: string,
    date: Date,
  ): Promise<Set<string>> {
    const rolloutDir = join(codexHome, 'sessions', ...getDatePath(date))
    try {
      const entries = await readdir(rolloutDir)
      return new Set(
        entries
          .filter((entry) => entry.endsWith('.jsonl'))
          .map((entry) => join(rolloutDir, entry)),
      )
    } catch {
      return new Set()
    }
  }

  private async findThreadRolloutPath(
    codexHome: string,
    threadId: string,
  ): Promise<string | undefined> {
    // Search recent date directories (today → 30 days back) to find rollout
    // for threads that may have been created on previous days.
    const sessionsDir = join(codexHome, 'sessions')
    try {
      const years = await readdir(sessionsDir)
      const candidates: string[] = []
      for (const y of years.sort().reverse()) {
        const yDir = join(sessionsDir, y)
        let months: string[]
        try { months = await readdir(yDir) } catch { continue }
        for (const m of months.sort().reverse()) {
          const mDir = join(yDir, m)
          let days: string[]
          try { days = await readdir(mDir) } catch { continue }
          for (const d of days.sort().reverse()) {
            const dDir = join(mDir, d)
            let entries: string[]
            try { entries = await readdir(dDir) } catch { continue }
            const match = entries.find((e) => e.endsWith('.jsonl') && e.includes(threadId))
            if (match) return join(dDir, match)
            candidates.push(dDir)
          }
          if (candidates.length > 60) return undefined // safety limit
        }
      }
    } catch {
      // sessions dir doesn't exist
    }
    return undefined
  }

  /**
   * Dual-source escalation detection: listen to app-server item:started events
   * AND poll the rollout file as a fallback. Returns a cancellable promise.
   *
   * The item:started event fires immediately via WebSocket when the model
   * outputs a function_call — no filesystem I/O, no date-directory issues.
   * The rollout fallback covers edge cases where item:started might be missed.
   */
  private waitForEscalationViaItems(
    serverThreadId: string,
    codexHome: string,
  ): Promise<{ kind: 'approval'; request: EscalationRequest }> & { cleanup?: () => void } {
    let itemHandler: ((event: { threadId: string; turnId: string; item: { id: string; type: string; content?: unknown } }) => void) | undefined
    let rolloutAbort: AbortController | undefined
    let resolved = false

    const promise = new Promise<{ kind: 'approval'; request: EscalationRequest }>((resolve) => {
      // ── Primary: item:started event from WebSocket ──
      if (this.appServer) {
        itemHandler = (event) => {
          if (resolved || event.threadId !== serverThreadId) return
          const esc = this.parseItemEscalation(event.item)
          if (esc) {
            resolved = true
            console.log(`[escalation] detected via item:started event: ${esc.command}`)
            resolve({ kind: 'approval', request: esc })
          }
        }
        this.appServer.onItemStarted(itemHandler)
      }

      // ── Secondary: rollout file polling (cross-date search) ──
      rolloutAbort = new AbortController()
      void (async () => {
        // Small delay to let the turn start and potentially create a rollout file
        await new Promise((r) => setTimeout(r, 1000))
        if (resolved || rolloutAbort!.signal.aborted) return

        const rolloutPath = await this.findThreadRolloutPath(codexHome, serverThreadId)
        if (!rolloutPath) {
          console.log(`[escalation] no rollout file found for thread ${serverThreadId.slice(0, 12)}…, relying on item:started events only`)
          return
        }
        const offset = await this.getFileSize(rolloutPath)
        console.log(`[escalation] rollout fallback watching: ${rolloutPath} (offset=${offset})`)

        let cursor = offset
        let remainder = ''
        while (!rolloutAbort!.signal.aborted && !resolved) {
          try {
            const raw = await readFile(rolloutPath, 'utf8')
            const chunk = raw.slice(cursor)
            cursor = raw.length
            if (chunk) {
              const parts = (remainder + chunk).split('\n')
              remainder = parts.pop() ?? ''
              for (const line of parts) {
                const req = this.parseRolloutEscalation(line)
                if (req) {
                  resolved = true
                  console.log(`[escalation] detected via rollout polling: ${req.command}`)
                  resolve({ kind: 'approval', request: req })
                  return
                }
              }
            }
          } catch {
            // Ignore transient read issues
          }
          await new Promise((r) => setTimeout(r, APPROVAL_POLL_INTERVAL_MS))
        }
      })()
    }) as Promise<{ kind: 'approval'; request: EscalationRequest }> & { cleanup?: () => void }

    promise.cleanup = () => {
      if (itemHandler && this.appServer) {
        this.appServer.off('item:started', itemHandler)
      }
      rolloutAbort?.abort()
    }

    return promise
  }

  /**
   * Parse an item:started event for escalation markers.
   * The item may be a function_call / shellCommand / exec_command type.
   */
  private parseItemEscalation(item: { id: string; type: string; content?: unknown }): EscalationRequest | undefined {
    try {
      // The item content structure varies; try multiple extraction paths
      const content = item.content as Record<string, unknown> | undefined
      if (!content) return undefined

      // Path 1: content has arguments as a JSON string (like rollout format)
      if (typeof content.arguments === 'string') {
        try {
          const args = JSON.parse(content.arguments) as Record<string, unknown>
          if (args.sandbox_permissions === 'require_escalated') {
            return {
              toolName: (content.name as string) ?? item.type,
              command: args.cmd as string | undefined,
              justification: args.justification as string | undefined,
            }
          }
        } catch { /* not JSON */ }
      }

      // Path 2: content has sandbox_permissions directly
      if (content.sandbox_permissions === 'require_escalated') {
        return {
          toolName: (content.name as string) ?? item.type,
          command: content.cmd as string | undefined,
          justification: content.justification as string | undefined,
        }
      }

      // Path 3: content.command or content.args contain escalation hint
      if (typeof content.command === 'object' && content.command !== null) {
        const cmd = content.command as Record<string, unknown>
        if (cmd.sandbox_permissions === 'require_escalated') {
          return {
            toolName: item.type,
            command: cmd.cmd as string | undefined,
            justification: cmd.justification as string | undefined,
          }
        }
      }
    } catch {
      // Unexpected shape — ignore
    }
    return undefined
  }

  private async getFileSize(path: string): Promise<number> {
    try {
      return (await stat(path)).size
    } catch {
      return 0
    }
  }

  /**
   * Parse a single rollout JSONL line for sandbox escalation.
   */
  private parseRolloutEscalation(line: string): EscalationRequest | undefined {
    if (!line.trim()) return undefined
    try {
      const record = JSON.parse(line) as {
        type?: string
        payload?: { type?: string; name?: string; arguments?: string }
      }
      if (record.type !== 'response_item' || record.payload?.type !== 'function_call') {
        return undefined
      }
      const argsText = record.payload.arguments
      if (typeof argsText !== 'string') return undefined
      const args = JSON.parse(argsText) as {
        sandbox_permissions?: string
        cmd?: string
        justification?: string
      }
      if (args.sandbox_permissions !== 'require_escalated') return undefined
      return {
        toolName: record.payload.name,
        command: args.cmd,
        justification: args.justification,
      }
    } catch {
      return undefined
    }
  }



  /**
   * Handle an escalation request interactively: forward to user via Telegram,
   * wait for their decision, write approval rule if approved, then signal retry.
   */


  private async detectNewThreadId(
    codexHome: string,
    before: Set<string>,
    date: Date,
  ): Promise<string | undefined> {
    const after = await this.listTodayRollouts(codexHome, date)
    const newFiles = [...after].filter((path) => !before.has(path))

    if (newFiles.length === 0) {
      return undefined
    }

    const withTimes = await Promise.all(
      newFiles.map(async (path) => ({
        path,
        mtimeMs: (await stat(path)).mtimeMs,
      })),
    )

    withTimes.sort((left, right) => right.mtimeMs - left.mtimeMs)
    return extractThreadId(withTimes[0]?.path ?? '')
  }

  private async buildAgentWritebackPrompt(
    snapshot: AgentSnapshot,
  ): Promise<string | undefined> {
    const childThread = this.stateStore.getThread(
      snapshot.relation.childThreadId,
    )
    if (!childThread) {
      return undefined
    }

    const childTurn = await this.historyReader.readLastThreadHistoryTurn(
      childThread,
      {
        includeTools: true,
        includeAgentMessages: true,
      },
    )
    const childResult = childTurn?.entries
      .filter((entry) => entry.role === 'assistant')
      .map((entry) => entry.text.trim())
      .filter(Boolean)
      .join('\n\n')
      .trim()

    if (!childResult) {
      return undefined
    }

    const parentLabel =
      snapshot.relation.parentThread?.title ?? snapshot.relation.parentThreadId
    const childLabel =
      snapshot.relation.childThread?.title ?? snapshot.relation.childThreadId

    return [
      `Continue the parent thread using the completed ${snapshot.agent.role} agent result.`,
      `Parent thread: ${parentLabel}`,
      `Child thread: ${childLabel} (${snapshot.relation.childThreadId})`,
      `Original subtask: ${snapshot.agent.task}`,
      '',
      'Use the child result below as input to the parent thread. Merge only the useful parts and continue the main task.',
      '',
      'Child result:',
      childResult,
    ].join('\n')
  }
}
