import { AgentManager, type AgentSnapshot } from '../../agent-manager.js'
import {
  HistoryReader,
  summarizeHistoryTurn,
  type HistoryEntry,
  type HistoryPage,
  type HistoryReadOptions,
  type HistoryTurn,
  type HistoryTurnPage,
} from '../../history-reader.js'
import {
  Importer,
  type ImportPendingSource,
  type ImportSourceSyncStatus,
  type ImportSyncOptions,
} from '../../importer.js'
import type {
  AgentRecord,
  ProjectRecord,
  SourceRecord,
  ThreadRecord,
} from '../../models.js'
import {
  RunScheduler,
  type RunRecord,
} from '../../run-scheduler.js'
import { StateStore, type OrderedListLocation } from '../../state-store.js'

import type {
  AgentDetails,
  AgentState,
  ImportStatusState,
  ProjectDetails,
  ProjectSearchState,
  ProjectState,
  RunDisplayStatus,
  RunState,
  Session,
  SourceEntry,
  SourceState,
  SourceSyncDetails,
  ThreadSearchState,
  ThreadState,
} from '../../session-manager.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeListLocationPageSize(pageSize = 10): number {
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    return 10
  }

  return Math.max(1, Math.floor(pageSize))
}

function buildListLocation<T extends { id: string }>(
  items: T[],
  itemId: string | undefined,
  pageSize = 10,
): OrderedListLocation | undefined {
  if (!itemId) {
    return undefined
  }

  const index = items.findIndex((item) => item.id === itemId)
  if (index < 0) {
    return undefined
  }

  const normalizedPageSize = normalizeListLocationPageSize(pageSize)
  return {
    index,
    ordinal: index + 1,
    page: Math.floor(index / normalizedPageSize) + 1,
    pageIndex: index % normalizedPageSize,
    pageSize: normalizedPageSize,
    pageCount: Math.max(
      1,
      Math.ceil(items.length / normalizedPageSize),
    ),
    total: items.length,
  }
}

// ---------------------------------------------------------------------------
// QueryService
// ---------------------------------------------------------------------------

export class QueryService {
  constructor(
    private readonly stateStore: StateStore,
    private readonly historyReader: HistoryReader,
    private readonly importer: Importer,
    private readonly scheduler: RunScheduler,
    private readonly agentManager: AgentManager,
    private readonly ready: Promise<void>,
  ) {}

  // -- helpers exposed so SessionManager can keep using them ----------------

  buildSourceEntries(): SourceEntry[] {
    return this.stateStore
      .listSources({ includeDisabled: true })
      .map((source) => ({
        source,
        projectCount: this.stateStore
          .listProjects({ includeArchived: true })
          .filter((project) => project.defaultSourceId === source.id).length,
        threadCount: this.stateStore.listThreadsBySource(source.id).length,
        agentCount: this.stateStore
          .listAgents()
          .filter((agent) => agent.sourceId === source.id).length,
      }))
  }

  buildSourceEntry(sourceId: string): SourceEntry | undefined {
    return this.buildSourceEntries().find(
      (entry) => entry.source.id === sourceId,
    )
  }

  // -- project queries ------------------------------------------------------

  getProjectState(
    session: Session,
    options: { includeArchived?: boolean; pageSize?: number } = {},
  ): ProjectState {
    const currentProject = session.currentProjectId
      ? this.stateStore.getProject(session.currentProjectId)
      : undefined
    const projects = this.stateStore.listProjects({
      includeArchived: options.includeArchived,
    })

    return {
      currentProject,
      projects,
      currentProjectLocation: currentProject
        ? this.stateStore.getProjectListLocation(currentProject.id, {
            includeArchived: options.includeArchived,
            pageSize: options.pageSize,
          })
        : undefined,
    }
  }

  searchProjects(
    session: Session,
    query: string,
    options: { pageSize?: number } = {},
  ): ProjectSearchState {
    const currentProject = session.currentProjectId
      ? this.stateStore.getProject(session.currentProjectId)
      : undefined
    const projects = this.stateStore.searchProjects(query, {
      includeArchived: true,
    })

    return {
      currentProject,
      projects,
      query,
      currentProjectLocation: buildListLocation(
        projects,
        currentProject?.id,
        options.pageSize,
      ),
    }
  }

  getProjectDetails(session: Session): ProjectDetails {
    const project = session.currentProjectId
      ? this.stateStore.getProject(session.currentProjectId)
      : undefined
    const currentThread = session.currentThreadId
      ? this.stateStore.getThread(session.currentThreadId)
      : undefined

    return {
      project,
      defaultSource: project
        ? this.stateStore.getSource(project.defaultSourceId)
        : undefined,
      threadCount: project
        ? this.stateStore.listThreads(project.id).length
        : 0,
      originatorCounts: project
        ? this.stateStore.getThreadOriginatorCounts(project.id)
        : undefined,
      currentThread,
      sources: this.stateStore.listSources(),
    }
  }

  // -- source queries -------------------------------------------------------

  async getSourceState(): Promise<SourceState> {
    await this.ready
    return { sources: this.buildSourceEntries() }
  }

  async searchSources(query: string): Promise<SourceState> {
    await this.ready
    const normalizedQuery = query.trim().toLowerCase()
    const sources = this.buildSourceEntries().filter(
      (entry) =>
        entry.source.id.toLowerCase().includes(normalizedQuery) ||
        entry.source.name.toLowerCase().includes(normalizedQuery) ||
        entry.source.codexHome.toLowerCase().includes(normalizedQuery),
    )
    return {
      sources,
      query,
    }
  }

  async getSourceDetails(
    sourceId: string,
  ): Promise<SourceEntry | undefined> {
    await this.ready
    return this.buildSourceEntry(sourceId)
  }

  // -- import status --------------------------------------------------------

  async getImportStatus(
    options: Omit<ImportSyncOptions, 'onlyIfChanged'> = {},
  ): Promise<ImportStatusState> {
    await this.ready
    const sync = await this.importer.getSyncStatus(options)
    const statusBySource = new Map(
      sync.sources.map(
        (source) => [source.sourceId, source] as const,
      ),
    )

    return {
      sync,
      pending: sync.sources
        .map((source) => source.pending)
        .filter(
          (pending): pending is ImportPendingSource => Boolean(pending),
        ),
      sources: this.buildSourceEntries()
        .filter((source) => statusBySource.has(source.source.id))
        .map((source) => ({
          ...source,
          importStatus: statusBySource.get(source.source.id)!,
        })),
    }
  }

  async getSourceImportStatus(
    sourceId: string,
    options: Omit<ImportSyncOptions, 'onlyIfChanged' | 'sourceIds'> = {},
  ): Promise<SourceSyncDetails | undefined> {
    await this.ready
    const base = await this.getSourceDetails(sourceId)
    if (!base) {
      return undefined
    }

    const importStatus = await this.importer.getSourceSyncStatus(
      sourceId,
      options,
    )
    if (!importStatus) {
      return undefined
    }

    return {
      ...base,
      importStatus,
    }
  }

  // -- list-location helpers ------------------------------------------------

  getCurrentProjectListLocation(
    session: Session,
    options: { includeArchived?: boolean; pageSize?: number } = {},
  ): OrderedListLocation | undefined {
    if (!session.currentProjectId) {
      return undefined
    }

    return this.stateStore.getProjectListLocation(
      session.currentProjectId,
      options,
    )
  }

  getCurrentThreadListLocation(
    session: Session,
    options: { includeArchived?: boolean; pageSize?: number } = {},
  ): OrderedListLocation | undefined {
    if (!session.currentThreadId) {
      return undefined
    }

    return this.stateStore.getThreadListLocation(session.currentThreadId, {
      projectId: session.currentProjectId,
      includeArchived: options.includeArchived,
      pageSize: options.pageSize,
    })
  }

  // -- thread queries -------------------------------------------------------

  getThreadState(
    session: Session,
    options: { includeArchived?: boolean; pageSize?: number } = {},
  ): ThreadState {
    const currentProject = session.currentProjectId
      ? this.stateStore.getProject(session.currentProjectId)
      : undefined
    const threads = currentProject
      ? this.stateStore.listThreads(currentProject.id, {
          includeArchived: options.includeArchived,
        })
      : []
    const currentThread = session.currentThreadId
      ? this.stateStore.getThread(session.currentThreadId)
      : undefined

    return {
      currentProject,
      currentThread,
      threads,
      currentThreadLocation: currentThread
        ? this.stateStore.getThreadListLocation(currentThread.id, {
            projectId: currentProject?.id,
            includeArchived: options.includeArchived,
            pageSize: options.pageSize,
          })
        : undefined,
    }
  }

  searchThreads(
    session: Session,
    query: string,
    options: { pageSize?: number } = {},
  ): ThreadSearchState {
    const currentProject = session.currentProjectId
      ? this.stateStore.getProject(session.currentProjectId)
      : undefined
    const currentThread = session.currentThreadId
      ? this.stateStore.getThread(session.currentThreadId)
      : undefined
    const threads = this.stateStore.searchThreads(
      query,
      currentProject?.id,
      { includeArchived: true },
    )

    return {
      currentProject,
      currentThread,
      threads,
      query,
      currentThreadLocation: buildListLocation(
        threads,
        currentThread?.id,
        options.pageSize,
      ),
    }
  }

  async getThreadHistory(
    session: Session,
    limit = 10,
  ): Promise<{
    project?: ProjectRecord
    thread?: ThreadRecord
    entries: HistoryEntry[]
  }> {
    const thread = session.currentThreadId
      ? this.stateStore.getThread(session.currentThreadId)
      : undefined
    const project = session.currentProjectId
      ? this.stateStore.getProject(session.currentProjectId)
      : undefined

    if (!thread) {
      return { project, thread: undefined, entries: [] }
    }

    const entries = await this.historyReader.readThreadHistory(
      thread,
      limit,
    )
    return { project, thread, entries }
  }

  async getThreadHistoryPage(
    session: Session,
    options: HistoryReadOptions = {},
  ): Promise<{
    project?: ProjectRecord
    thread?: ThreadRecord
    page: HistoryPage
  }> {
    const thread = session.currentThreadId
      ? this.stateStore.getThread(session.currentThreadId)
      : undefined
    const project = session.currentProjectId
      ? this.stateStore.getProject(session.currentProjectId)
      : undefined

    if (!thread) {
      return {
        project,
        thread: undefined,
        page: {
          entries: [],
          limit: options.limit ?? 10,
          hasMore: false,
          total: 0,
        },
      }
    }

    const page = await this.historyReader.readThreadHistoryPage(
      thread,
      options,
    )
    return { project, thread, page }
  }

  async getThreadTurnHistoryPage(
    session: Session,
    options: HistoryReadOptions = {},
  ): Promise<{
    project?: ProjectRecord
    thread?: ThreadRecord
    page: HistoryTurnPage
  }> {
    const thread = session.currentThreadId
      ? this.stateStore.getThread(session.currentThreadId)
      : undefined
    const project = session.currentProjectId
      ? this.stateStore.getProject(session.currentProjectId)
      : undefined

    if (!thread) {
      return {
        project,
        thread: undefined,
        page: {
          turns: [],
          limit: options.limit ?? 10,
          hasMore: false,
          total: 0,
        },
      }
    }

    const page = await this.historyReader.readThreadHistoryTurnPage(
      thread,
      options,
    )
    return { project, thread, page }
  }

  async getThreadTurnSummaries(
    session: Session,
    options: HistoryReadOptions = {},
  ): Promise<{
    project?: ProjectRecord
    thread?: ThreadRecord
    turns: HistoryTurn[]
    summaries: string[]
  }> {
    const { project, thread, page } =
      await this.getThreadTurnHistoryPage(session, options)

    return {
      project,
      thread,
      turns: page.turns,
      summaries: page.turns.map((turn) =>
        summarizeHistoryTurn(turn, {
          includeTimestamp: true,
          includeCounts: true,
        }),
      ),
    }
  }

  // -- thread details -------------------------------------------------------

  getCurrentThreadDetails(
    session: Session,
  ): {
    project?: ProjectRecord
    thread?: ThreadRecord
    source?: SourceRecord
  } {
    const thread = session.currentThreadId
      ? this.stateStore.getThread(session.currentThreadId)
      : undefined
    const project = session.currentProjectId
      ? this.stateStore.getProject(session.currentProjectId)
      : undefined
    const source = thread
      ? this.stateStore.getSource(thread.sourceId)
      : undefined

    return { project, thread, source }
  }

  // -- agent queries --------------------------------------------------------

  getAgentState(
    session: Session,
    listVisibleAgents: (session: Session) => AgentRecord[],
  ): AgentState {
    const parentThread = session.currentThreadId
      ? this.stateStore.getThread(session.currentThreadId)
      : undefined
    const project = session.currentProjectId
      ? this.stateStore.getProject(session.currentProjectId)
      : undefined

    return {
      project,
      parentThread,
      agents: listVisibleAgents(session),
    }
  }

  searchAgents(
    state: AgentState,
    query: string,
  ): AgentState {
    const normalizedQuery = query.trim().toLowerCase()
    return {
      ...state,
      agents: state.agents.filter(
        (agent) =>
          agent.id.toLowerCase().includes(normalizedQuery) ||
          agent.threadId.toLowerCase().includes(normalizedQuery) ||
          agent.role.toLowerCase().includes(normalizedQuery) ||
          agent.task.toLowerCase().includes(normalizedQuery),
      ),
      query,
    }
  }

  getAgentDetails(
    agent: AgentRecord,
  ): AgentDetails | undefined {
    const snapshot = this.agentManager.query(agent.id)
    if (!snapshot) {
      return undefined
    }

    return {
      agent: snapshot,
      parentThread: this.stateStore.getThread(
        snapshot.relation.parentThreadId,
      ),
      childThread: this.stateStore.getThread(
        snapshot.relation.childThreadId,
      ),
      project: this.stateStore.getProject(agent.projectId),
      writebackRun: agent.writebackRunId
        ? this.scheduler.getRun(agent.writebackRunId)
        : undefined,
    }
  }

  // -- run queries ----------------------------------------------------------

  getRunState(
    session: Session,
    filters: { status?: RunDisplayStatus } = {},
    getRunDisplayStatus: (run: RunRecord) => RunDisplayStatus,
  ): RunState {
    const project = session.currentProjectId
      ? this.stateStore.getProject(session.currentProjectId)
      : undefined
    const thread = session.currentThreadId
      ? this.stateStore.getThread(session.currentThreadId)
      : undefined

    const runs = this.scheduler.listRuns({
      projectId: project?.id,
      threadId: thread?.id,
    })

    return {
      project,
      thread,
      runs: runs.filter((run) =>
        filters.status
          ? getRunDisplayStatus(run) === filters.status
          : true,
      ),
    }
  }

  searchRuns(
    state: RunState,
    query: string,
  ): RunState {
    const normalizedQuery = query.trim().toLowerCase()
    return {
      ...state,
      runs: state.runs.filter(
        (run) =>
          run.context.runId.toLowerCase().includes(normalizedQuery) ||
          run.context.threadId
            .toLowerCase()
            .includes(normalizedQuery) ||
          run.context.projectId
            .toLowerCase()
            .includes(normalizedQuery) ||
          run.context.agentId
            ?.toLowerCase()
            .includes(normalizedQuery) ||
          run.context.label
            ?.toLowerCase()
            .includes(normalizedQuery) ||
          run.retryOfRunId
            ?.toLowerCase()
            .includes(normalizedQuery) ||
          run.error?.toLowerCase().includes(normalizedQuery),
      ),
      query,
    }
  }

  async getRunDetails(
    runId: string,
  ): Promise<RunRecord | undefined> {
    await this.ready
    return this.scheduler.getRun(runId)
  }

  // -- cwd helper -----------------------------------------------------------

  getCurrentCwd(session: Session): string {
    return session.cwd
  }
}
