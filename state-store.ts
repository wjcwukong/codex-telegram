import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import type Database from 'better-sqlite3'

import type {
  AgentParentSourceOverrideMode,
  AgentRecord,
  AgentStatus,
  ProjectSourceMode,
  ProjectRecord,
  SelectionRecord,
  SourceRecord,
  ThreadRecord,
  ThreadStatus,
} from './models.js'
import { resolveProjectIdentity } from './project-normalizer.js'
import { openDatabase } from './src/data/database.js'
import { SourceRepository } from './src/data/repositories/source-repo.js'
import { ProjectRepository } from './src/data/repositories/project-repo.js'
import { ThreadRepository } from './src/data/repositories/thread-repo.js'
import { AgentRepository } from './src/data/repositories/agent-repo.js'
import { SelectionRepository } from './src/data/repositories/selection-repo.js'

const DEFAULT_SHARED_CODEX_HOME = join(homedir(), '.codex')
const DEFAULT_BOT_CODEX_HOME = join(homedir(), '.codex-telegram', 'codex-home')

// ---------------------------------------------------------------------------
// Singleton database
// ---------------------------------------------------------------------------

let sharedDb: Database.Database | undefined

export function getDatabase(): Database.Database {
  if (!sharedDb) {
    sharedDb = openDatabase()
  }
  return sharedDb
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString()
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export interface OrderedListLocation {
  index: number
  ordinal: number
  page: number
  pageIndex: number
  pageSize: number
  pageCount: number
  total: number
}

function compareOptionalTimestampDesc(left?: string, right?: string): number {
  if (left && right) {
    return right.localeCompare(left)
  }

  if (left) {
    return -1
  }

  if (right) {
    return 1
  }

  return 0
}

function compareOptionalStringAsc(left?: string, right?: string): number {
  if (left && right) {
    return left.localeCompare(right)
  }

  if (left) {
    return -1
  }

  if (right) {
    return 1
  }

  return 0
}

function normalizeLocationPageSize(pageSize = 10): number {
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    return 10
  }

  return Math.max(1, Math.floor(pageSize))
}

function buildOrderedListLocation<T extends { id: string }>(
  items: T[],
  itemId: string,
  pageSize = 10,
): OrderedListLocation | undefined {
  const index = items.findIndex((item) => item.id === itemId)
  if (index < 0) {
    return undefined
  }

  const normalizedPageSize = normalizeLocationPageSize(pageSize)
  return {
    index,
    ordinal: index + 1,
    page: Math.floor(index / normalizedPageSize) + 1,
    pageIndex: index % normalizedPageSize,
    pageSize: normalizedPageSize,
    pageCount: Math.max(1, Math.ceil(items.length / normalizedPageSize)),
    total: items.length,
  }
}

function compareProjects(left: ProjectRecord, right: ProjectRecord): number {
  if (left.archivedAt && !right.archivedAt) {
    return 1
  }

  if (!left.archivedAt && right.archivedAt) {
    return -1
  }

  return (
    left.name.localeCompare(right.name) ||
    left.cwd.localeCompare(right.cwd) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  )
}

function compareThreads(left: ThreadRecord, right: ThreadRecord): number {
  if (left.archivedAt && !right.archivedAt) {
    return 1
  }

  if (!left.archivedAt && right.archivedAt) {
    return -1
  }

  if (left.pinnedAt && !right.pinnedAt) {
    return -1
  }

  if (!left.pinnedAt && right.pinnedAt) {
    return 1
  }

  return (
    compareOptionalTimestampDesc(left.pinnedAt, right.pinnedAt) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    right.createdAt.localeCompare(left.createdAt) ||
    left.title.localeCompare(right.title) ||
    compareOptionalStringAsc(left.codexThreadId, right.codexThreadId) ||
    left.id.localeCompare(right.id)
  )
}

function compareAgents(left: AgentRecord, right: AgentRecord): number {
  return (
    right.updatedAt.localeCompare(left.updatedAt) ||
    right.createdAt.localeCompare(left.createdAt) ||
    left.id.localeCompare(right.id)
  )
}

function normalizeProjectSourceMode(value: unknown): ProjectSourceMode {
  return value === 'prefer' || value === 'force' ? value : 'policy-default'
}

function normalizeAgentParentSourceOverrideMode(
  value: unknown,
): AgentParentSourceOverrideMode {
  return value === 'allow' || value === 'deny' ? value : 'policy-default'
}

// ---------------------------------------------------------------------------
// StateStore — SQLite-backed facade
// ---------------------------------------------------------------------------

export class StateStore {
  private db!: Database.Database
  private sourceRepo!: SourceRepository
  private projectRepo!: ProjectRepository
  private threadRepo!: ThreadRepository
  private agentRepo!: AgentRepository
  private selectionRepo!: SelectionRepository

  constructor(_options: { stateRoot?: string; stateFile?: string } = {}) {
    // options kept for API compat but no longer used
  }

  async init(defaultCwd: string): Promise<void> {
    this.db = getDatabase()
    this.sourceRepo = new SourceRepository(this.db)
    this.projectRepo = new ProjectRepository(this.db)
    this.threadRepo = new ThreadRepository(this.db)
    this.agentRepo = new AgentRepository(this.db)
    this.selectionRepo = new SelectionRepository(this.db)

    this.ensureDefaultSources()
    await this.normalizeProjects()
    await this.ensureProjectForCwd(defaultCwd, 'shared')
  }

  // ── Sources ────────────────────────────────────────────────────────────

  listSources(options: { includeDisabled?: boolean } = {}): SourceRecord[] {
    return this.sourceRepo.listSources(options)
  }

  getSource(sourceId: string): SourceRecord | undefined {
    return this.sourceRepo.getSource(sourceId)
  }

  async updateSource(
    sourceId: string,
    patch: Partial<SourceRecord>,
  ): Promise<SourceRecord> {
    return this.sourceRepo.updateSource(sourceId, patch)
  }

  // ── Projects ───────────────────────────────────────────────────────────

  listProjects(options: { includeArchived?: boolean } = {}): ProjectRecord[] {
    return this.projectRepo.listProjects(options)
  }

  getProject(projectId: string): ProjectRecord | undefined {
    return this.projectRepo.getProject(projectId)
  }

  findProjectByProjectKey(projectKey: string): ProjectRecord | undefined {
    return this.projectRepo.findProjectByProjectKey(projectKey)
  }

  findProjectByCwd(cwd: string): ProjectRecord | undefined {
    return this.projectRepo.findProjectByCwd(cwd)
  }

  findProject(reference: string): ProjectRecord | undefined {
    const normalizedReference = reference.trim().toLowerCase()

    if (!normalizedReference) {
      return undefined
    }

    const byId = this.getProject(normalizedReference)
    if (byId) {
      return byId
    }

    return this.listProjects({ includeArchived: true }).find(
      (project) =>
        project.id.toLowerCase() === normalizedReference ||
        project.id.toLowerCase().startsWith(normalizedReference) ||
        project.name.toLowerCase() === normalizedReference ||
        project.cwd.toLowerCase() === normalizedReference,
    )
  }

  async createProject(
    name: string,
    cwd: string,
    defaultSourceId: string,
    projectKey?: string,
  ): Promise<ProjectRecord> {
    const identity = projectKey
      ? { cwd, defaultName: name || basename(cwd) || 'project', projectKey }
      : await resolveProjectIdentity(cwd)
    const timestamp = nowIso()
    let baseId = `proj_${slugify(name || identity.defaultName || 'project')}`
    let projectId = baseId
    let suffix = 2

    while (this.projectRepo.getProject(projectId)) {
      projectId = `${baseId}_${suffix}`
      suffix += 1
    }

    const project: ProjectRecord = {
      id: projectId,
      name: name || identity.defaultName || projectId,
      cwd: identity.cwd,
      projectKey: identity.projectKey,
      defaultSourceId,
      sourceMode: 'policy-default',
      agentSourceOverrideMode: 'policy-default',
      agentAutoWritebackEnabled: false,
      archivedAt: undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    this.projectRepo.createProject(project)
    return project
  }

  async updateProject(projectId: string, patch: Partial<ProjectRecord>): Promise<ProjectRecord> {
    const existing = this.getProject(projectId)
    if (!existing) {
      throw new Error(`Project not found: ${projectId}`)
    }

    return this.projectRepo.updateProject(projectId, {
      ...patch,
      projectKey: patch.projectKey ?? existing.projectKey,
      sourceMode: normalizeProjectSourceMode(patch.sourceMode ?? existing.sourceMode),
      agentSourceOverrideMode: normalizeAgentParentSourceOverrideMode(
        patch.agentSourceOverrideMode ?? existing.agentSourceOverrideMode,
      ),
      agentAutoWritebackEnabled:
        typeof patch.agentAutoWritebackEnabled === 'boolean'
          ? patch.agentAutoWritebackEnabled
          : existing.agentAutoWritebackEnabled,
    })
  }

  // ── Threads ────────────────────────────────────────────────────────────

  listThreads(projectId?: string, options: { includeArchived?: boolean } = {}): ThreadRecord[] {
    return this.threadRepo.listThreads(projectId, options)
  }

  /**
   * Returns project IDs that are visible in the Codex Desktop App.
   * Reads the App's own global state file to get saved workspace roots,
   * then matches them against our project cwds.
   */
  getDesktopProjectIds(): Set<string> {
    const globalStatePath = join(homedir(), '.codex', '.codex-global-state.json')
    let workspaceRoots: string[] = []
    try {
      const raw = readFileSync(globalStatePath, 'utf-8')
      const state = JSON.parse(raw)
      workspaceRoots = state['electron-saved-workspace-roots'] ?? []
    } catch {
      // File doesn't exist or isn't valid JSON — no Desktop projects
      return new Set()
    }
    if (workspaceRoots.length === 0) return new Set()

    // Match workspace roots to our projects by cwd (exact or parent match)
    const projects = this.projectRepo.listProjects()
    const desktopIds = new Set<string>()
    for (const proj of projects) {
      for (const root of workspaceRoots) {
        if (proj.cwd === root || proj.cwd.startsWith(root + '/')) {
          desktopIds.add(proj.id)
          break
        }
      }
    }
    return desktopIds
  }

  getThreadOriginatorCounts(projectId: string): Map<string, number> {
    const rows = this.db.prepare(
      'SELECT originator, COUNT(*) as cnt FROM threads WHERE project_id = ? AND archived_at IS NULL GROUP BY originator',
    ).all(projectId) as Array<{ originator: string; cnt: number }>
    return new Map(rows.map((r) => [r.originator, r.cnt]))
  }

  listThreadsBySource(sourceId: string): ThreadRecord[] {
    // The repo list supports project filtering; for source filtering we post-filter
    return this.threadRepo.listThreads(undefined, { includeArchived: true }).filter(
      (thread) => thread.sourceId === sourceId,
    )
  }

  getThread(threadId: string): ThreadRecord | undefined {
    return this.threadRepo.getThread(threadId)
  }

  findThreadByCodexThreadId(
    sourceId: string,
    codexThreadId: string,
  ): ThreadRecord | undefined {
    return this.threadRepo.findThreadByCodexThreadId(sourceId, codexThreadId)
  }

  findThread(reference: string, projectId?: string): ThreadRecord | undefined {
    const normalizedReference = reference.trim().toLowerCase()

    if (!normalizedReference) {
      return undefined
    }

    const threads = this.listThreads(projectId, { includeArchived: true })

    return threads.find(
      (thread) =>
        thread.id.toLowerCase() === normalizedReference ||
        thread.id.toLowerCase().startsWith(normalizedReference) ||
        thread.codexThreadId?.toLowerCase() === normalizedReference ||
        thread.codexThreadId?.toLowerCase().startsWith(normalizedReference),
    )
  }

  async createThread(
    projectId: string,
    input: {
      sourceId: string
      cwd: string
      title: string
      origin: ThreadRecord['origin']
      originator?: string
      codexThreadId?: string
      status?: ThreadStatus
    },
  ): Promise<ThreadRecord> {
    const timestamp = nowIso()
    let baseId = `th_${slugify(input.title || 'thread')}`
    let threadId = baseId
    let suffix = 2

    while (this.threadRepo.getThread(threadId)) {
      threadId = `${baseId}_${suffix}`
      suffix += 1
    }

    const thread: ThreadRecord = {
      id: threadId,
      projectId,
      sourceId: input.sourceId,
      cwd: input.cwd,
      title: input.title,
      origin: input.origin,
      originator: input.originator ?? 'telegram',
      codexThreadId: input.codexThreadId,
      status: input.status ?? 'idle',
      pinnedAt: undefined,
      archivedAt: undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    this.threadRepo.createThread(thread)
    return thread
  }

  async upsertThread(
    input: {
      projectId: string
      sourceId: string
      cwd: string
      title: string
      origin: ThreadRecord['origin']
      originator?: string
      codexThreadId?: string
      status?: ThreadStatus
      updatedAt?: string
    },
  ): Promise<{ thread: ThreadRecord; created: boolean }> {
    if (input.codexThreadId) {
      const existing = this.findThreadByCodexThreadId(input.sourceId, input.codexThreadId)
      if (existing) {
        const thread = await this.updateThread(existing.id, {
          projectId: input.projectId,
          sourceId: input.sourceId,
          cwd: input.cwd,
          title: input.title,
          origin: input.origin,
          originator: input.originator ?? existing.originator,
          codexThreadId: input.codexThreadId,
          status: input.status ?? existing.status,
          updatedAt: input.updatedAt ?? nowIso(),
        })
        return { thread, created: false }
      }
    }

    const thread = await this.createThread(input.projectId, {
      sourceId: input.sourceId,
      cwd: input.cwd,
      title: input.title,
      origin: input.origin,
      originator: input.originator,
      codexThreadId: input.codexThreadId,
      status: input.status,
    })
    return { thread, created: true }
  }

  async updateThread(
    threadId: string,
    patch: Partial<ThreadRecord>,
  ): Promise<ThreadRecord> {
    return this.threadRepo.updateThread(threadId, patch)
  }

  // ── Agents ─────────────────────────────────────────────────────────────

  listAgents(projectId?: string, parentThreadId?: string): AgentRecord[] {
    return this.agentRepo.listAgents(projectId, parentThreadId)
  }

  getAgent(agentId: string): AgentRecord | undefined {
    return this.agentRepo.getAgent(agentId)
  }

  async createAgent(input: {
    parentThreadId: string
    threadId: string
    projectId: string
    sourceId: string
    role: AgentRecord['role']
    task: string
    status?: AgentStatus
    lastError?: string
    lastMessagePreview?: string
  }): Promise<AgentRecord> {
    const timestamp = nowIso()
    let baseId = `ag_${slugify(`${input.role}_${input.task}` || 'agent')}`
    let agentId = baseId
    let suffix = 2

    while (this.agentRepo.getAgent(agentId)) {
      agentId = `${baseId}_${suffix}`
      suffix += 1
    }

    const agent: AgentRecord = {
      id: agentId,
      parentThreadId: input.parentThreadId,
      threadId: input.threadId,
      projectId: input.projectId,
      sourceId: input.sourceId,
      role: input.role,
      task: input.task,
      status: input.status ?? 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      lastError: input.lastError,
      lastMessagePreview: input.lastMessagePreview,
    }

    this.agentRepo.createAgent(agent)
    return agent
  }

  async updateAgent(
    agentId: string,
    patch: Partial<AgentRecord>,
  ): Promise<AgentRecord> {
    return this.agentRepo.updateAgent(agentId, patch)
  }

  // ── Archive / delete helpers ───────────────────────────────────────────

  async archiveProject(projectId: string): Promise<ProjectRecord> {
    return this.updateProject(projectId, { archivedAt: nowIso() })
  }

  async unarchiveProject(projectId: string): Promise<ProjectRecord> {
    return this.updateProject(projectId, { archivedAt: undefined })
  }

  async deleteProject(projectId: string): Promise<void> {
    this.projectRepo.deleteProject(projectId)
  }

  async archiveThread(threadId: string): Promise<ThreadRecord> {
    return this.updateThread(threadId, { archivedAt: nowIso() })
  }

  async unarchiveThread(threadId: string): Promise<ThreadRecord> {
    return this.updateThread(threadId, { archivedAt: undefined })
  }

  async deleteThread(threadId: string): Promise<void> {
    this.threadRepo.deleteThread(threadId)
  }

  async pinThread(threadId: string): Promise<ThreadRecord> {
    return this.updateThread(threadId, { pinnedAt: nowIso() })
  }

  async unpinThread(threadId: string): Promise<ThreadRecord> {
    return this.updateThread(threadId, { pinnedAt: undefined })
  }

  // ── Search ─────────────────────────────────────────────────────────────

  searchProjects(query: string, options: { includeArchived?: boolean } = {}): ProjectRecord[] {
    return this.projectRepo.searchProjects(query, options)
  }

  searchThreads(
    query: string,
    projectId?: string,
    options: { includeArchived?: boolean } = {},
  ): ThreadRecord[] {
    return this.threadRepo.searchThreads(query, projectId, options)
  }

  // ── Pagination helpers ─────────────────────────────────────────────────

  getProjectListLocation(
    projectId: string,
    options: { includeArchived?: boolean; pageSize?: number } = {},
  ): OrderedListLocation | undefined {
    return buildOrderedListLocation(
      this.listProjects({ includeArchived: options.includeArchived }),
      projectId,
      options.pageSize,
    )
  }

  getThreadListLocation(
    threadId: string,
    options: { projectId?: string; includeArchived?: boolean; pageSize?: number } = {},
  ): OrderedListLocation | undefined {
    return buildOrderedListLocation(
      this.listThreads(options.projectId, { includeArchived: options.includeArchived }),
      threadId,
      options.pageSize,
    )
  }

  // ── Selections ─────────────────────────────────────────────────────────

  getSelection(sessionKey: string): SelectionRecord {
    return this.selectionRepo.getSelection(sessionKey)
  }

  async setSelection(
    sessionKey: string,
    patch: Partial<SelectionRecord>,
  ): Promise<SelectionRecord> {
    const updated: SelectionRecord = {
      ...this.getSelection(sessionKey),
      ...patch,
    }

    if (!updated.currentProjectId) {
      delete updated.currentThreadId
    }

    this.selectionRepo.setSelection(sessionKey, updated)
    return updated
  }

  async clearSelection(sessionKey: string): Promise<void> {
    this.selectionRepo.clearSelection(sessionKey)
  }

  // ── Init helpers (private) ─────────────────────────────────────────────

  private ensureDefaultSources(): boolean {
    const timestamp = nowIso()
    let changed = false

    if (!this.sourceRepo.getSource('shared')) {
      this.sourceRepo.createSource({
        id: 'shared',
        name: 'App/CLI Shared',
        codexHome: DEFAULT_SHARED_CODEX_HOME,
        enabled: true,
        importEnabled: true,
        storagePolicy: 'shared',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      changed = true
    }

    const botLocal = this.sourceRepo.getSource('bot_local')
    if (!botLocal) {
      this.sourceRepo.createSource({
        id: 'bot_local',
        name: 'Telegram Local',
        codexHome: DEFAULT_BOT_CODEX_HOME,
        enabled: true,
        importEnabled: true,
        storagePolicy: 'isolated',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      changed = true
    } else if (botLocal.importEnabled !== true) {
      this.sourceRepo.updateSource('bot_local', {
        enabled: botLocal.enabled ?? true,
        importEnabled: true,
      })
      changed = true
    }

    return changed
  }

  private async ensureProjectForCwd(
    cwd: string,
    defaultSourceId: string,
  ): Promise<boolean> {
    if (!cwd) {
      return false
    }

    const identity = await resolveProjectIdentity(cwd)
    if (this.findProjectByProjectKey(identity.projectKey)) {
      return false
    }

    await this.createProject(identity.defaultName, identity.cwd, defaultSourceId, identity.projectKey)
    return true
  }

  private async normalizeProjects(): Promise<boolean> {
    const projects = this.projectRepo.listProjects({ includeArchived: true })
    if (projects.length === 0) {
      return false
    }

    const normalizedByKey = new Map<string, ProjectRecord[]>()
    let changed = false

    for (const project of projects) {
      const identity = await resolveProjectIdentity(project.cwd)

      if (
        identity.cwd !== project.cwd ||
        identity.projectKey !== project.projectKey
      ) {
        this.projectRepo.updateProject(project.id, {
          cwd: identity.cwd,
          projectKey: identity.projectKey,
        })
        changed = true
      }

      const current = this.projectRepo.getProject(project.id)!
      const group = normalizedByKey.get(identity.projectKey) ?? []
      group.push(current)
      normalizedByKey.set(identity.projectKey, group)
    }

    for (const group of normalizedByKey.values()) {
      if (group.length < 2) {
        continue
      }

      group.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      const primary = group[0]

      for (const duplicate of group.slice(1)) {
        // Re-point threads
        for (const thread of this.threadRepo.listThreads(undefined, { includeArchived: true })) {
          if (thread.projectId === duplicate.id) {
            this.threadRepo.updateThread(thread.id, { projectId: primary.id })
            changed = true
          }
        }

        // Re-point agents
        for (const agent of this.agentRepo.listAgents(duplicate.id)) {
          this.agentRepo.updateAgent(agent.id, { projectId: primary.id })
          changed = true
        }

        this.projectRepo.deleteProject(duplicate.id)
        changed = true
      }
    }

    return changed
  }
}
