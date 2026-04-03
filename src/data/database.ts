import Database from 'better-sqlite3'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const STATE_DIR = join(process.env.HOME ?? '', '.codex-telegram', 'state')

export function openDatabase(dbPath?: string): Database.Database {
  const path = dbPath ?? join(STATE_DIR, 'codex-telegram.sqlite')
  mkdirSync(join(path, '..'), { recursive: true })

  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')

  runMigrations(db)
  return db
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)

  const row = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get() as {
    v: number | null
  }
  const currentVersion = row?.v ?? 0

  for (const [version, sql] of MIGRATIONS) {
    if (version > currentVersion) {
      db.transaction(() => {
        db.exec(sql)
        db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version)
      })()
    }
  }
}

// ---------------------------------------------------------------------------
// Migration 001 – initial schema
// ---------------------------------------------------------------------------

const MIGRATION_001 = `
-- Sources ------------------------------------------------------------------
CREATE TABLE sources (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  codex_home       TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  import_enabled   INTEGER NOT NULL DEFAULT 1,
  storage_policy   TEXT NOT NULL DEFAULT 'shared',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- Projects -----------------------------------------------------------------
CREATE TABLE projects (
  id                              TEXT PRIMARY KEY,
  name                            TEXT NOT NULL,
  cwd                             TEXT NOT NULL,
  project_key                     TEXT NOT NULL,
  default_source_id               TEXT NOT NULL REFERENCES sources(id),
  source_mode                     TEXT NOT NULL DEFAULT 'policy-default',
  agent_source_override_mode      TEXT NOT NULL DEFAULT 'policy-default',
  agent_auto_writeback_enabled    INTEGER NOT NULL DEFAULT 0,
  archived_at                     TEXT,
  created_at                      TEXT NOT NULL,
  updated_at                      TEXT NOT NULL
);
CREATE INDEX idx_projects_project_key     ON projects(project_key);
CREATE INDEX idx_projects_cwd             ON projects(cwd);
CREATE INDEX idx_projects_default_source  ON projects(default_source_id);

-- Threads ------------------------------------------------------------------
CREATE TABLE threads (
  id                         TEXT PRIMARY KEY,
  project_id                 TEXT NOT NULL REFERENCES projects(id),
  source_id                  TEXT NOT NULL REFERENCES sources(id),
  cwd                        TEXT NOT NULL,
  title                      TEXT NOT NULL,
  origin                     TEXT NOT NULL DEFAULT 'telegram',
  codex_thread_id            TEXT,
  status                     TEXT NOT NULL DEFAULT 'idle',
  pinned_at                  TEXT,
  archived_at                TEXT,
  hidden_history_entry_keys  TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);
CREATE INDEX idx_threads_project_id       ON threads(project_id);
CREATE INDEX idx_threads_source_id        ON threads(source_id);
CREATE INDEX idx_threads_codex_thread_id  ON threads(codex_thread_id);
CREATE INDEX idx_threads_status           ON threads(status);

-- Agents -------------------------------------------------------------------
CREATE TABLE agents (
  id                    TEXT PRIMARY KEY,
  parent_thread_id      TEXT NOT NULL REFERENCES threads(id),
  thread_id             TEXT NOT NULL,
  project_id            TEXT NOT NULL REFERENCES projects(id),
  source_id             TEXT NOT NULL REFERENCES sources(id),
  role                  TEXT NOT NULL,
  task                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'queued',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  last_error            TEXT,
  last_message_preview  TEXT,
  writeback_run_id      TEXT
);
CREATE INDEX idx_agents_parent_thread_id  ON agents(parent_thread_id);
CREATE INDEX idx_agents_project_id        ON agents(project_id);
CREATE INDEX idx_agents_source_id         ON agents(source_id);
CREATE INDEX idx_agents_status            ON agents(status);

-- Selections (per chat-session) --------------------------------------------
CREATE TABLE selections (
  session_key         TEXT PRIMARY KEY,
  current_project_id  TEXT,
  current_thread_id   TEXT
);

-- Access config (singleton row) --------------------------------------------
CREATE TABLE access_config (
  id               INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  dm_policy        TEXT    NOT NULL DEFAULT 'pairing',
  allow_from       TEXT    NOT NULL DEFAULT '[]',
  groups           TEXT    NOT NULL DEFAULT '{}',
  pending          TEXT    NOT NULL DEFAULT '{}',
  ack_reaction     TEXT    NOT NULL DEFAULT '+1',
  session_timeout  INTEGER NOT NULL DEFAULT 3600000
);

-- Import cursors (per source) ----------------------------------------------
CREATE TABLE import_cursors (
  source_id                     TEXT PRIMARY KEY REFERENCES sources(id),
  last_scan_at                  TEXT,
  last_scan_started_at          TEXT,
  last_scan_completed_at        TEXT,
  last_imported_mtime_ms        REAL,
  last_imported_path            TEXT,
  last_seen_mtime_ms            REAL,
  last_seen_path                TEXT,
  last_session_index_mtime_ms   REAL,
  last_session_index_fingerprint TEXT,
  files                         TEXT NOT NULL DEFAULT '{}',
  file_fingerprints             TEXT NOT NULL DEFAULT '{}'
);
`

// ---------------------------------------------------------------------------
// Migration 002 – add originator column to threads
// ---------------------------------------------------------------------------

const MIGRATION_002 = `
ALTER TABLE threads ADD COLUMN originator TEXT NOT NULL DEFAULT 'unknown';
UPDATE threads SET originator = 'telegram'  WHERE origin = 'telegram';
UPDATE threads SET originator = 'imported'  WHERE origin = 'imported';
`

// ---------------------------------------------------------------------------
// Ordered migration list — append new entries here
// ---------------------------------------------------------------------------

const MIGRATIONS: Array<[number, string]> = [
  [1, MIGRATION_001],
  [2, MIGRATION_002],
]
