import type Database from 'better-sqlite3'
import type { SourceRecord, SourceStoragePolicy } from '../../../models.js'

interface SourceRow {
  id: string
  name: string
  codex_home: string
  enabled: number
  import_enabled: number
  storage_policy: string
  created_at: string
  updated_at: string
}

function toRecord(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    name: row.name,
    codexHome: row.codex_home,
    enabled: row.enabled === 1,
    importEnabled: row.import_enabled === 1,
    storagePolicy: row.storage_policy as SourceStoragePolicy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toRow(record: SourceRecord): SourceRow {
  return {
    id: record.id,
    name: record.name,
    codex_home: record.codexHome,
    enabled: record.enabled ? 1 : 0,
    import_enabled: record.importEnabled ? 1 : 0,
    storage_policy: record.storagePolicy,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  }
}

export class SourceRepository {
  constructor(private db: Database.Database) {}

  getSource(id: string): SourceRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM sources WHERE id = ?')
      .get(id) as SourceRow | undefined
    return row ? toRecord(row) : undefined
  }

  listSources(options: { includeDisabled?: boolean } = {}): SourceRecord[] {
    const rows = options.includeDisabled
      ? (this.db.prepare('SELECT * FROM sources ORDER BY name').all() as SourceRow[])
      : (this.db
          .prepare('SELECT * FROM sources WHERE enabled = 1 ORDER BY name')
          .all() as SourceRow[])
    return rows.map(toRecord)
  }

  createSource(record: SourceRecord): void {
    const row = toRow(record)
    this.db
      .prepare(
        `INSERT INTO sources (id, name, codex_home, enabled, import_enabled, storage_policy, created_at, updated_at)
         VALUES (@id, @name, @codex_home, @enabled, @import_enabled, @storage_policy, @created_at, @updated_at)`,
      )
      .run(row)
  }

  updateSource(id: string, patch: Partial<SourceRecord>): SourceRecord {
    const existing = this.getSource(id)
    if (!existing) {
      throw new Error(`Source not found: ${id}`)
    }

    const updated: SourceRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    }

    const row = toRow(updated)
    this.db
      .prepare(
        `UPDATE sources SET name = @name, codex_home = @codex_home, enabled = @enabled,
         import_enabled = @import_enabled, storage_policy = @storage_policy, updated_at = @updated_at
         WHERE id = @id`,
      )
      .run(row)

    return updated
  }

  searchSources(query: string): SourceRecord[] {
    const q = query.trim()
    if (!q) return []
    const pattern = `%${q}%`
    const rows = this.db
      .prepare(
        `SELECT * FROM sources WHERE name LIKE ? COLLATE NOCASE
         OR id LIKE ? COLLATE NOCASE
         OR codex_home LIKE ? COLLATE NOCASE
         ORDER BY name`,
      )
      .all(pattern, pattern, pattern) as SourceRow[]
    return rows.map(toRecord)
  }
}
