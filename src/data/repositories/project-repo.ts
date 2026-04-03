import type Database from 'better-sqlite3'
import type {
  ProjectRecord,
  ProjectSourceMode,
  AgentParentSourceOverrideMode,
} from '../../../models.js'

interface ProjectRow {
  id: string
  name: string
  cwd: string
  project_key: string
  default_source_id: string
  source_mode: string
  agent_source_override_mode: string
  agent_auto_writeback_enabled: number
  archived_at: string | null
  created_at: string
  updated_at: string
}

function toRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    projectKey: row.project_key,
    defaultSourceId: row.default_source_id,
    sourceMode: row.source_mode as ProjectSourceMode,
    agentSourceOverrideMode: row.agent_source_override_mode as AgentParentSourceOverrideMode,
    agentAutoWritebackEnabled: row.agent_auto_writeback_enabled === 1,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toRow(record: ProjectRecord): ProjectRow {
  return {
    id: record.id,
    name: record.name,
    cwd: record.cwd,
    project_key: record.projectKey,
    default_source_id: record.defaultSourceId,
    source_mode: record.sourceMode,
    agent_source_override_mode: record.agentSourceOverrideMode,
    agent_auto_writeback_enabled: record.agentAutoWritebackEnabled ? 1 : 0,
    archived_at: record.archivedAt ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  }
}

export class ProjectRepository {
  constructor(private db: Database.Database) {}

  getProject(id: string): ProjectRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as ProjectRow | undefined
    return row ? toRecord(row) : undefined
  }

  listProjects(options: { includeArchived?: boolean } = {}): ProjectRecord[] {
    const sql = options.includeArchived
      ? 'SELECT * FROM projects ORDER BY CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END, name, cwd, created_at, id'
      : 'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY name, cwd, created_at, id'
    const rows = this.db.prepare(sql).all() as ProjectRow[]
    return rows.map(toRecord)
  }

  findProjectByProjectKey(key: string): ProjectRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE project_key = ?')
      .get(key) as ProjectRow | undefined
    return row ? toRecord(row) : undefined
  }

  findProjectByCwd(cwd: string): ProjectRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE cwd = ?')
      .get(cwd) as ProjectRow | undefined
    return row ? toRecord(row) : undefined
  }

  createProject(record: ProjectRecord): void {
    const row = toRow(record)
    this.db
      .prepare(
        `INSERT INTO projects (id, name, cwd, project_key, default_source_id, source_mode,
         agent_source_override_mode, agent_auto_writeback_enabled, archived_at, created_at, updated_at)
         VALUES (@id, @name, @cwd, @project_key, @default_source_id, @source_mode,
         @agent_source_override_mode, @agent_auto_writeback_enabled, @archived_at, @created_at, @updated_at)`,
      )
      .run(row)
  }

  updateProject(id: string, patch: Partial<ProjectRecord>): ProjectRecord {
    const existing = this.getProject(id)
    if (!existing) {
      throw new Error(`Project not found: ${id}`)
    }

    const updated: ProjectRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    }

    const row = toRow(updated)
    this.db
      .prepare(
        `UPDATE projects SET name = @name, cwd = @cwd, project_key = @project_key,
         default_source_id = @default_source_id, source_mode = @source_mode,
         agent_source_override_mode = @agent_source_override_mode,
         agent_auto_writeback_enabled = @agent_auto_writeback_enabled,
         archived_at = @archived_at, updated_at = @updated_at
         WHERE id = @id`,
      )
      .run(row)

    return updated
  }

  deleteProject(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM agents WHERE project_id = ?').run(id)
      this.db.prepare('DELETE FROM threads WHERE project_id = ?').run(id)
      this.db
        .prepare(
          `UPDATE selections SET current_project_id = NULL, current_thread_id = NULL
           WHERE current_project_id = ?`,
        )
        .run(id)
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    })()
  }

  searchProjects(
    query: string,
    options: { includeArchived?: boolean } = {},
  ): ProjectRecord[] {
    const q = query.trim()
    if (!q) return []
    const pattern = `%${q}%`

    const archiveClause = options.includeArchived
      ? ''
      : 'AND archived_at IS NULL'

    const rows = this.db
      .prepare(
        `SELECT * FROM projects
         WHERE (name LIKE ? COLLATE NOCASE OR cwd LIKE ? COLLATE NOCASE OR id LIKE ? COLLATE NOCASE)
         ${archiveClause}
         ORDER BY CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END, name, cwd, created_at, id`,
      )
      .all(pattern, pattern, pattern) as ProjectRow[]
    return rows.map(toRecord)
  }
}
