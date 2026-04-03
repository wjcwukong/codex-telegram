/**
 * One-shot migration: JSON state files → SQLite.
 *
 * Reads state/state.json, access.json, state/import-cursor.json and inserts
 * every record into the SQLite database via the repository layer.
 *
 * Safe to run repeatedly — uses INSERT OR IGNORE / upserts so pre-existing
 * rows are left untouched.
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { openDatabase } from './database.js'
import { SourceRepository } from './repositories/source-repo.js'
import { ProjectRepository } from './repositories/project-repo.js'
import { ThreadRepository } from './repositories/thread-repo.js'
import { AgentRepository } from './repositories/agent-repo.js'
import { SelectionRepository } from './repositories/selection-repo.js'
import { AccessRepository } from './repositories/access-repo.js'
import { CursorRepository } from './repositories/cursor-repo.js'
import type { PersistedState } from '../../models.js'
import type { AccessConfig } from '../../access.js'
import type { SourceCursor } from '../../import-cursor.js'

export interface MigrationResult {
  sources: number
  projects: number
  threads: number
  agents: number
  selections: number
  accessConfig: boolean
  importCursors: number
  skipped: { sources: number; projects: number; threads: number; agents: number }
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  if (!existsSync(path)) {
    return undefined
  }
  try {
    const raw = await readFile(path, 'utf8')
    return raw.trim() ? (JSON.parse(raw) as T) : undefined
  } catch {
    return undefined
  }
}

export async function migrateJsonToSqlite(stateDir?: string): Promise<MigrationResult> {
  const dir = stateDir ?? join(homedir(), '.codex-telegram')
  const db = openDatabase()

  // ── Read JSON files ──────────────────────────────────────────────────
  const stateJson = await readJsonFile<PersistedState>(join(dir, 'state', 'state.json'))
  const accessJson = await readJsonFile<AccessConfig>(join(dir, 'access.json'))
  const cursorJson = await readJsonFile<{ sources: Record<string, SourceCursor> }>(
    join(dir, 'state', 'import-cursor.json'),
  )

  // ── Repositories ─────────────────────────────────────────────────────
  const sourceRepo = new SourceRepository(db)
  const projectRepo = new ProjectRepository(db)
  const threadRepo = new ThreadRepository(db)
  const agentRepo = new AgentRepository(db)
  const selectionRepo = new SelectionRepository(db)
  const accessRepo = new AccessRepository(db)
  const cursorRepo = new CursorRepository(db)

  const result: MigrationResult = {
    sources: 0,
    projects: 0,
    threads: 0,
    agents: 0,
    selections: 0,
    accessConfig: false,
    importCursors: 0,
    skipped: { sources: 0, projects: 0, threads: 0, agents: 0 },
  }

  // ── Wrap the whole migration in one transaction for atomicity ────────
  const migrate = db.transaction(() => {
    // 1) Sources (FK target for projects, threads, agents)
    if (stateJson?.sources) {
      for (const source of Object.values(stateJson.sources)) {
        if (sourceRepo.getSource(source.id)) {
          result.skipped.sources++
          continue
        }
        sourceRepo.createSource(source)
        result.sources++
      }
    }

    // 2) Projects
    if (stateJson?.projects) {
      for (const project of Object.values(stateJson.projects)) {
        if (projectRepo.getProject(project.id)) {
          result.skipped.projects++
          continue
        }
        projectRepo.createProject(project)
        result.projects++
      }
    }

    // 3) Threads
    if (stateJson?.threads) {
      for (const thread of Object.values(stateJson.threads)) {
        if (threadRepo.getThread(thread.id)) {
          result.skipped.threads++
          continue
        }
        threadRepo.createThread(thread)
        result.threads++
      }
    }

    // 4) Agents
    if (stateJson?.agents) {
      for (const agent of Object.values(stateJson.agents)) {
        if (agentRepo.getAgent(agent.id)) {
          result.skipped.agents++
          continue
        }
        agentRepo.createAgent(agent)
        result.agents++
      }
    }

    // 5) Selections
    if (stateJson?.selections) {
      for (const [sessionKey, selection] of Object.entries(stateJson.selections)) {
        selectionRepo.setSelection(sessionKey, selection)
        result.selections++
      }
    }

    // 6) Access config
    if (accessJson) {
      accessRepo.updateConfig(accessJson)
      result.accessConfig = true
    }

    // 7) Import cursors
    if (cursorJson?.sources) {
      for (const [sourceId, cursor] of Object.entries(cursorJson.sources)) {
        cursorRepo.setCursor(sourceId, cursor)
        result.importCursors++
      }
    }
  })

  migrate()
  db.close()
  return result
}

// ── Standalone execution ─────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  migrateJsonToSqlite()
    .then((result) => {
      console.log('Migration complete:')
      console.log(`  Sources:        ${result.sources} inserted, ${result.skipped.sources} skipped`)
      console.log(`  Projects:       ${result.projects} inserted, ${result.skipped.projects} skipped`)
      console.log(`  Threads:        ${result.threads} inserted, ${result.skipped.threads} skipped`)
      console.log(`  Agents:         ${result.agents} inserted, ${result.skipped.agents} skipped`)
      console.log(`  Selections:     ${result.selections}`)
      console.log(`  Access config:  ${result.accessConfig ? 'migrated' : 'not found'}`)
      console.log(`  Import cursors: ${result.importCursors}`)
    })
    .catch((err) => {
      console.error('Migration failed:', err)
      process.exit(1)
    })
}
