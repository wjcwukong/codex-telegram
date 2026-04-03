import { access, lstat, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { AgentManager } from './agent-manager.js'
import { ProjectService } from './src/core/project-service.js'
import { ThreadService } from './src/core/thread-service.js'
import {
  Importer,
  type ImportPendingSource,
  type ImportSourceSyncStatus,
  type ImportSourceSyncSummary,
  type ImportSyncOptions,
  type ImportSyncRunResult,
  type ImportSyncStatus,
} from './importer.js'
import {
  getHistoryEntryKey,
  HistoryReader,
  type HistoryEntry,
  type HistoryPage,
  type HistoryReadOptions,
  type HistoryTurn,
  type HistoryTurnPage,
} from './history-reader.js'
import { resolveProjectIdentity } from './project-normalizer.js'
import {
  RunScheduler,
  type RunRecord,
  type RunStatus,
} from './run-scheduler.js'
import {
  selectAgentSource,
} from './storage-policy.js'
import type {
  AgentParentSourceOverrideMode,
  AgentRecord,
  AgentRole,
  ImportSummary,
  ProjectSourceMode,
  ProjectRecord,
  SelectionRecord,
  SourceRecord,
  ThreadRecord,
} from './models.js'
import { StateStore, type OrderedListLocation } from './state-store.js'
import { UndoManager } from './src/core/undo-manager.js'
import { QueryService } from './src/core/query-service.js'
import {
  ExecutionEngine,
  type CancelResult,
  type ThreadRunResult,
  type StoredRunReplayOptions,
} from './src/core/execution-engine.js'
import type { AppServerClient } from './src/core/app-server-client.js'

export type { CancelResult, ThreadRunResult } from './src/core/execution-engine.js'

export interface Session {
  userId: string
  chatId: string
  cwd: string
  lastActive: number
  currentProjectId?: string
  currentThreadId?: string
}

export interface ProjectState {
  currentProject?: ProjectRecord
  projects: ProjectRecord[]
  currentProjectLocation?: OrderedListLocation
}

export interface ProjectSearchState {
  currentProject?: ProjectRecord
  projects: ProjectRecord[]
  query: string
  currentProjectLocation?: OrderedListLocation
}

export interface ProjectDetails {
  project?: ProjectRecord
  defaultSource?: SourceRecord
  threadCount: number
  originatorCounts?: Map<string, number>
  currentThread?: ThreadRecord
  sources: SourceRecord[]
}

export interface ThreadState {
  currentProject?: ProjectRecord
  currentThread?: ThreadRecord
  threads: ThreadRecord[]
  currentThreadLocation?: OrderedListLocation
}

export interface ThreadSearchState {
  currentProject?: ProjectRecord
  currentThread?: ThreadRecord
  threads: ThreadRecord[]
  query: string
  currentThreadLocation?: OrderedListLocation
}

export interface SourceEntry {
  source: SourceRecord
  projectCount: number
  threadCount: number
  agentCount: number
}

export interface ImportStatusState {
  sync: ImportSyncStatus
  pending: ImportPendingSource[]
  sources: Array<SourceEntry & { importStatus: ImportSourceSyncStatus }>
}

export interface SourceSyncDetails extends SourceEntry {
  importStatus: ImportSourceSyncStatus
}

export interface SyncProjectsDetails {
  run: ImportSyncRunResult
  sources: Array<SourceEntry & { run?: ImportSourceSyncSummary }>
}

export interface SourceState {
  sources: SourceEntry[]
  query?: string
}

export interface AgentState {
  project?: ProjectRecord
  parentThread?: ThreadRecord
  agents: AgentRecord[]
  query?: string
}

export interface AgentDetails {
  agent: import('./agent-manager.js').AgentSnapshot
  parentThread?: ThreadRecord
  childThread?: ThreadRecord
  project?: ProjectRecord
  writebackRun?: RunRecord
}

export interface RunState {
  project?: ProjectRecord
  thread?: ThreadRecord
  runs: RunRecord[]
  query?: string
}

export type RunDisplayStatus = RunStatus | 'waiting_approval'

export interface UndoLastTurnResult {
  thread: ThreadRecord
  turn: HistoryTurn
  hiddenEntryCount: number
  cancel: CancelResult
  mode: 'rewritten' | 'hidden'
  rewrittenFiles?: number
}

export type StreamDeltaHandler = (
  userId: string,
  chatId: string,
  delta: string,
  meta: { turnId: string; threadId: string },
) => void

export type RunCompleteHandler = (
  runId: string,
  threadId: string,
) => void

export type BotPromptHandler = (
  codexThreadId: string,
  turnId: string,
  text: string,
) => void

export type OutputHandler = (
  userId: string,
  chatId: string,
  output: string,
) => void | Promise<void>

const ANSI_PATTERN =
  /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|\u009B[0-?]*[ -/]*[@-~]/g
const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_CODEX_HOME = join(homedir(), '.codex')
const BOT_STATE_DIR = join(homedir(), '.codex-telegram')
const BOT_CODEX_HOME = join(homedir(), '.codex-telegram', 'codex-home')
const BOT_TMP_DIR = join(homedir(), '.codex-telegram', 'tmp')
const SHARED_CODEX_HOME_ITEMS = [
  'auth.json',
  'auth.json.back',
  'config.toml',
  'models_cache.json',
  'plugins',
  'rules',
  'skills',
  'vendor_imports',
  'version.json',
]

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

export function chunkText(text: string, maxLen = 4000): string[] {
  if (!text) {
    return []
  }

  const limit = Number.isFinite(maxLen) && maxLen > 0 ? Math.floor(maxLen) : 4000
  const chunks: string[] = []
  let remaining = text

  while (remaining.length > limit) {
    const splitAt = findSplitIndex(remaining, limit)
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
  }

  if (remaining.length > 0) {
    chunks.push(remaining)
  }

  return chunks
}

function findSplitIndex(text: string, maxLen: number): number {
  const window = text.slice(0, maxLen)
  const paragraphBreak = window.lastIndexOf('\n\n')

  if (paragraphBreak > 0) {
    return paragraphBreak + 2
  }

  const lineBreak = window.lastIndexOf('\n')

  if (lineBreak > 0) {
    return lineBreak + 1
  }

  return maxLen
}

function getSessionKey(userId: string, chatId: string): string {
  return `${chatId}:${userId}`
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Write a minimal rollout file so `codex resume <threadId>` can find the session.
 * The app-server's `thread/start` only creates the thread in memory;
 * this seeds the on-disk session file that the CLI scanner expects.
 */
async function writeBootstrapRollout(
  codexHome: string,
  threadId: string,
  cwd: string,
): Promise<void> {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const y = now.getFullYear()
  const m = pad(now.getMonth() + 1)
  const d = pad(now.getDate())
  const dir = join(codexHome, 'sessions', String(y), m, d)
  await mkdir(dir, { recursive: true })

  const ts = now.toISOString()
  const fileSafeTs = ts.replace(/:/g, '-').replace(/\.\d{3}Z$/, '')
  const filename = `rollout-${fileSafeTs}-${threadId}.jsonl`
  const filepath = join(dir, filename)

  const meta = {
    timestamp: ts,
    type: 'session_meta',
    payload: {
      id: threadId,
      timestamp: ts,
      cwd,
      originator: 'codex-telegram',
      cli_version: '0.117.0',
      source: 'vscode',
      model_provider: 'openai',
    },
  }
  await writeFile(filepath, JSON.stringify(meta) + '\n', 'utf-8')
}

export class SessionManager {
  sessions = new Map<string, Session>()
  onOutput: OutputHandler
  onStreamDelta?: StreamDeltaHandler
  onRunComplete?: RunCompleteHandler
  onBotPrompt?: BotPromptHandler

  private readonly cwd: string
  private readonly sessionTimeoutMs: number
  private readonly sharedCodexHome: string
  private readonly botCodexHome: string
  private readonly stateStore: StateStore
  private readonly projectService: ProjectService
  private readonly threadService: ThreadService
  private readonly undoManager: UndoManager
  private readonly queryService: QueryService
  private readonly agentManager: AgentManager
  private readonly importer: Importer
  private readonly historyReader: HistoryReader
  private readonly scheduler: RunScheduler
  private readonly executionEngine: ExecutionEngine
  private readonly appServerClient?: AppServerClient
  private readonly ready: Promise<void>

  constructor(
    onOutput: OutputHandler,
    options: {
      cwd?: string
      sessionTimeoutMs?: number
      sharedCodexHome?: string
      botCodexHome?: string
      stateStore?: StateStore
      importer?: Importer
      onStreamDelta?: StreamDeltaHandler
      onRunComplete?: RunCompleteHandler
      onBotPrompt?: BotPromptHandler
    } = {},
    appServerClient?: AppServerClient,
  ) {
    this.onOutput = onOutput
    this.onStreamDelta = options.onStreamDelta
    this.onRunComplete = options.onRunComplete
    this.onBotPrompt = options.onBotPrompt
    this.appServerClient = appServerClient
    this.cwd = options.cwd ?? process.cwd()
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS
    this.sharedCodexHome =
      options.sharedCodexHome ??
      process.env.CODEX_HOME?.trim() ??
      DEFAULT_CODEX_HOME
    this.botCodexHome = options.botCodexHome ?? BOT_CODEX_HOME
    this.stateStore = options.stateStore ?? new StateStore()
    this.projectService = new ProjectService(this.stateStore)
    this.importer = options.importer ?? new Importer(this.stateStore)
    this.threadService = new ThreadService(this.stateStore, this.importer)
    this.historyReader = new HistoryReader(this.stateStore)
    this.scheduler = new RunScheduler({
      onStatusChange: (record) => {
        void this.executionEngine.handleRunStatusChange(record)
      },
    })
    this.agentManager = new AgentManager(this.stateStore, {
      enqueueThreadRun: (threadLocalId, userId, chatId, text, runOptions) =>
        this.executionEngine.enqueueThreadRun(threadLocalId, userId, chatId, text, runOptions),
      cancelThreadExecution: (threadLocalId) => this.executionEngine.cancelThreadExecution(threadLocalId),
      emitMessage: (userId, chatId, output) => this.onOutput(userId, chatId, output),
      onAgentUpdate: (snapshot, event) => {
        void this.executionEngine.handleAgentUpdate(snapshot, event)
      },
    })
    this.executionEngine = new ExecutionEngine(
      this.stateStore,
      this.scheduler,
      this.agentManager,
      this.historyReader,
      {
        onOutput: (userId, chatId, text) => this.onOutput(userId, chatId, text),
        onStreamDelta: (userId, chatId, delta, meta) => this.onStreamDelta?.(userId, chatId, delta, meta),
        onRunComplete: (runId, threadId) => this.onRunComplete?.(runId, threadId),
        onBotPrompt: (codexThreadId, turnId, text) => this.onBotPrompt?.(codexThreadId, turnId, text),
      },
      appServerClient,
    )
    this.ready = this.initialize()
    this.undoManager = new UndoManager(this.stateStore, this.historyReader)
    this.queryService = new QueryService(
      this.stateStore,
      this.historyReader,
      this.importer,
      this.scheduler,
      this.agentManager,
      this.ready,
    )
  }

  get(userId: string, chatId: string): Session | undefined {
    return this.sessions.get(getSessionKey(userId, chatId))
  }

  /** Turn IDs initiated by this bot (for distinguishing external turns). */
  get botTurnIds(): Set<string> {
    return this.executionEngine.botTurnIds
  }

  async getProjectState(
    userId: string,
    chatId: string,
    options: { includeArchived?: boolean; pageSize?: number } = {},
  ): Promise<ProjectState> {
    const session = await this.ensureSession(userId, chatId)
    return this.queryService.getProjectState(session, options)
  }

  async searchProjects(
    userId: string,
    chatId: string,
    query: string,
    options: { pageSize?: number } = {},
  ): Promise<ProjectSearchState> {
    const session = await this.ensureSession(userId, chatId)
    return this.queryService.searchProjects(session, query, options)
  }

  async getProjectDetails(userId: string, chatId: string): Promise<ProjectDetails> {
    const session = await this.ensureSession(userId, chatId)
    return this.queryService.getProjectDetails(session)
  }

  getDesktopProjectIds(): Set<string> {
    return this.stateStore.getDesktopProjectIds()
  }

  async getSourceState(): Promise<SourceState> {
    return this.queryService.getSourceState()
  }

  async searchSources(query: string): Promise<SourceState> {
    return this.queryService.searchSources(query)
  }

  async getSourceDetails(sourceId: string): Promise<SourceEntry | undefined> {
    return this.queryService.getSourceDetails(sourceId)
  }

  async setSourceEnabled(
    sourceId: string,
    enabled: boolean,
  ): Promise<SourceRecord> {
    await this.ready

    return this.stateStore.updateSource(sourceId, { enabled })
  }

  async createProject(
    userId: string,
    chatId: string,
    name: string,
    cwd?: string,
  ): Promise<ProjectRecord> {
    const session = await this.ensureSession(userId, chatId)
    const targetCwd = cwd?.trim() || session.cwd || this.cwd
    const currentProject = session.currentProjectId
      ? this.stateStore.getProject(session.currentProjectId)
      : undefined
    const defaultSourceId = currentProject?.defaultSourceId ?? 'shared'

    const project = await this.projectService.createProject(name, targetCwd, defaultSourceId)

    await this.updateSelection(session, {
      currentProjectId: project.id,
      currentThreadId: undefined,
    })

    return project
  }

  async renameCurrentProject(
    userId: string,
    chatId: string,
    newName: string,
  ): Promise<ProjectRecord> {
    const session = await this.ensureSession(userId, chatId)
    const project = this.getRequiredProject(session)
    return this.projectService.renameProject(project.id, newName)
  }

  async archiveCurrentProject(userId: string, chatId: string): Promise<ProjectRecord> {
    const session = await this.ensureSession(userId, chatId)
    const project = this.getRequiredProject(session)
    const archived = await this.projectService.archiveProject(project.id)
    const nextProject = this.stateStore.listProjects()[0]

    await this.updateSelection(session, {
      currentProjectId: nextProject?.id,
      currentThreadId: nextProject
        ? this.stateStore.listThreads(nextProject.id)[0]?.id
        : undefined,
    })

    return archived
  }

  async deleteCurrentProject(userId: string, chatId: string): Promise<ProjectRecord> {
    const session = await this.ensureSession(userId, chatId)
    const project = this.getRequiredProject(session)
    await this.projectService.deleteProject(project.id)
    const nextProject = this.stateStore.listProjects()[0]

    await this.updateSelection(session, {
      currentProjectId: nextProject?.id,
      currentThreadId: nextProject
        ? this.stateStore.listThreads(nextProject.id)[0]?.id
        : undefined,
    })

    return project
  }

  async setCurrentProjectSource(
    userId: string,
    chatId: string,
    sourceId: string,
  ): Promise<{ project: ProjectRecord; source: SourceRecord }> {
    const session = await this.ensureSession(userId, chatId)
    const project = this.getRequiredProject(session)
    return this.projectService.setProjectSource(project.id, sourceId)
  }

  async setCurrentProjectSourceMode(
    userId: string,
    chatId: string,
    sourceMode: ProjectSourceMode,
  ): Promise<ProjectRecord> {
    const session = await this.ensureSession(userId, chatId)
    const project = this.getRequiredProject(session)
    return this.projectService.setProjectSourceMode(project.id, sourceMode)
  }

  async setCurrentProjectAgentSourceOverrideMode(
    userId: string,
    chatId: string,
    agentSourceOverrideMode: AgentParentSourceOverrideMode,
  ): Promise<ProjectRecord> {
    const session = await this.ensureSession(userId, chatId)
    const project = this.getRequiredProject(session)
    return this.projectService.setProjectAgentSourceOverrideMode(project.id, agentSourceOverrideMode)
  }

  async setCurrentProjectAgentAutoWriteback(
    userId: string,
    chatId: string,
    agentAutoWritebackEnabled: boolean,
  ): Promise<ProjectRecord> {
    const session = await this.ensureSession(userId, chatId)
    const project = this.getRequiredProject(session)
    return this.projectService.setProjectAgentAutoWriteback(project.id, agentAutoWritebackEnabled)
  }

  async switchProject(
    userId: string,
    chatId: string,
    reference: string,
  ): Promise<ProjectRecord> {
    const session = await this.ensureSession(userId, chatId)
    const project = this.projectService.resolveProjectReference(reference)

    if (!project) {
      throw new Error(`Unknown project: ${reference}`)
    }

    const threads = this.stateStore.listThreads(project.id)
    const currentThread = threads[0]
    await this.updateSelection(session, {
      currentProjectId: project.id,
      currentThreadId: currentThread?.id,
    })

    return project
  }

  async syncProjects(): Promise<ImportSummary> {
    await this.ready
    return this.importer.syncEnabledSources()
  }

  /**
   * Pull threads from the Codex app-server and create local ThreadRecords
   * for any that are not already tracked.  Returns the count of new threads.
   */
  async syncThreadsFromServer(
    userId: string,
    chatId: string,
  ): Promise<number> {
    await this.ready

    if (!this.appServerClient?.connected) {
      throw new Error('App-server is not connected')
    }

    const session = await this.ensureSession(userId, chatId)
    const project = this.getRequiredProject(session)

    const { threads: serverThreads } = await this.appServerClient.threadList()
    let added = 0

    for (const st of serverThreads) {
      // Skip threads that already have a local record (any source)
      const allSources = this.stateStore.listSources({ includeDisabled: true })
      let alreadyTracked = false
      for (const source of allSources) {
        if (this.stateStore.findThreadByCodexThreadId(source.id, st.id)) {
          alreadyTracked = true
          break
        }
      }
      if (alreadyTracked) continue

      await this.stateStore.createThread(project.id, {
        sourceId: project.defaultSourceId,
        cwd: st.cwd ?? st.path ?? project.cwd,
        title: st.name ?? st.preview ?? `Server thread ${st.id.slice(0, 8)}`,
        origin: 'imported' as const,
        originator: 'imported',
        codexThreadId: st.id,
        status: 'idle',
      })
      added += 1
    }

    return added
  }

  async syncProjectsDetailed(
    options: ImportSyncOptions = {},
  ): Promise<SyncProjectsDetails> {
    await this.ready
    const run = await this.importer.syncEnabledSourcesDetailed(options)
    const runBySource = new Map(
      run.sources.map((source) => [source.sourceId, source] as const),
    )

    return {
      run,
      sources: this.queryService.buildSourceEntries().map((source) => ({
        ...source,
        run: runBySource.get(source.source.id),
      })),
    }
  }

  async getImportStatus(
    options: Omit<ImportSyncOptions, 'onlyIfChanged'> = {},
  ): Promise<ImportStatusState> {
    return this.queryService.getImportStatus(options)
  }

  async getSourceImportStatus(
    sourceId: string,
    options: Omit<ImportSyncOptions, 'onlyIfChanged' | 'sourceIds'> = {},
  ): Promise<SourceSyncDetails | undefined> {
    return this.queryService.getSourceImportStatus(sourceId, options)
  }

  async getCurrentCwd(userId: string, chatId: string): Promise<string> {
    const session = await this.ensureSession(userId, chatId)
    return this.queryService.getCurrentCwd(session)
  }

  async getCurrentProjectListLocation(
    userId: string,
    chatId: string,
    options: { includeArchived?: boolean; pageSize?: number } = {},
  ): Promise<OrderedListLocation | undefined> {
    const session = await this.ensureSession(userId, chatId)
    return this.queryService.getCurrentProjectListLocation(session, options)
  }

  async getCurrentThreadListLocation(
    userId: string,
    chatId: string,
    options: { includeArchived?: boolean; pageSize?: number } = {},
  ): Promise<OrderedListLocation | undefined> {
    const session = await this.ensureSession(userId, chatId)
    return this.queryService.getCurrentThreadListLocation(session, options)
  }

  async getThreadState(
    userId: string,
    chatId: string,
    options: { includeArchived?: boolean; pageSize?: number } = {},
  ): Promise<ThreadState> {
    const session = await this.ensureSession(userId, chatId)
    return this.queryService.getThreadState(session, options)
  }

  async searchThreads(
    userId: string,
    chatId: string,
    query: string,
    options: { pageSize?: number } = {},
  ): Promise<ThreadSearchState> {
    const session = await this.ensureSession(userId, chatId)
    return this.queryService.searchThreads(session, query, options)
  }

  async getThreadHistory(
    userId: string,
    chatId: string,
    limit = 10,
  ): Promise<{ project?: ProjectRecord; thread?: ThreadRecord; entries: HistoryEntry[] }> {
    const session = await this.ensureSession(userId, chatId)
    return this.queryService.getThreadHistory(session, limit)
  }

  async getThreadHistoryPage(
    userId: string,
    chatId: string,
    options: HistoryReadOptions = {},
  ): Promise<{ project?: ProjectRecord; thread?: ThreadRecord; page: HistoryPage }> {
    const session = await this.ensureSession(userId, chatId)
    return this.queryService.getThreadHistoryPage(session, options)
  }

  async getThreadTurnHistoryPage(
    userId: string,
    chatId: string,
    options: HistoryReadOptions = {},
  ): Promise<{ project?: ProjectRecord; thread?: ThreadRecord; page: HistoryTurnPage }> {
    const session = await this.ensureSession(userId, chatId)
    return this.queryService.getThreadTurnHistoryPage(session, options)
  }

  async getThreadTurnSummaries(
    userId: string,
    chatId: string,
    options: HistoryReadOptions = {},
  ): Promise<{ project?: ProjectRecord; thread?: ThreadRecord; turns: HistoryTurn[]; summaries: string[] }> {
    const session = await this.ensureSession(userId, chatId)
    return this.queryService.getThreadTurnSummaries(session, options)
  }

  async getAgentState(userId: string, chatId: string): Promise<AgentState> {
    const session = await this.ensureSession(userId, chatId)
    return this.queryService.getAgentState(session, (s) =>
      this.listVisibleAgentsForSession(s),
    )
  }

  async searchAgents(
    userId: string,
    chatId: string,
    query: string,
  ): Promise<AgentState> {
    const state = await this.getAgentState(userId, chatId)
    return this.queryService.searchAgents(state, query)
  }

  async getRunState(
    userId: string,
    chatId: string,
    filters: {
      status?: RunDisplayStatus
    } = {},
  ): Promise<RunState> {
    const session = await this.ensureSession(userId, chatId)
    return this.queryService.getRunState(session, filters, (run) =>
      this.getRunDisplayStatus(run),
    )
  }

  async searchRuns(
    userId: string,
    chatId: string,
    query: string,
    filters: {
      status?: RunDisplayStatus
    } = {},
  ): Promise<RunState> {
    const state = await this.getRunState(userId, chatId, filters)
    return this.queryService.searchRuns(state, query)
  }

  async getRunDetails(runId: string): Promise<RunRecord | undefined> {
    return this.queryService.getRunDetails(runId)
  }

  async cancelRun(runId: string): Promise<boolean> {
    await this.ready
    return this.scheduler.cancel(runId, 'Cancelled by user')
  }

  async retryRun(runId: string): Promise<RunRecord> {
    await this.ready
    const replay = this.executionEngine.getRunReplay(runId)
    if (!replay) {
      throw new Error(`Run is not retryable: ${runId}`)
    }

    const run = this.scheduler.getRun(runId)
    if (!run) {
      throw new Error(`Run not found: ${runId}`)
    }

    const handle = this.executionEngine.startThreadRun(
      replay.threadId,
      replay.userId,
      replay.chatId,
      replay.text,
      {
        ...replay.options,
        retryOfRunId: runId,
      },
    )

    return this.scheduler.getRun(handle.runId) ?? {
      context: handle.context,
      status: 'queued',
      queuedAt: new Date().toISOString(),
      retryable: true,
      retryOfRunId: runId,
    }
  }

  async undoLastTurn(
    userId: string,
    chatId: string,
  ): Promise<UndoLastTurnResult> {
    const session = await this.ensureSession(userId, chatId)
    const thread = session.currentThreadId
      ? this.stateStore.getThread(session.currentThreadId)
      : undefined

    if (!thread) {
      throw new Error('No active thread selected')
    }

    const cancel = await this.executionEngine.cancelThreadExecution(thread.id)
    const turn = await this.historyReader.readLastThreadHistoryTurn(thread, {
      includeTools: true,
      includeAgentMessages: true,
    })

    if (!turn || !turn.userEntry) {
      throw new Error('No user turn available to undo')
    }

    try {
      const rewrittenFiles = await this.undoManager.rewriteLastTurnInSource(thread, turn)
      const updatedThread = await this.stateStore.updateThread(thread.id, {
        hiddenHistoryEntryKeys: [],
      })

      return {
        thread: updatedThread,
        turn,
        hiddenEntryCount: turn.entries.length,
        cancel,
        mode: 'rewritten',
        rewrittenFiles,
      }
    } catch {
      // Fall back to local hiding when the rollout source cannot be rewritten.
    }

    const hiddenKeys = new Set(thread.hiddenHistoryEntryKeys ?? [])
    for (const entry of turn.entries) {
      hiddenKeys.add(getHistoryEntryKey(entry))
    }

    const updatedThread = await this.stateStore.updateThread(thread.id, {
      hiddenHistoryEntryKeys: [...hiddenKeys].slice(-500),
    })

    return {
      thread: updatedThread,
      turn,
      hiddenEntryCount: turn.entries.length,
      cancel,
      mode: 'hidden',
    }
  }

  async renameCurrentThread(
    userId: string,
    chatId: string,
    newName: string,
  ): Promise<ThreadRecord> {
    const session = await this.ensureSession(userId, chatId)
    const thread = session.currentThreadId
      ? this.stateStore.getThread(session.currentThreadId)
      : undefined

    if (!thread) {
      throw new Error('No active thread selected')
    }

    return this.threadService.renameThread(thread.id, newName)
  }

  async archiveCurrentThread(
    userId: string,
    chatId: string,
  ): Promise<ThreadRecord> {
    const session = await this.ensureSession(userId, chatId)
    const thread = session.currentThreadId
      ? this.stateStore.getThread(session.currentThreadId)
      : undefined

    if (!thread) {
      throw new Error('No active thread selected')
    }

    const archived = await this.threadService.archiveThread(thread.id)
    const nextThread = session.currentProjectId
      ? this.stateStore.listThreads(session.currentProjectId)[0]
      : undefined

    await this.updateSelection(session, {
      currentThreadId: nextThread?.id,
    })

    return archived
  }

  async deleteCurrentThread(
    userId: string,
    chatId: string,
  ): Promise<ThreadRecord> {
    const session = await this.ensureSession(userId, chatId)
    const thread = session.currentThreadId
      ? this.stateStore.getThread(session.currentThreadId)
      : undefined

    if (!thread) {
      throw new Error('No active thread selected')
    }

    await this.threadService.deleteThread(thread.id)
    const nextThread = session.currentProjectId
      ? this.stateStore.listThreads(session.currentProjectId)[0]
      : undefined

    await this.updateSelection(session, {
      currentThreadId: nextThread?.id,
    })

    return thread
  }

  async pinCurrentThread(
    userId: string,
    chatId: string,
  ): Promise<ThreadRecord> {
    const session = await this.ensureSession(userId, chatId)
    const thread = session.currentThreadId
      ? this.stateStore.getThread(session.currentThreadId)
      : undefined

    if (!thread) {
      throw new Error('No active thread selected')
    }

    return this.threadService.pinThread(thread.id)
  }

  async unpinCurrentThread(
    userId: string,
    chatId: string,
  ): Promise<ThreadRecord> {
    const session = await this.ensureSession(userId, chatId)
    const thread = session.currentThreadId
      ? this.stateStore.getThread(session.currentThreadId)
      : undefined

    if (!thread) {
      throw new Error('No active thread selected')
    }

    return this.threadService.unpinThread(thread.id)
  }

  async getCurrentThreadDetails(
    userId: string,
    chatId: string,
  ): Promise<{ project?: ProjectRecord; thread?: ThreadRecord; source?: SourceRecord }> {
    const session = await this.ensureSession(userId, chatId)
    return this.queryService.getCurrentThreadDetails(session)
  }

  async spawnAgent(
    userId: string,
    chatId: string,
    role: AgentRole,
    task: string,
  ): Promise<AgentRecord> {
    const session = await this.ensureSession(userId, chatId)
    const project = this.getRequiredProject(session)
    const parentThread = await this.getOrCreateActiveThread(session)
    const sourceSelection = selectAgentSource({
      sources: this.stateStore.listSources({ includeDisabled: true }),
      parentThreadSourceId: parentThread.sourceId,
      projectDefaultSourceId: project.defaultSourceId,
      projectSourceMode: project.sourceMode,
      parentSourceOverrideMode: project.agentSourceOverrideMode,
    })

    if (!sourceSelection.source) {
      throw new Error('No available source for agent')
    }

    return this.agentManager.spawn({
      userId,
      chatId,
      parentThread,
      project,
      source: sourceSelection.source,
      role,
      task,
    })
  }

  async cancelAgent(
    userId: string,
    chatId: string,
    reference: string,
  ): Promise<{ agent: AgentRecord; cancel: CancelResult }> {
    const session = await this.ensureSession(userId, chatId)
    const agent = this.resolveAgentReference(session, reference)
    if (!agent) {
      throw new Error(`Agent not found: ${reference}`)
    }

    return this.agentManager.cancel(agent.id)
  }

  async getAgentDetails(
    userId: string,
    chatId: string,
    reference: string,
  ): Promise<AgentDetails | undefined> {
    const session = await this.ensureSession(userId, chatId)
    const agent = this.resolveAgentReference(session, reference)
    if (!agent) {
      return undefined
    }

    return this.queryService.getAgentDetails(agent)
  }

  async applyAgentWriteback(
    userId: string,
    chatId: string,
    reference: string,
  ): Promise<{
    agent: import('./agent-manager.js').AgentSnapshot
    parentThread: ThreadRecord
    run: RunRecord
  }> {
    const session = await this.ensureSession(userId, chatId)
    const agent = this.resolveAgentReference(session, reference)
    if (!agent) {
      throw new Error(`Agent not found: ${reference}`)
    }

    if (agent.writebackRunId) {
      throw new Error(`Agent writeback already enqueued: ${agent.writebackRunId}`)
    }

    const snapshot = this.agentManager.query(agent.id)
    if (!snapshot) {
      throw new Error(`Agent snapshot unavailable: ${reference}`)
    }

    const payload = this.agentManager.prepareWriteback(agent.id)
    if (payload?.mode !== 'apply_result' || !payload.available) {
      throw new Error(`Agent is not ready for writeback: ${payload?.summary ?? snapshot.writeback.summary}`)
    }

    const parentThread = this.stateStore.getThread(snapshot.relation.parentThreadId)
    if (!parentThread) {
      throw new Error(`Parent thread not found: ${snapshot.relation.parentThreadId}`)
    }

    const prompt = await this.undoManager.buildAgentWritebackPrompt(snapshot)
    if (!prompt) {
      throw new Error(`Agent writeback result is unavailable: ${agent.id}`)
    }

    const handle = this.executionEngine.startThreadRun(
      parentThread.id,
      userId,
      chatId,
      prompt,
      {
        outputPrefix: `[agent ${agent.id} writeback]`,
      },
    )

    const run = this.scheduler.getRun(handle.runId)
    if (!run) {
      throw new Error(`Failed to enqueue writeback run for agent: ${agent.id}`)
    }

    await this.stateStore.updateAgent(agent.id, {
      writebackRunId: run.context.runId,
    })
    this.executionEngine.trackWritebackRun(run.context.runId, agent.id)

    return {
      agent: snapshot,
      parentThread,
      run,
    }
  }

  async moveCurrentThread(
    userId: string,
    chatId: string,
    projectReference: string,
  ): Promise<{ thread: ThreadRecord; project: ProjectRecord }> {
    const session = await this.ensureSession(userId, chatId)
    const thread = session.currentThreadId
      ? this.stateStore.getThread(session.currentThreadId)
      : undefined

    if (!thread) {
      throw new Error('No active thread selected')
    }

    const project = this.resolveProjectReference(projectReference)
    if (!project) {
      throw new Error(`Unknown project: ${projectReference}`)
    }

    const updatedThread = await this.threadService.moveThread(thread.id, project.id)

    await this.updateSelection(session, {
      currentProjectId: project.id,
      currentThreadId: updatedThread.id,
    })

    return { thread: updatedThread, project }
  }

  async createThread(userId: string, chatId: string): Promise<{ session: Session; codexThreadId?: string }> {
    const session = await this.ensureSession(userId, chatId)
    const project = this.getRequiredProject(session)

    const thread = await this.threadService.createThread(
      project.id,
      project.defaultSourceId,
      project.cwd,
    )

    let codexThreadId: string | undefined
    // If app-server is connected, also create a server-side thread and link it
    if (this.appServerClient?.connected) {
      try {
        const codexThread = await this.appServerClient.threadStart({
          cwd: project.cwd,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
        })
        codexThreadId = codexThread.id
        await this.stateStore.updateThread(thread.id, {
          codexThreadId: codexThread.id,
          updatedAt: new Date().toISOString(),
        })
        // Write a minimal rollout file so `codex resume <id>` can find this session
        // Fire-and-forget: this is an optimization for codex CLI session import, not needed before returning
        writeBootstrapRollout(this.sharedCodexHome, codexThread.id, project.cwd).catch(err =>
          console.error('[session] bootstrap rollout write failed:', err)
        )
      } catch (err) {
        console.error('[session] failed to create server-side thread:', err)
      }
    }

    await this.updateSelection(session, {
      currentProjectId: project.id,
      currentThreadId: thread.id,
    })

    return { session, codexThreadId }
  }

  async switchThread(
    userId: string,
    chatId: string,
    reference: string,
  ): Promise<{ thread: ThreadRecord; added: boolean; projectChanged: boolean }> {
    const session = await this.ensureSession(userId, chatId)
    const currentProject = this.getRequiredProject(session)
    const normalizedReference = reference.trim()

    if (!normalizedReference) {
      throw new Error('Thread reference is required')
    }

    const result = await this.threadService.resolveThread(normalizedReference, currentProject)
    if (!result) {
      throw new Error(`Unknown thread: ${reference}`)
    }

    const { thread, added } = result
    const projectChanged = thread.projectId !== currentProject.id

    await this.updateSelection(session, {
      currentProjectId: thread.projectId,
      currentThreadId: thread.id,
    })

    return { thread, added, projectChanged }
  }

  async sendInput(userId: string, chatId: string, text: string): Promise<void> {
    const session = await this.ensureSession(userId, chatId)
    const thread = await this.getOrCreateActiveThread(session)
    const blockingRun = this.executionEngine.getBlockingRun(thread.id)

    if (blockingRun) {
      if (blockingRun.status === 'running') {
        throw new Error(
          'Thread busy: 当前 thread 还有一条运行中的请求，可能正在等待你的授权批准。请检查上方是否有 🔐 授权按钮，或用 /cancel 中断。',
        )
      }
      throw new Error(
        'Thread busy: 当前 thread 还有一条排队中的请求。请稍后再发，或用 /run list 查看状态。',
      )
    }

    if (thread.status === 'running') {
      await this.stateStore.updateThread(thread.id, {
        status: 'idle',
        updatedAt: new Date().toISOString(),
      })
    }

    session.lastActive = Date.now()

    void this.executionEngine
      .enqueueThreadRun(thread.id, session.userId, session.chatId, text)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[session] enqueueThreadRun rejected:', message)
        void this.onOutput(
          session.userId,
          session.chatId,
          `❌ 执行失败: ${message}`,
        )
      })
  }

  async cancelCurrentExecution(
    userId: string,
    chatId: string,
  ): Promise<CancelResult> {
    const session = await this.ensureSession(userId, chatId)
    const thread = session.currentThreadId
      ? this.stateStore.getThread(session.currentThreadId)
      : undefined

    if (!thread) {
      return {
        hadThread: false,
        killedRunning: false,
        clearedQueued: false,
      }
    }

    return this.executionEngine.cancelThreadExecution(thread.id)
  }

  async cancelThreadExecution(threadId: string): Promise<CancelResult> {
    return this.executionEngine.cancelThreadExecution(threadId)
  }

  kill(userId: string, chatId: string): void {
    void this.cancelCurrentExecution(userId, chatId)
  }

  reset(userId: string, chatId: string): Session {
    this.kill(userId, chatId)
    const key = getSessionKey(userId, chatId)
    const session = this.sessions.get(key)

    if (session) {
      session.currentThreadId = undefined
      session.lastActive = Date.now()
    }

    return session ?? {
      userId,
      chatId,
      cwd: this.cwd,
      lastActive: Date.now(),
    }
  }

  killAll(): void {
    this.executionEngine.killAll()
    this.sessions.clear()
  }

  /**
   * Find the chatId associated with a codex thread ID.
   * Checks active sessions' current threads first, then searches all threads in the DB.
   */
  findChatByCodexThreadId(codexThreadId: string): string | undefined {
    // Fast path: check active sessions' current thread
    for (const session of this.sessions.values()) {
      if (!session.currentThreadId) continue
      const thread = this.stateStore.getThread(session.currentThreadId)
      if (thread?.codexThreadId === codexThreadId) {
        return session.chatId
      }
    }
    // Slow path: search ALL threads for matching codexThreadId → find owning session
    const allThreads = this.stateStore.listThreads(undefined, { includeArchived: true })
    const match = allThreads.find((t) => t.codexThreadId === codexThreadId)
    if (!match) return undefined
    for (const session of this.sessions.values()) {
      if (session.currentProjectId === match.projectId) {
        return session.chatId
      }
    }
    return undefined
  }

  /**
   * Import a thread created by an external client (e.g. connect.ts) into the bot's database.
   * Associates it with the given chatId and makes it the current thread.
   */
  async importExternalThread(chatId: string, codexThreadId: string, cwd: string): Promise<void> {
    const session = await this.ensureSession(chatId, chatId)
    const project = this.getRequiredProject(session)

    const thread = await this.threadService.createThread(
      project.id,
      project.defaultSourceId,
      cwd,
    )

    await this.stateStore.updateThread(thread.id, {
      codexThreadId,
      updatedAt: new Date().toISOString(),
    })

    await this.updateSelection(session, {
      currentProjectId: project.id,
      currentThreadId: thread.id,
    })
  }

  cleanup(maxIdleMs = this.sessionTimeoutMs): number {
    const now = Date.now()
    let cleaned = 0

    for (const [key, session] of this.sessions) {
      if (now - session.lastActive > maxIdleMs) {
        if (session.currentThreadId) {
          void this.executionEngine.cancelThreadExecution(session.currentThreadId)
        }

        this.sessions.delete(key)
        cleaned += 1
      }
    }

    return cleaned
  }

  private async initialize(): Promise<void> {
    await mkdir(BOT_STATE_DIR, { recursive: true })
    await mkdir(BOT_TMP_DIR, { recursive: true })
    await this.ensureBotCodexHome()
    await this.stateStore.init(this.cwd)
    await this.importer.syncEnabledSources()
  }

  private async ensureSession(userId: string, chatId: string): Promise<Session> {
    await this.ready

    const key = getSessionKey(userId, chatId)
    const existing = this.sessions.get(key)
    const selection = this.normalizeSelection(this.stateStore.getSelection(key))
    const currentProject =
      (selection.currentProjectId
        ? this.stateStore.getProject(selection.currentProjectId)
        : undefined) ??
      (await this.findProjectForCwd(this.cwd)) ??
      this.stateStore.listProjects()[0]
    const fallbackThread = currentProject
      ? this.stateStore.listThreads(currentProject.id)[0]
      : undefined
    const currentThread =
      selection.currentThreadId && currentProject
        ? this.stateStore.getThread(selection.currentThreadId)
        : undefined

    if (existing) {
      existing.currentProjectId = currentProject?.id
      existing.currentThreadId =
        currentThread?.projectId === currentProject?.id
          ? currentThread.id
          : fallbackThread?.id
      existing.cwd = currentProject?.cwd ?? existing.cwd
      existing.lastActive = Date.now()
      await this.ensureSelectionPersisted(key, currentProject, existing.currentThreadId)
      return existing
    }

    const threadId =
      currentThread?.projectId === currentProject?.id
        ? currentThread.id
        : fallbackThread?.id
    const session: Session = {
      userId,
      chatId,
      cwd: currentProject?.cwd ?? this.cwd,
      lastActive: Date.now(),
      currentProjectId: currentProject?.id,
      currentThreadId: threadId,
    }

    this.sessions.set(key, session)
    await this.ensureSelectionPersisted(key, currentProject, threadId)
    return session
  }

  private normalizeSelection(selection: SelectionRecord): SelectionRecord {
    const currentProject =
      selection.currentProjectId &&
      this.stateStore.getProject(selection.currentProjectId)
        ? selection.currentProjectId
        : undefined
    const currentThread =
      selection.currentThreadId &&
      this.stateStore.getThread(selection.currentThreadId)
        ? selection.currentThreadId
        : undefined

    return {
      currentProjectId: currentProject,
      currentThreadId: currentThread,
    }
  }

  private async ensureSelectionPersisted(
    sessionKey: string,
    project: ProjectRecord | undefined,
    threadId: string | undefined,
  ): Promise<void> {
    const current = this.stateStore.getSelection(sessionKey)

    if (
      current.currentProjectId === project?.id &&
      current.currentThreadId === threadId
    ) {
      return
    }

    await this.stateStore.setSelection(sessionKey, {
      currentProjectId: project?.id,
      currentThreadId: threadId,
    })
  }

  private getRequiredProject(session: Session): ProjectRecord {
    const project =
      session.currentProjectId &&
      this.stateStore.getProject(session.currentProjectId)

    if (!project) {
      throw new Error('No active project selected')
    }

    return project
  }

  private async getOrCreateActiveThread(session: Session): Promise<ThreadRecord> {
    const existing =
      session.currentThreadId && this.stateStore.getThread(session.currentThreadId)

    if (existing) {
      return existing
    }

    const project = this.getRequiredProject(session)
    const thread = await this.threadService.getOrCreateActiveThread(
      project.id,
      project.defaultSourceId,
      project.cwd,
      session.currentThreadId ?? undefined,
    )

    await this.updateSelection(session, {
      currentProjectId: project.id,
      currentThreadId: thread.id,
    })

    return thread
  }

  private async updateSelection(
    session: Session,
    patch: Partial<SelectionRecord>,
  ): Promise<void> {
    const projectId = patch.currentProjectId ?? session.currentProjectId
    const project = projectId ? this.stateStore.getProject(projectId) : undefined
    const nextSelection = await this.stateStore.setSelection(
      getSessionKey(session.userId, session.chatId),
      patch,
    )

    session.currentProjectId = nextSelection.currentProjectId
    session.currentThreadId = nextSelection.currentThreadId
    session.cwd = project?.cwd ?? this.cwd
    session.lastActive = Date.now()
  }

  async enqueueThreadRun(
    threadId: string,
    userId: string,
    chatId: string,
    text: string,
    options: StoredRunReplayOptions = {},
  ): Promise<ThreadRunResult> {
    return this.executionEngine.enqueueThreadRun(threadId, userId, chatId, text, options)
  }

  private async findProjectForCwd(cwd: string): Promise<ProjectRecord | undefined> {
    const identity = await resolveProjectIdentity(cwd)
    return this.stateStore.findProjectByProjectKey(identity.projectKey)
  }

  private resolveProjectReference(reference: string): ProjectRecord | undefined {
    return this.projectService.resolveProjectReference(reference)
  }

  private resolveAgentReference(
    session: Session,
    reference: string,
  ): AgentRecord | undefined {
    const normalizedReference = reference.trim()

    if (!normalizedReference) {
      return undefined
    }

    if (/^\d+$/.test(normalizedReference)) {
      const visibleAgents = this.listVisibleAgentsForSession(session)
      const index = Number.parseInt(normalizedReference, 10) - 1
      return visibleAgents[index]
    }

    return this.stateStore.listAgents().find(
      (agent) =>
        agent.id === normalizedReference || agent.threadId === normalizedReference,
    )
  }

  private listVisibleAgentsForSession(session: Session): AgentRecord[] {
    const parentThread = session.currentThreadId
      ? this.stateStore.getThread(session.currentThreadId)
      : undefined
    const project = session.currentProjectId
      ? this.stateStore.getProject(session.currentProjectId)
      : undefined

    return parentThread
      ? this.agentManager.listAgents(project?.id, parentThread.id)
      : []
  }

  getRunDisplayStatus(run: RunRecord): RunDisplayStatus {
    return run.status === 'failed' && run.failureKind === 'waiting_approval'
      ? 'waiting_approval'
      : run.status
  }

  private async ensureBotCodexHome(): Promise<void> {
    await mkdir(this.botCodexHome, { recursive: true })

    for (const item of SHARED_CODEX_HOME_ITEMS) {
      await this.ensureSharedItemLink(item)
    }
  }

  private async ensureSharedItemLink(item: string): Promise<void> {
    const source = join(this.sharedCodexHome, item)

    if (!(await pathExists(source))) {
      return
    }

    const target = join(this.botCodexHome, item)

    try {
      const existing = await lstat(target)

      if (existing.isSymbolicLink()) {
        return
      }

      await rm(target, { recursive: true, force: true })
    } catch {
      // Target does not exist yet.
    }

    const sourceStats = await lstat(source)
    const symlinkType = sourceStats.isDirectory() ? 'dir' : 'file'
    await symlink(source, target, symlinkType)
  }
}
