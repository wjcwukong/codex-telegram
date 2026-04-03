import type Database from 'better-sqlite3'
import type { SourceCursor, SourceCursorPatch } from '../../../import-cursor.js'

interface CursorRow {
  source_id: string
  last_scan_at: string | null
  last_scan_started_at: string | null
  last_scan_completed_at: string | null
  last_imported_mtime_ms: number | null
  last_imported_path: string | null
  last_seen_mtime_ms: number | null
  last_seen_path: string | null
  last_session_index_mtime_ms: number | null
  last_session_index_fingerprint: string | null
  files: string
  file_fingerprints: string
}

function toRecord(row: CursorRow): SourceCursor {
  return {
    lastScanAt: row.last_scan_at ?? undefined,
    lastScanStartedAt: row.last_scan_started_at ?? undefined,
    lastScanCompletedAt: row.last_scan_completed_at ?? undefined,
    lastImportedMtimeMs: row.last_imported_mtime_ms ?? undefined,
    lastImportedPath: row.last_imported_path ?? undefined,
    lastSeenMtimeMs: row.last_seen_mtime_ms ?? undefined,
    lastSeenPath: row.last_seen_path ?? undefined,
    lastSessionIndexMtimeMs: row.last_session_index_mtime_ms ?? undefined,
    lastSessionIndexFingerprint: row.last_session_index_fingerprint ?? undefined,
    files: JSON.parse(row.files) as Record<string, number>,
    fileFingerprints: JSON.parse(row.file_fingerprints) as Record<string, string>,
  }
}

function defaultCursor(): SourceCursor {
  return { files: {}, fileFingerprints: {} }
}

export class CursorRepository {
  constructor(private db: Database.Database) {}

  getCursor(sourceId: string): SourceCursor {
    const row = this.db
      .prepare('SELECT * FROM import_cursors WHERE source_id = ?')
      .get(sourceId) as CursorRow | undefined
    return row ? toRecord(row) : defaultCursor()
  }

  setCursor(sourceId: string, data: SourceCursor): void {
    this.db
      .prepare(
        `INSERT INTO import_cursors (source_id, last_scan_at, last_scan_started_at,
         last_scan_completed_at, last_imported_mtime_ms, last_imported_path,
         last_seen_mtime_ms, last_seen_path, last_session_index_mtime_ms,
         last_session_index_fingerprint, files, file_fingerprints)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET
           last_scan_at = excluded.last_scan_at,
           last_scan_started_at = excluded.last_scan_started_at,
           last_scan_completed_at = excluded.last_scan_completed_at,
           last_imported_mtime_ms = excluded.last_imported_mtime_ms,
           last_imported_path = excluded.last_imported_path,
           last_seen_mtime_ms = excluded.last_seen_mtime_ms,
           last_seen_path = excluded.last_seen_path,
           last_session_index_mtime_ms = excluded.last_session_index_mtime_ms,
           last_session_index_fingerprint = excluded.last_session_index_fingerprint,
           files = excluded.files,
           file_fingerprints = excluded.file_fingerprints`,
      )
      .run(
        sourceId,
        data.lastScanAt ?? null,
        data.lastScanStartedAt ?? null,
        data.lastScanCompletedAt ?? null,
        data.lastImportedMtimeMs ?? null,
        data.lastImportedPath ?? null,
        data.lastSeenMtimeMs ?? null,
        data.lastSeenPath ?? null,
        data.lastSessionIndexMtimeMs ?? null,
        data.lastSessionIndexFingerprint ?? null,
        JSON.stringify(data.files),
        JSON.stringify(data.fileFingerprints ?? {}),
      )
  }

  patchCursor(sourceId: string, patch: SourceCursorPatch): SourceCursor {
    const current = this.getCursor(sourceId)
    const next: SourceCursor = {
      ...current,
      ...patch,
      files: patch.files ?? current.files,
      fileFingerprints: patch.fileFingerprints ?? current.fileFingerprints,
    }
    this.setCursor(sourceId, next)
    return next
  }
}
