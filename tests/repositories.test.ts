import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type {
  SourceRecord,
  ProjectRecord,
  ThreadRecord,
  AgentRecord,
} from '../models.js'
import {
  SourceRepository,
  ProjectRepository,
  ThreadRepository,
  AgentRepository,
  SelectionRepository,
} from '../src/data/repositories/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Opens an in-memory SQLite database with migrations applied. */
function openTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Run migration inline (same SQL as database.ts MIGRATION_001)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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

    CREATE TABLE threads (
      id                         TEXT PRIMARY KEY,
      project_id                 TEXT NOT NULL REFERENCES projects(id),
      source_id                  TEXT NOT NULL REFERENCES sources(id),
      cwd                        TEXT NOT NULL,
      title                      TEXT NOT NULL,
      origin                     TEXT NOT NULL DEFAULT 'telegram',
      originator                 TEXT NOT NULL DEFAULT 'unknown',
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

    CREATE TABLE selections (
      session_key         TEXT PRIMARY KEY,
      current_project_id  TEXT,
      current_thread_id   TEXT
    );

    INSERT INTO schema_migrations (version) VALUES (1);
  `)

  return db
}

const now = new Date().toISOString()

function makeSource(id = 'src-1'): SourceRecord {
  return {
    id,
    name: 'Test Source',
    codexHome: '/home/codex',
    enabled: true,
    importEnabled: true,
    storagePolicy: 'shared',
    createdAt: now,
    updatedAt: now,
  }
}

function makeProject(id = 'proj-1', sourceId = 'src-1'): ProjectRecord {
  return {
    id,
    name: 'Test Project',
    cwd: '/home/user/project',
    projectKey: `path:/home/user/project`,
    defaultSourceId: sourceId,
    sourceMode: 'policy-default',
    agentSourceOverrideMode: 'policy-default',
    agentAutoWritebackEnabled: false,
    createdAt: now,
    updatedAt: now,
  }
}

function makeThread(
  id = 'thread-1',
  projectId = 'proj-1',
  sourceId = 'src-1',
): ThreadRecord {
  return {
    id,
    projectId,
    sourceId,
    cwd: '/home/user/project',
    title: 'Test Thread',
    origin: 'telegram',
    originator: 'telegram',
    status: 'idle',
    createdAt: now,
    updatedAt: now,
  }
}

function makeAgent(
  id = 'agent-1',
  parentThreadId = 'thread-1',
  projectId = 'proj-1',
  sourceId = 'src-1',
): AgentRecord {
  return {
    id,
    parentThreadId,
    threadId: `agent-thread-${id}`,
    projectId,
    sourceId,
    role: 'worker',
    task: 'do something',
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  }
}

// ---------------------------------------------------------------------------
// SourceRepository
// ---------------------------------------------------------------------------

describe('SourceRepository', () => {
  let db: Database.Database
  let repo: SourceRepository

  beforeEach(() => {
    db = openTestDb()
    repo = new SourceRepository(db)
  })

  it('creates and gets a source', () => {
    const src = makeSource()
    repo.createSource(src)
    const fetched = repo.getSource('src-1')
    expect(fetched).toEqual(src)
  })

  it('returns undefined for missing source', () => {
    expect(repo.getSource('nope')).toBeUndefined()
  })

  it('updates a source', () => {
    repo.createSource(makeSource())
    const updated = repo.updateSource('src-1', { name: 'Updated' })
    expect(updated.name).toBe('Updated')
    expect(repo.getSource('src-1')?.name).toBe('Updated')
  })

  it('throws when updating non-existent source', () => {
    expect(() => repo.updateSource('nope', { name: 'x' })).toThrow()
  })

  it('lists sources', () => {
    repo.createSource(makeSource('s1'))
    repo.createSource(makeSource('s2'))
    const disabledSrc = { ...makeSource('s3'), enabled: false }
    repo.createSource(disabledSrc)

    expect(repo.listSources().length).toBe(2)
    expect(repo.listSources({ includeDisabled: true }).length).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// ProjectRepository
// ---------------------------------------------------------------------------

describe('ProjectRepository', () => {
  let db: Database.Database
  let sourceRepo: SourceRepository
  let repo: ProjectRepository

  beforeEach(() => {
    db = openTestDb()
    sourceRepo = new SourceRepository(db)
    repo = new ProjectRepository(db)
    sourceRepo.createSource(makeSource())
  })

  it('creates and gets a project', () => {
    const proj = makeProject()
    repo.createProject(proj)
    const fetched = repo.getProject('proj-1')
    expect(fetched).toEqual(proj)
  })

  it('returns undefined for missing project', () => {
    expect(repo.getProject('nope')).toBeUndefined()
  })

  it('updates a project', () => {
    repo.createProject(makeProject())
    const updated = repo.updateProject('proj-1', { name: 'Renamed' })
    expect(updated.name).toBe('Renamed')
    expect(repo.getProject('proj-1')?.name).toBe('Renamed')
  })

  it('throws when updating non-existent project', () => {
    expect(() => repo.updateProject('nope', { name: 'x' })).toThrow()
  })

  it('finds project by projectKey', () => {
    repo.createProject(makeProject())
    const found = repo.findProjectByProjectKey('path:/home/user/project')
    expect(found?.id).toBe('proj-1')
    expect(repo.findProjectByProjectKey('nope')).toBeUndefined()
  })

  it('finds project by cwd', () => {
    repo.createProject(makeProject())
    const found = repo.findProjectByCwd('/home/user/project')
    expect(found?.id).toBe('proj-1')
    expect(repo.findProjectByCwd('/nope')).toBeUndefined()
  })

  it('searches projects', () => {
    repo.createProject(makeProject())
    expect(repo.searchProjects('Test').length).toBe(1)
    expect(repo.searchProjects('xyz').length).toBe(0)
    expect(repo.searchProjects('').length).toBe(0)
  })

  it('deletes project and cascades to threads and agents', () => {
    const threadRepo = new ThreadRepository(db)
    const agentRepo = new AgentRepository(db)

    repo.createProject(makeProject())
    threadRepo.createThread(makeThread())
    agentRepo.createAgent(makeAgent())

    repo.deleteProject('proj-1')
    expect(repo.getProject('proj-1')).toBeUndefined()
    expect(threadRepo.getThread('thread-1')).toBeUndefined()
    expect(agentRepo.getAgent('agent-1')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// ThreadRepository
// ---------------------------------------------------------------------------

describe('ThreadRepository', () => {
  let db: Database.Database
  let repo: ThreadRepository

  beforeEach(() => {
    db = openTestDb()
    const sourceRepo = new SourceRepository(db)
    const projectRepo = new ProjectRepository(db)
    sourceRepo.createSource(makeSource())
    projectRepo.createProject(makeProject())
    repo = new ThreadRepository(db)
  })

  it('creates and gets a thread', () => {
    const thread = makeThread()
    repo.createThread(thread)
    const fetched = repo.getThread('thread-1')
    expect(fetched).toEqual(thread)
  })

  it('returns undefined for missing thread', () => {
    expect(repo.getThread('nope')).toBeUndefined()
  })

  it('updates a thread', () => {
    repo.createThread(makeThread())
    const updated = repo.updateThread('thread-1', { title: 'Renamed' })
    expect(updated.title).toBe('Renamed')
    expect(repo.getThread('thread-1')?.title).toBe('Renamed')
  })

  it('throws when updating non-existent thread', () => {
    expect(() => repo.updateThread('nope', { title: 'x' })).toThrow()
  })

  it('upserts a thread (insert)', () => {
    repo.upsertThread(makeThread())
    expect(repo.getThread('thread-1')).toBeDefined()
  })

  it('upserts a thread (update)', () => {
    repo.createThread(makeThread())
    repo.upsertThread({ ...makeThread(), title: 'Updated' })
    expect(repo.getThread('thread-1')?.title).toBe('Updated')
  })

  it('finds thread by codexThreadId', () => {
    repo.createThread({ ...makeThread(), codexThreadId: 'cdx-123' })
    const found = repo.findThreadByCodexThreadId('src-1', 'cdx-123')
    expect(found?.id).toBe('thread-1')
    expect(repo.findThreadByCodexThreadId('src-1', 'nope')).toBeUndefined()
  })

  it('lists threads by project', () => {
    repo.createThread(makeThread('t1'))
    repo.createThread(makeThread('t2'))
    const threads = repo.listThreads('proj-1')
    expect(threads.length).toBe(2)
  })

  it('excludes archived threads by default', () => {
    repo.createThread(makeThread('t1'))
    repo.createThread({ ...makeThread('t2'), archivedAt: now })
    expect(repo.listThreads('proj-1').length).toBe(1)
    expect(repo.listThreads('proj-1', { includeArchived: true }).length).toBe(2)
  })

  it('deletes a thread and cascades to agents', () => {
    repo.createThread(makeThread())
    const agentRepo = new AgentRepository(db)
    agentRepo.createAgent(makeAgent())

    repo.deleteThread('thread-1')
    expect(repo.getThread('thread-1')).toBeUndefined()
    expect(agentRepo.getAgent('agent-1')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AgentRepository
// ---------------------------------------------------------------------------

describe('AgentRepository', () => {
  let db: Database.Database
  let repo: AgentRepository

  beforeEach(() => {
    db = openTestDb()
    const sourceRepo = new SourceRepository(db)
    const projectRepo = new ProjectRepository(db)
    const threadRepo = new ThreadRepository(db)
    sourceRepo.createSource(makeSource())
    projectRepo.createProject(makeProject())
    threadRepo.createThread(makeThread())
    repo = new AgentRepository(db)
  })

  it('creates and gets an agent', () => {
    const agent = makeAgent()
    repo.createAgent(agent)
    const fetched = repo.getAgent('agent-1')
    expect(fetched).toEqual(agent)
  })

  it('returns undefined for missing agent', () => {
    expect(repo.getAgent('nope')).toBeUndefined()
  })

  it('updates an agent', () => {
    repo.createAgent(makeAgent())
    const updated = repo.updateAgent('agent-1', { status: 'running' })
    expect(updated.status).toBe('running')
    expect(repo.getAgent('agent-1')?.status).toBe('running')
  })

  it('throws when updating non-existent agent', () => {
    expect(() => repo.updateAgent('nope', { status: 'running' })).toThrow()
  })

  it('lists agents by project', () => {
    repo.createAgent(makeAgent('a1'))
    repo.createAgent(makeAgent('a2'))
    expect(repo.listAgents('proj-1').length).toBe(2)
  })

  it('lists agents by parent thread', () => {
    repo.createAgent(makeAgent('a1'))
    expect(repo.listAgents(undefined, 'thread-1').length).toBe(1)
    expect(repo.listAgents(undefined, 'other').length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// SelectionRepository
// ---------------------------------------------------------------------------

describe('SelectionRepository', () => {
  let db: Database.Database
  let repo: SelectionRepository

  beforeEach(() => {
    db = openTestDb()
    repo = new SelectionRepository(db)
  })

  it('returns empty selection for unknown key', () => {
    const sel = repo.getSelection('unknown')
    expect(sel.currentProjectId).toBeUndefined()
    expect(sel.currentThreadId).toBeUndefined()
  })

  it('sets and gets a selection', () => {
    repo.setSelection('user-1', {
      currentProjectId: 'proj-1',
      currentThreadId: 'thread-1',
    })
    const sel = repo.getSelection('user-1')
    expect(sel.currentProjectId).toBe('proj-1')
    expect(sel.currentThreadId).toBe('thread-1')
  })

  it('overwrites existing selection', () => {
    repo.setSelection('user-1', { currentProjectId: 'p1' })
    repo.setSelection('user-1', { currentProjectId: 'p2' })
    expect(repo.getSelection('user-1').currentProjectId).toBe('p2')
  })

  it('clears a selection', () => {
    repo.setSelection('user-1', { currentProjectId: 'proj-1' })
    repo.clearSelection('user-1')
    const sel = repo.getSelection('user-1')
    expect(sel.currentProjectId).toBeUndefined()
  })

  it('clears threadId when projectId is absent', () => {
    repo.setSelection('user-1', {
      currentProjectId: undefined,
      currentThreadId: 'thread-1',
    })
    const sel = repo.getSelection('user-1')
    expect(sel.currentThreadId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Transaction safety: cascade delete
// ---------------------------------------------------------------------------

describe('Transaction safety', () => {
  it('cascade delete of project removes threads and agents', () => {
    const db = openTestDb()
    const sourceRepo = new SourceRepository(db)
    const projectRepo = new ProjectRepository(db)
    const threadRepo = new ThreadRepository(db)
    const agentRepo = new AgentRepository(db)
    const selectionRepo = new SelectionRepository(db)

    sourceRepo.createSource(makeSource())
    projectRepo.createProject(makeProject())
    threadRepo.createThread(makeThread())
    agentRepo.createAgent(makeAgent())
    selectionRepo.setSelection('s1', {
      currentProjectId: 'proj-1',
      currentThreadId: 'thread-1',
    })

    projectRepo.deleteProject('proj-1')

    expect(projectRepo.getProject('proj-1')).toBeUndefined()
    expect(threadRepo.getThread('thread-1')).toBeUndefined()
    expect(agentRepo.getAgent('agent-1')).toBeUndefined()
    // Selection should be cleared
    const sel = selectionRepo.getSelection('s1')
    expect(sel.currentProjectId).toBeUndefined()
    expect(sel.currentThreadId).toBeUndefined()
  })
})
