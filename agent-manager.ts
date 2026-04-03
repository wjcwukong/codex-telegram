import type { CancelResult } from './session-manager.js'
import type {
  AgentRecord,
  AgentRole,
  AgentStatus,
  ProjectRecord,
  SourceRecord,
  ThreadRecord,
} from './models.js'
import { StateStore } from './state-store.js'

const AGENT_PREVIEW_LIMIT = 500

export interface AgentSpawnInput {
  userId: string
  chatId: string
  parentThread: ThreadRecord
  project: ProjectRecord
  source: SourceRecord
  role: AgentRole
  task: string
}

export interface AgentSpawnOptions {
  includeSnapshot?: boolean
}

export interface AgentCancelOptions {
  includeSnapshot?: boolean
  reason?: string
}

export interface AgentListOptions {
  projectId?: string
  parentThreadId?: string
  childThreadId?: string
  role?: AgentRole
  status?: AgentStatus | 'active'
}

export interface AgentQueryInput {
  agentId?: string
  threadId?: string
}

export type AgentResultPreviewKind =
  | 'assistant'
  | 'cli'
  | 'result'
  | 'error'
  | 'none'

export type AgentLifecyclePhase =
  | 'queued'
  | 'dispatching'
  | 'running'
  | 'cancel_requested'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface AgentResultPreview {
  kind: AgentResultPreviewKind
  available: boolean
  text?: string
  truncated: boolean
  updatedAt?: string
}

export interface AgentWritebackSuggestion {
  mode: 'apply_result' | 'inspect_child_thread' | 'retry' | 'wait'
  title: string
  summary: string
  prompt?: string
}

export interface AgentWritebackPayload {
  available: boolean
  mode: AgentWritebackSuggestion['mode']
  title: string
  summary: string
  prompt?: string
  agentId: string
  role: AgentRole
  task: string
  parentThreadId: string
  childThreadId: string
  parentThreadTitle?: string
  childThreadTitle?: string
  agentStatus: AgentStatus
  preview?: AgentResultPreview
}

export type AgentAutoWritebackDecisionReason =
  | 'eligible'
  | 'payload-unavailable'
  | 'writeback-not-applicable'
  | 'parent-thread-missing'
  | 'child-thread-missing'
  | 'preview-missing'
  | 'preview-truncated'
  | 'agent-not-completed'

export interface AgentAutoWritebackDecision {
  eligible: boolean
  reason: AgentAutoWritebackDecisionReason
  payload?: AgentWritebackPayload
}

export interface AgentThreadRelation {
  parentThreadId: string
  childThreadId: string
  parentThread?: ThreadRecord
  childThread?: ThreadRecord
  parentExists: boolean
  childExists: boolean
}

export interface AgentStatusSnapshot {
  persisted: AgentStatus
  effective: AgentStatus
  phase: AgentLifecyclePhase
  threadStatus: ThreadRecord['status'] | 'missing'
  cancelRequested: boolean
  cancelRequestedAt?: string
  cancellationReason?: string
  cleanupState: 'pending' | 'completed'
  cleanupCompletedAt?: string
  dispatchedAt?: string
  finishedAt?: string
  lastError?: string
  updatedAt: string
}

export interface AgentSnapshot {
  agent: AgentRecord
  relation: AgentThreadRelation
  status: AgentStatusSnapshot
  resultPreview: AgentResultPreview
  writeback: AgentWritebackSuggestion
}

export interface AgentSpawnResult {
  agent: AgentRecord
  snapshot: AgentSnapshot
}

export interface AgentCancelResult {
  agent: AgentRecord
  cancel: CancelResult
  snapshot: AgentSnapshot
}

export interface AgentUpdateEvent {
  type:
    | 'spawned'
    | 'dispatched'
    | 'cancel_requested'
    | 'completed'
    | 'failed'
    | 'cancelled'
  at: string
  reason?: string
}

export interface AgentRunHooks {
  enqueueThreadRun: (
    threadLocalId: string,
    userId: string,
    chatId: string,
    text: string,
    options?: {
      outputPrefix?: string
      suppressOutput?: boolean
      agentId?: string
    },
  ) => Promise<{
    cancelled: boolean
    exitCode: number
    assistantMessage?: string
    cliMessage?: string
    error?: string
  }>
  cancelThreadExecution: (threadLocalId: string) => Promise<CancelResult>
  emitMessage: (userId: string, chatId: string, output: string) => void
  onAgentUpdate?: (snapshot: AgentSnapshot, event: AgentUpdateEvent) => void
}

interface StoredPreview {
  kind: AgentResultPreviewKind
  text?: string
  truncated: boolean
  updatedAt: string
}

interface AgentRuntimeState {
  userId: string
  chatId: string
  phase: AgentLifecyclePhase
  cleanupState: 'pending' | 'completed'
  cancelRequestedAt?: string
  cancellationReason?: string
  dispatchedAt?: string
  finishedAt?: string
  preview?: StoredPreview
  runPromise?: Promise<void>
}

type AgentRunResult = Awaited<ReturnType<AgentRunHooks['enqueueThreadRun']>>

function buildAgentThreadTitle(role: AgentRole, task: string): string {
  const shortTask = task.trim().replace(/\s+/g, ' ').slice(0, 48)
  return `${role}: ${shortTask || 'agent task'}`
}

function buildAgentPrompt(agent: Pick<AgentRecord, 'role' | 'task' | 'parentThreadId'>, parentThread?: ThreadRecord): string {
  return [
    `You are acting as a focused ${agent.role} agent.`,
    'Work only on the assigned subtask and return a concise result.',
    `Parent thread: ${parentThread?.title ?? agent.parentThreadId}`,
    '',
    `Subtask: ${agent.task}`,
  ].join('\n')
}

function formatAgentPrefix(agent: AgentRecord): string {
  return `[agent ${agent.id} | ${agent.role}]`
}

function nowIso(): string {
  return new Date().toISOString()
}

function isTerminalAgentStatus(status: AgentStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function mapThreadStatusToAgentStatus(
  status: ThreadRecord['status'] | 'missing',
): AgentStatus | undefined {
  switch (status) {
    case 'queued':
      return 'queued'
    case 'running':
      return 'running'
    case 'cancelled':
      return 'cancelled'
    case 'failed':
      return 'failed'
    case 'idle':
    case 'missing':
    default:
      return undefined
  }
}

function deriveLifecyclePhase(
  agent: AgentRecord,
  threadStatus: ThreadRecord['status'] | 'missing',
): AgentLifecyclePhase {
  if (agent.status === 'completed') {
    return 'completed'
  }

  if (agent.status === 'failed') {
    return 'failed'
  }

  if (agent.status === 'cancelled') {
    return 'cancelled'
  }

  if (threadStatus === 'running') {
    return 'running'
  }

  return 'queued'
}

function toStoredPreview(
  kind: AgentResultPreviewKind,
  text: string | undefined,
  updatedAt = nowIso(),
): StoredPreview {
  const normalized = text?.trim()
  if (!normalized) {
    return {
      kind: 'none',
      truncated: false,
      updatedAt,
    }
  }

  return {
    kind,
    text: normalized.slice(0, AGENT_PREVIEW_LIMIT),
    truncated: normalized.length > AGENT_PREVIEW_LIMIT,
    updatedAt,
  }
}

function buildWritebackSuggestion(snapshot: Omit<AgentSnapshot, 'writeback'>): AgentWritebackSuggestion {
  const payload = buildWritebackPayload(snapshot)
  return {
    mode: payload.mode,
    title: payload.title,
    summary: payload.summary,
    prompt: payload.prompt,
  }
}

function buildWritebackPayload(
  snapshot: Omit<AgentSnapshot, 'writeback'>,
): AgentWritebackPayload {
  const parentLabel =
    snapshot.relation.parentThread?.title ?? snapshot.relation.parentThreadId
  const childLabel =
    snapshot.relation.childThread?.title ?? snapshot.relation.childThreadId
  const preview = snapshot.resultPreview.text

  if (snapshot.status.effective === 'completed') {
    if (!preview) {
      return {
        available: false,
        mode: 'inspect_child_thread',
        title: 'Inspect child thread before writeback',
        summary: `Agent completed, but no result preview was captured. Review child thread ${childLabel} before merging back into ${parentLabel}.`,
        agentId: snapshot.agent.id,
        role: snapshot.agent.role,
        task: snapshot.agent.task,
        parentThreadId: snapshot.relation.parentThreadId,
        childThreadId: snapshot.relation.childThreadId,
        parentThreadTitle: snapshot.relation.parentThread?.title,
        childThreadTitle: snapshot.relation.childThread?.title,
        agentStatus: snapshot.status.effective,
        preview: snapshot.resultPreview,
      }
    }

    return {
      available: true,
      mode: 'apply_result',
      title: 'Write back child result to parent thread',
      summary: `Promote the completed child-thread result from ${childLabel} back into ${parentLabel}.`,
      prompt: [
        `Continue the parent thread using the completed ${snapshot.agent.role} agent result.`,
        `Parent thread: ${parentLabel}`,
        `Child thread: ${childLabel} (${snapshot.relation.childThreadId})`,
        `Original subtask: ${snapshot.agent.task}`,
        '',
        'Use the child result below as input to the parent thread. Merge only the useful parts and continue the main task.',
        '',
        'Child result:',
        preview,
      ].join('\n'),
      agentId: snapshot.agent.id,
      role: snapshot.agent.role,
      task: snapshot.agent.task,
      parentThreadId: snapshot.relation.parentThreadId,
      childThreadId: snapshot.relation.childThreadId,
      parentThreadTitle: snapshot.relation.parentThread?.title,
      childThreadTitle: snapshot.relation.childThread?.title,
      agentStatus: snapshot.status.effective,
      preview: snapshot.resultPreview,
    }
  }

  if (snapshot.status.effective === 'failed') {
    return {
      available: false,
      mode: 'retry',
      title: 'Inspect failure before retry',
      summary: `Agent failed in child thread ${childLabel}. Review the failure details before re-spawning or manually resuming.`,
      prompt: [
        `The background ${snapshot.agent.role} agent for this subtask failed in child thread ${snapshot.relation.childThreadId}.`,
        `Subtask: ${snapshot.agent.task}`,
        snapshot.status.lastError ? `Failure: ${snapshot.status.lastError}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      agentId: snapshot.agent.id,
      role: snapshot.agent.role,
      task: snapshot.agent.task,
      parentThreadId: snapshot.relation.parentThreadId,
      childThreadId: snapshot.relation.childThreadId,
      parentThreadTitle: snapshot.relation.parentThread?.title,
      childThreadTitle: snapshot.relation.childThread?.title,
      agentStatus: snapshot.status.effective,
      preview: snapshot.resultPreview,
    }
  }

  if (snapshot.status.effective === 'cancelled') {
    return {
      available: false,
      mode: 'retry',
      title: 'Decide whether to retry or discard',
      summary: `Agent execution was cancelled for child thread ${childLabel}. Retry only if the subtask is still needed.`,
      prompt: [
        `The background ${snapshot.agent.role} agent for child thread ${snapshot.relation.childThreadId} was cancelled.`,
        `Subtask: ${snapshot.agent.task}`,
      ].join('\n'),
      agentId: snapshot.agent.id,
      role: snapshot.agent.role,
      task: snapshot.agent.task,
      parentThreadId: snapshot.relation.parentThreadId,
      childThreadId: snapshot.relation.childThreadId,
      parentThreadTitle: snapshot.relation.parentThread?.title,
      childThreadTitle: snapshot.relation.childThread?.title,
      agentStatus: snapshot.status.effective,
      preview: snapshot.resultPreview,
    }
  }

  return {
    available: false,
    mode: 'wait',
    title: 'Wait for the agent to settle',
    summary: `Agent is still active in child thread ${childLabel}. Poll query/list until it reaches a terminal state before writing back.`,
    agentId: snapshot.agent.id,
    role: snapshot.agent.role,
    task: snapshot.agent.task,
    parentThreadId: snapshot.relation.parentThreadId,
    childThreadId: snapshot.relation.childThreadId,
    parentThreadTitle: snapshot.relation.parentThread?.title,
    childThreadTitle: snapshot.relation.childThread?.title,
    agentStatus: snapshot.status.effective,
    preview: snapshot.resultPreview,
  }
}

function getAutoWritebackDecision(
  snapshot: Omit<AgentSnapshot, 'writeback'>,
): AgentAutoWritebackDecision {
  const payload = buildWritebackPayload(snapshot)

  if (snapshot.status.effective !== 'completed') {
    return {
      eligible: false,
      reason: 'agent-not-completed',
      payload,
    }
  }

  if (!payload.available) {
    return {
      eligible: false,
      reason: 'payload-unavailable',
      payload,
    }
  }

  if (payload.mode !== 'apply_result') {
    return {
      eligible: false,
      reason: 'writeback-not-applicable',
      payload,
    }
  }

  if (!snapshot.relation.parentExists) {
    return {
      eligible: false,
      reason: 'parent-thread-missing',
      payload,
    }
  }

  if (!snapshot.relation.childExists) {
    return {
      eligible: false,
      reason: 'child-thread-missing',
      payload,
    }
  }

  if (!payload.preview?.available || !payload.prompt?.trim()) {
    return {
      eligible: false,
      reason: 'preview-missing',
      payload,
    }
  }

  return {
    eligible: true,
    reason: 'eligible',
    payload,
  }
}

export class AgentManager {
  private readonly runtimes = new Map<string, AgentRuntimeState>()

  constructor(
    private readonly store: StateStore,
    private readonly hooks: AgentRunHooks,
  ) {}

  listAgents(projectId?: string, parentThreadId?: string): AgentRecord[] {
    return this.list({ projectId, parentThreadId }).map((entry) => entry.agent)
  }

  list(options: AgentListOptions = {}): AgentSnapshot[] {
    return this.store
      .listAgents(options.projectId, options.parentThreadId)
      .filter((agent) => {
        if (options.childThreadId && agent.threadId !== options.childThreadId) {
          return false
        }
        if (options.role && agent.role !== options.role) {
          return false
        }
        if (options.status === 'active') {
          return agent.status === 'queued' || agent.status === 'running'
        }
        if (options.status && agent.status !== options.status) {
          return false
        }
        return true
      })
      .map((agent) => this.buildSnapshot(agent))
  }

  query(input: string | AgentQueryInput): AgentSnapshot | undefined {
    let agent: AgentRecord | undefined

    if (typeof input === 'string') {
      const reference = input.trim()
      if (!reference) {
        return undefined
      }

      agent =
        this.store.getAgent(reference) ??
        this.store.listAgents().find((entry) => entry.threadId === reference)
    } else if (input.agentId) {
      agent = this.store.getAgent(input.agentId)
    } else if (input.threadId) {
      agent = this.store.listAgents().find((entry) => entry.threadId === input.threadId)
    }

    return agent ? this.buildSnapshot(agent) : undefined
  }

  preview(agentId: string): AgentResultPreview | undefined {
    return this.query(agentId)?.resultPreview
  }

  suggestWriteback(agentId: string): AgentWritebackSuggestion | undefined {
    return this.query(agentId)?.writeback
  }

  prepareWriteback(agentId: string): AgentWritebackPayload | undefined {
    const snapshot = this.query(agentId)
    if (!snapshot) {
      return undefined
    }

    const { writeback, ...snapshotWithoutWriteback } = snapshot
    void writeback
    return buildWritebackPayload(snapshotWithoutWriteback)
  }

  buildWritebackPrompt(agentId: string): string | undefined {
    return this.prepareWriteback(agentId)?.prompt
  }

  getAutoWritebackDecision(agentId: string): AgentAutoWritebackDecision {
    const snapshot = this.query(agentId)
    if (!snapshot) {
      return {
        eligible: false,
        reason: 'payload-unavailable',
      }
    }

    const { writeback, ...snapshotWithoutWriteback } = snapshot
    void writeback
    return getAutoWritebackDecision(snapshotWithoutWriteback)
  }

  canAutoWriteback(agentId: string): boolean {
    return this.getAutoWritebackDecision(agentId).eligible
  }

  getRuntimeContext(agentId: string): { userId: string; chatId: string } | undefined {
    const runtime = this.runtimes.get(agentId)
    if (!runtime) {
      return undefined
    }

    return {
      userId: runtime.userId,
      chatId: runtime.chatId,
    }
  }

  async spawnAgent(input: AgentSpawnInput): Promise<AgentSpawnResult> {
    const thread = await this.store.createThread(input.project.id, {
      sourceId: input.source.id,
      cwd: input.parentThread.cwd,
      title: buildAgentThreadTitle(input.role, input.task),
      origin: 'telegram',
      status: 'queued',
    })

    const agent = await this.store.createAgent({
      parentThreadId: input.parentThread.id,
      threadId: thread.id,
      projectId: input.project.id,
      sourceId: input.source.id,
      role: input.role,
      task: input.task,
      status: 'queued',
    })

    this.runtimes.set(agent.id, {
      userId: input.userId,
      chatId: input.chatId,
      phase: 'queued',
      cleanupState: 'pending',
    })

    this.emitUpdate(agent.id, 'spawned')

    const runPromise = this.runAgent(agent.id, input.userId, input.chatId)
    const runtime = this.runtimes.get(agent.id)
    if (runtime) {
      runtime.runPromise = runPromise
    }
    void runPromise

    return {
      agent,
      snapshot: this.buildSnapshot(agent),
    }
  }

  async spawn(input: AgentSpawnInput): Promise<AgentRecord>
  async spawn(
    input: AgentSpawnInput,
    options: AgentSpawnOptions & { includeSnapshot: true },
  ): Promise<AgentSpawnResult>
  async spawn(
    input: AgentSpawnInput,
    options: AgentSpawnOptions = {},
  ): Promise<AgentRecord | AgentSpawnResult> {
    const result = await this.spawnAgent(input)
    return options.includeSnapshot ? result : result.agent
  }

  async cancelAgent(
    agentId: string,
    options: AgentCancelOptions = {},
  ): Promise<AgentCancelResult> {
    const agent = this.store.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    if (isTerminalAgentStatus(agent.status)) {
      const thread = this.store.getThread(agent.threadId)
      return {
        agent,
        cancel: {
          hadThread: Boolean(thread),
          killedRunning: false,
          clearedQueued: false,
          thread,
        },
        snapshot: this.buildSnapshot(agent),
      }
    }

    const reason = options.reason?.trim() || 'Cancelled by user'
    const runtime = this.getOrCreateRuntime(agent, {
      phase: deriveLifecyclePhase(agent, this.store.getThread(agent.threadId)?.status ?? 'missing'),
    })
    runtime.phase = 'cancel_requested'
    runtime.cancelRequestedAt = nowIso()
    runtime.cancellationReason = reason
    this.emitUpdate(agent.id, 'cancel_requested', reason)

    if (!runtime.dispatchedAt) {
      const updatedAgent = await this.finalizeCancelled(agent.id, reason)
      return {
        agent: updatedAgent,
        cancel: {
          hadThread: Boolean(this.store.getThread(agent.threadId)),
          killedRunning: false,
          clearedQueued: false,
          thread: this.store.getThread(agent.threadId),
        },
        snapshot: this.buildSnapshot(updatedAgent),
      }
    }

    const cancel = await this.hooks.cancelThreadExecution(agent.threadId)
    const latest = this.store.getAgent(agent.id)
    if (!latest) {
      throw new Error(`Agent disappeared during cancel: ${agent.id}`)
    }

    const shouldFinalize =
      cancel.killedRunning || cancel.clearedQueued || latest.status === 'cancelled'

    const updatedAgent = shouldFinalize
      ? await this.finalizeCancelled(
          latest.id,
          cancel.killedRunning || cancel.clearedQueued
            ? reason
            : runtime.cancellationReason ?? reason,
        )
      : latest

    return {
      agent: updatedAgent,
      cancel,
      snapshot: this.buildSnapshot(updatedAgent),
    }
  }

  async cancel(agentId: string): Promise<{ agent: AgentRecord; cancel: CancelResult }>
  async cancel(
    agentId: string,
    options: AgentCancelOptions & { includeSnapshot: true },
  ): Promise<AgentCancelResult>
  async cancel(
    agentId: string,
    options: AgentCancelOptions = {},
  ): Promise<{ agent: AgentRecord; cancel: CancelResult } | AgentCancelResult> {
    const result = await this.cancelAgent(agentId, options)
    return options.includeSnapshot
      ? result
      : {
          agent: result.agent,
          cancel: result.cancel,
        }
  }

  private async runAgent(agentId: string, userId: string, chatId: string): Promise<void> {
    const agent = this.store.getAgent(agentId)
    if (!agent) {
      return
    }

    const runtime = this.getOrCreateRuntime(agent, {
      userId,
      chatId,
      phase: 'queued',
    })

    if (runtime.cancelRequestedAt) {
      await this.finalizeCancelled(agent.id, runtime.cancellationReason ?? 'Cancelled before dispatch')
      return
    }

    const prompt = buildAgentPrompt(agent, this.store.getThread(agent.parentThreadId))
    await this.store.updateAgent(agent.id, {
      status: 'running',
      lastError: undefined,
    })
    runtime.phase = 'dispatching'
    runtime.dispatchedAt = nowIso()
    this.emitUpdate(agent.id, 'dispatched')

    if (runtime.cancelRequestedAt) {
      await this.finalizeCancelled(
        agent.id,
        runtime.cancellationReason ?? 'Cancelled before dispatch',
      )
      return
    }

    let result: AgentRunResult
    try {
      result = await this.hooks.enqueueThreadRun(agent.threadId, userId, chatId, prompt, {
        outputPrefix: formatAgentPrefix(agent),
        agentId: agent.id,
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      await this.finalizeFailed(agent.id, errorMessage)
      return
    }

    if (result.cancelled) {
      await this.finalizeCancelled(
        agent.id,
        runtime.cancellationReason ?? result.error ?? 'Cancelled while running',
      )
      return
    }

    if (result.exitCode === 0) {
      await this.finalizeCompleted(agent.id, result)
      return
    }

    const errorMessage = result.cliMessage ?? `exit code ${result.exitCode}`
    await this.finalizeFailed(agent.id, errorMessage)
  }

  private buildSnapshot(agent: AgentRecord): AgentSnapshot {
    const parentThread = this.store.getThread(agent.parentThreadId)
    const childThread = this.store.getThread(agent.threadId)
    const runtime = this.runtimes.get(agent.id)
    const threadStatus: ThreadRecord['status'] | 'missing' = childThread?.status ?? 'missing'
    const persisted = agent.status
    const derivedStatus = mapThreadStatusToAgentStatus(threadStatus)
    const effective =
      runtime?.phase === 'cancel_requested'
        ? persisted
        : !isTerminalAgentStatus(persisted) && derivedStatus
          ? derivedStatus
          : persisted
    const preview = this.buildPreview(agent, runtime)
    const snapshotWithoutWriteback: Omit<AgentSnapshot, 'writeback'> = {
      agent,
      relation: {
        parentThreadId: agent.parentThreadId,
        childThreadId: agent.threadId,
        parentThread,
        childThread,
        parentExists: Boolean(parentThread),
        childExists: Boolean(childThread),
      },
      status: {
        persisted,
        effective,
        phase: runtime?.phase ?? deriveLifecyclePhase(agent, threadStatus),
        threadStatus,
        cancelRequested: Boolean(runtime?.cancelRequestedAt),
        cancelRequestedAt: runtime?.cancelRequestedAt,
        cancellationReason: runtime?.cancellationReason,
        cleanupState:
          runtime?.cleanupState ?? (isTerminalAgentStatus(persisted) ? 'completed' : 'pending'),
        cleanupCompletedAt:
          runtime?.cleanupState === 'completed' ? runtime.finishedAt : undefined,
        dispatchedAt: runtime?.dispatchedAt,
        finishedAt: runtime?.finishedAt,
        lastError: agent.lastError,
        updatedAt: agent.updatedAt,
      },
      resultPreview: preview,
    }

    return {
      ...snapshotWithoutWriteback,
      writeback: buildWritebackSuggestion(snapshotWithoutWriteback),
    }
  }

  private buildPreview(
    agent: AgentRecord,
    runtime?: AgentRuntimeState,
  ): AgentResultPreview {
    if (runtime?.preview) {
      return {
        kind: runtime.preview.kind,
        available: Boolean(runtime.preview.text),
        text: runtime.preview.text,
        truncated: runtime.preview.truncated,
        updatedAt: runtime.preview.updatedAt,
      }
    }

    if (agent.lastMessagePreview) {
      return {
        kind: 'result',
        available: true,
        text: agent.lastMessagePreview,
        truncated: agent.lastMessagePreview.length >= AGENT_PREVIEW_LIMIT,
        updatedAt: agent.updatedAt,
      }
    }

    if (agent.lastError) {
      const preview = toStoredPreview('error', agent.lastError, agent.updatedAt)
      return {
        kind: preview.kind,
        available: Boolean(preview.text),
        text: preview.text,
        truncated: preview.truncated,
        updatedAt: preview.updatedAt,
      }
    }

    return {
      kind: 'none',
      available: false,
      truncated: false,
      updatedAt: agent.updatedAt,
    }
  }

  private getOrCreateRuntime(
    agent: AgentRecord,
    patch: Partial<AgentRuntimeState> = {},
  ): AgentRuntimeState {
    const existing = this.runtimes.get(agent.id)
    if (existing) {
      Object.assign(existing, patch)
      return existing
    }

    const created: AgentRuntimeState = {
      userId: patch.userId ?? '',
      chatId: patch.chatId ?? '',
      phase: patch.phase ?? deriveLifecyclePhase(agent, this.store.getThread(agent.threadId)?.status ?? 'missing'),
      cleanupState: patch.cleanupState ?? 'pending',
      cancelRequestedAt: patch.cancelRequestedAt,
      cancellationReason: patch.cancellationReason,
      dispatchedAt: patch.dispatchedAt,
      finishedAt: patch.finishedAt,
      preview: patch.preview,
      runPromise: patch.runPromise,
    }
    this.runtimes.set(agent.id, created)
    return created
  }

  private async finalizeCompleted(
    agentId: string,
    result: AgentRunResult,
  ): Promise<AgentRecord> {
    const agent = this.store.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    const runtime = this.getOrCreateRuntime(agent)
    const completedAt = nowIso()
    const previewSource = result.assistantMessage ? 'assistant' : result.cliMessage ? 'cli' : 'none'
    const previewText = result.assistantMessage ?? result.cliMessage
    runtime.phase = 'completed'
    runtime.cleanupState = 'completed'
    runtime.finishedAt = completedAt
    runtime.preview = toStoredPreview(previewSource, previewText, completedAt)

    await this.syncChildThreadStatus(agent.threadId, 'idle')
    const updatedAgent = await this.store.updateAgent(agent.id, {
      status: 'completed',
      lastError: undefined,
      lastMessagePreview: runtime.preview.text,
    })
    this.emitUpdate(agent.id, 'completed')
    return updatedAgent
  }

  private async finalizeFailed(agentId: string, errorMessage: string): Promise<AgentRecord> {
    const agent = this.store.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    const runtime = this.getOrCreateRuntime(agent)
    const failedAt = nowIso()
    runtime.phase = 'failed'
    runtime.cleanupState = 'completed'
    runtime.finishedAt = failedAt
    runtime.preview = toStoredPreview('error', errorMessage, failedAt)

    await this.syncChildThreadStatus(agent.threadId, 'failed')
    const updatedAgent = await this.store.updateAgent(agent.id, {
      status: 'failed',
      lastError: errorMessage,
      lastMessagePreview: undefined,
    })
    this.emitUpdate(agent.id, 'failed', errorMessage)
    this.hooks.emitMessage(
      runtime.userId,
      runtime.chatId,
      `${formatAgentPrefix(agent)} failed:\n${errorMessage}`,
    )
    return updatedAgent
  }

  private async finalizeCancelled(
    agentId: string,
    reason: string,
  ): Promise<AgentRecord> {
    const agent = this.store.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    const runtime = this.getOrCreateRuntime(agent)
    if (agent.status === 'cancelled' && runtime.cleanupState === 'completed') {
      return agent
    }

    const cancelledAt = nowIso()
    runtime.phase = 'cancelled'
    runtime.cleanupState = 'completed'
    runtime.finishedAt = cancelledAt
    runtime.cancellationReason = reason

    await this.syncChildThreadStatus(agent.threadId, 'cancelled')
    const updatedAgent = await this.store.updateAgent(agent.id, {
      status: 'cancelled',
      lastError: undefined,
      lastMessagePreview: undefined,
    })
    this.emitUpdate(agent.id, 'cancelled', reason)
    return updatedAgent
  }

  private async syncChildThreadStatus(
    threadId: string,
    status: ThreadRecord['status'],
  ): Promise<void> {
    const thread = this.store.getThread(threadId)
    if (!thread || thread.status === status) {
      return
    }

    await this.store.updateThread(thread.id, { status })
  }

  private emitUpdate(
    agentId: string,
    type: AgentUpdateEvent['type'],
    reason?: string,
  ): void {
    const snapshot = this.query({ agentId })
    if (!snapshot) {
      return
    }

    this.hooks.onAgentUpdate?.(snapshot, {
      type,
      at: nowIso(),
      reason,
    })
  }
}
