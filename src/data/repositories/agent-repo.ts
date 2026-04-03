import type Database from 'better-sqlite3'
import type { AgentRecord, AgentRole, AgentStatus } from '../../../models.js'

interface AgentRow {
  id: string
  parent_thread_id: string
  thread_id: string
  project_id: string
  source_id: string
  role: string
  task: string
  status: string
  created_at: string
  updated_at: string
  last_error: string | null
  last_message_preview: string | null
  writeback_run_id: string | null
}

function toRecord(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    parentThreadId: row.parent_thread_id,
    threadId: row.thread_id,
    projectId: row.project_id,
    sourceId: row.source_id,
    role: row.role as AgentRole,
    task: row.task,
    status: row.status as AgentStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error ?? undefined,
    lastMessagePreview: row.last_message_preview ?? undefined,
    writebackRunId: row.writeback_run_id ?? undefined,
  }
}

function toRow(record: AgentRecord): AgentRow {
  return {
    id: record.id,
    parent_thread_id: record.parentThreadId,
    thread_id: record.threadId,
    project_id: record.projectId,
    source_id: record.sourceId,
    role: record.role,
    task: record.task,
    status: record.status,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    last_error: record.lastError ?? null,
    last_message_preview: record.lastMessagePreview ?? null,
    writeback_run_id: record.writebackRunId ?? null,
  }
}

const LIST_ORDER = 'ORDER BY updated_at DESC, created_at DESC, id'

export class AgentRepository {
  constructor(private db: Database.Database) {}

  getAgent(id: string): AgentRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM agents WHERE id = ?')
      .get(id) as AgentRow | undefined
    return row ? toRecord(row) : undefined
  }

  listAgents(projectId?: string, parentThreadId?: string): AgentRecord[] {
    const conditions: string[] = []
    const params: unknown[] = []

    if (projectId) {
      conditions.push('project_id = ?')
      params.push(projectId)
    }
    if (parentThreadId) {
      conditions.push('parent_thread_id = ?')
      params.push(parentThreadId)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM agents ${where} ${LIST_ORDER}`)
      .all(...params) as AgentRow[]
    return rows.map(toRecord)
  }

  createAgent(record: AgentRecord): void {
    const row = toRow(record)
    this.db
      .prepare(
        `INSERT INTO agents (id, parent_thread_id, thread_id, project_id, source_id,
         role, task, status, created_at, updated_at, last_error, last_message_preview, writeback_run_id)
         VALUES (@id, @parent_thread_id, @thread_id, @project_id, @source_id,
         @role, @task, @status, @created_at, @updated_at, @last_error, @last_message_preview, @writeback_run_id)`,
      )
      .run(row)
  }

  updateAgent(id: string, patch: Partial<AgentRecord>): AgentRecord {
    const existing = this.getAgent(id)
    if (!existing) {
      throw new Error(`Agent not found: ${id}`)
    }

    const updated: AgentRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    }

    const row = toRow(updated)
    this.db
      .prepare(
        `UPDATE agents SET parent_thread_id = @parent_thread_id, thread_id = @thread_id,
         project_id = @project_id, source_id = @source_id, role = @role, task = @task,
         status = @status, updated_at = @updated_at, last_error = @last_error,
         last_message_preview = @last_message_preview, writeback_run_id = @writeback_run_id
         WHERE id = @id`,
      )
      .run(row)

    return updated
  }

  searchAgents(query: string): AgentRecord[] {
    const q = query.trim()
    if (!q) return []
    const pattern = `%${q}%`
    const rows = this.db
      .prepare(
        `SELECT * FROM agents
         WHERE task LIKE ? COLLATE NOCASE
           OR id LIKE ? COLLATE NOCASE
           OR role LIKE ? COLLATE NOCASE
         ${LIST_ORDER}`,
      )
      .all(pattern, pattern, pattern) as AgentRow[]
    return rows.map(toRecord)
  }
}
