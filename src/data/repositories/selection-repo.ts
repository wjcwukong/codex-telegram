import type Database from 'better-sqlite3'
import type { SelectionRecord } from '../../../models.js'

interface SelectionRow {
  session_key: string
  current_project_id: string | null
  current_thread_id: string | null
}

function toRecord(row: SelectionRow): SelectionRecord {
  return {
    currentProjectId: row.current_project_id ?? undefined,
    currentThreadId: row.current_thread_id ?? undefined,
  }
}

export class SelectionRepository {
  constructor(private db: Database.Database) {}

  getSelection(sessionKey: string): SelectionRecord {
    const row = this.db
      .prepare('SELECT * FROM selections WHERE session_key = ?')
      .get(sessionKey) as SelectionRow | undefined
    return row ? toRecord(row) : {}
  }

  setSelection(sessionKey: string, record: SelectionRecord): void {
    const projectId = record.currentProjectId ?? null
    const threadId = record.currentProjectId ? (record.currentThreadId ?? null) : null

    this.db
      .prepare(
        `INSERT INTO selections (session_key, current_project_id, current_thread_id)
         VALUES (?, ?, ?)
         ON CONFLICT(session_key) DO UPDATE SET
           current_project_id = excluded.current_project_id,
           current_thread_id = excluded.current_thread_id`,
      )
      .run(sessionKey, projectId, threadId)
  }

  clearSelection(sessionKey: string): void {
    this.db.prepare('DELETE FROM selections WHERE session_key = ?').run(sessionKey)
  }
}
