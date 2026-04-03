import type Database from 'better-sqlite3'
import type { ThreadRecord, ThreadOrigin, ThreadStatus } from '../../../models.js'

interface ThreadRow {
  id: string
  project_id: string
  source_id: string
  cwd: string
  title: string
  origin: string
  originator: string
  codex_thread_id: string | null
  status: string
  pinned_at: string | null
  archived_at: string | null
  hidden_history_entry_keys: string | null
  created_at: string
  updated_at: string
}

function toRecord(row: ThreadRow): ThreadRecord {
  let hiddenKeys: string[] | undefined
  if (row.hidden_history_entry_keys) {
    try {
      const parsed: unknown = JSON.parse(row.hidden_history_entry_keys)
      if (Array.isArray(parsed)) {
        hiddenKeys = parsed.filter(
          (v): v is string => typeof v === 'string',
        )
      }
    } catch {
      // ignore malformed JSON
    }
  }

  return {
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id,
    cwd: row.cwd,
    title: row.title,
    origin: row.origin as ThreadOrigin,
    originator: row.originator,
    codexThreadId: row.codex_thread_id ?? undefined,
    status: row.status as ThreadStatus,
    pinnedAt: row.pinned_at ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    hiddenHistoryEntryKeys: hiddenKeys,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toRow(record: ThreadRecord): ThreadRow {
  return {
    id: record.id,
    project_id: record.projectId,
    source_id: record.sourceId,
    cwd: record.cwd,
    title: record.title,
    origin: record.origin,
    originator: record.originator,
    codex_thread_id: record.codexThreadId ?? null,
    status: record.status,
    pinned_at: record.pinnedAt ?? null,
    archived_at: record.archivedAt ?? null,
    hidden_history_entry_keys: record.hiddenHistoryEntryKeys
      ? JSON.stringify(record.hiddenHistoryEntryKeys)
      : null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  }
}

// Matches the sort order from state-store: active before archived,
// pinned first, then by updatedAt desc, createdAt desc, title, codexThreadId, id
const LIST_ORDER = `
  ORDER BY
    CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END,
    CASE WHEN pinned_at IS NOT NULL THEN 0 ELSE 1 END,
    pinned_at DESC,
    updated_at DESC,
    created_at DESC,
    title,
    codex_thread_id,
    id
`

export class ThreadRepository {
  constructor(private db: Database.Database) {}

  getThread(id: string): ThreadRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM threads WHERE id = ?')
      .get(id) as ThreadRow | undefined
    return row ? toRecord(row) : undefined
  }

  listThreads(
    projectId?: string,
    options: { includeArchived?: boolean } = {},
  ): ThreadRecord[] {
    const conditions: string[] = []
    const params: unknown[] = []

    if (projectId) {
      conditions.push('project_id = ?')
      params.push(projectId)
    }
    if (!options.includeArchived) {
      conditions.push('archived_at IS NULL')
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM threads ${where} ${LIST_ORDER}`)
      .all(...params) as ThreadRow[]
    return rows.map(toRecord)
  }

  findThreadByCodexThreadId(
    sourceId: string,
    codexThreadId: string,
  ): ThreadRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM threads WHERE source_id = ? AND codex_thread_id = ?',
      )
      .get(sourceId, codexThreadId) as ThreadRow | undefined
    return row ? toRecord(row) : undefined
  }

  createThread(record: ThreadRecord): void {
    const row = toRow(record)
    this.db
      .prepare(
        `INSERT INTO threads (id, project_id, source_id, cwd, title, origin, originator, codex_thread_id,
         status, pinned_at, archived_at, hidden_history_entry_keys, created_at, updated_at)
         VALUES (@id, @project_id, @source_id, @cwd, @title, @origin, @originator, @codex_thread_id,
         @status, @pinned_at, @archived_at, @hidden_history_entry_keys, @created_at, @updated_at)`,
      )
      .run(row)
  }

  upsertThread(record: ThreadRecord): void {
    const row = toRow(record)
    this.db
      .prepare(
        `INSERT INTO threads (id, project_id, source_id, cwd, title, origin, originator, codex_thread_id,
         status, pinned_at, archived_at, hidden_history_entry_keys, created_at, updated_at)
         VALUES (@id, @project_id, @source_id, @cwd, @title, @origin, @originator, @codex_thread_id,
         @status, @pinned_at, @archived_at, @hidden_history_entry_keys, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           source_id = excluded.source_id,
           cwd = excluded.cwd,
           title = excluded.title,
           origin = excluded.origin,
           originator = excluded.originator,
           codex_thread_id = excluded.codex_thread_id,
           status = excluded.status,
           pinned_at = excluded.pinned_at,
           archived_at = excluded.archived_at,
           hidden_history_entry_keys = excluded.hidden_history_entry_keys,
           updated_at = excluded.updated_at`,
      )
      .run(row)
  }

  updateThread(id: string, patch: Partial<ThreadRecord>): ThreadRecord {
    const existing = this.getThread(id)
    if (!existing) {
      throw new Error(`Thread not found: ${id}`)
    }

    const updated: ThreadRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    }

    const row = toRow(updated)
    this.db
      .prepare(
        `UPDATE threads SET project_id = @project_id, source_id = @source_id, cwd = @cwd,
         title = @title, origin = @origin, originator = @originator, codex_thread_id = @codex_thread_id,
         status = @status, pinned_at = @pinned_at, archived_at = @archived_at,
         hidden_history_entry_keys = @hidden_history_entry_keys, updated_at = @updated_at
         WHERE id = @id`,
      )
      .run(row)

    return updated
  }

  deleteThread(id: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM agents WHERE parent_thread_id = ? OR thread_id = ?',
        )
        .run(id, id)
      this.db
        .prepare(
          `UPDATE selections SET current_thread_id = NULL
           WHERE current_thread_id = ?`,
        )
        .run(id)
      this.db.prepare('DELETE FROM threads WHERE id = ?').run(id)
    })()
  }

  searchThreads(
    query: string,
    projectId?: string,
    options: { includeArchived?: boolean } = {},
  ): ThreadRecord[] {
    const q = query.trim()
    if (!q) return []
    const pattern = `%${q}%`

    const conditions: string[] = [
      '(title LIKE ? COLLATE NOCASE OR cwd LIKE ? COLLATE NOCASE OR id LIKE ? COLLATE NOCASE OR codex_thread_id LIKE ? COLLATE NOCASE)',
    ]
    const params: unknown[] = [pattern, pattern, pattern, pattern]

    if (projectId) {
      conditions.push('project_id = ?')
      params.push(projectId)
    }
    if (!options.includeArchived) {
      conditions.push('archived_at IS NULL')
    }

    const where = `WHERE ${conditions.join(' AND ')}`
    const rows = this.db
      .prepare(`SELECT * FROM threads ${where} ${LIST_ORDER}`)
      .all(...params) as ThreadRow[]
    return rows.map(toRecord)
  }
}
