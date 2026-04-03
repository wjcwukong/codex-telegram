import type Database from 'better-sqlite3'
import type { AccessConfig } from '../../../access.js'

interface AccessRow {
  id: number
  dm_policy: string
  allow_from: string
  groups: string
  pending: string
  ack_reaction: string
  session_timeout: number
}

function toConfig(row: AccessRow): AccessConfig {
  return {
    dmPolicy: row.dm_policy as AccessConfig['dmPolicy'],
    allowFrom: JSON.parse(row.allow_from) as string[],
    groups: JSON.parse(row.groups) as AccessConfig['groups'],
    pending: JSON.parse(row.pending) as AccessConfig['pending'],
    ackReaction: row.ack_reaction,
    sessionTimeout: row.session_timeout,
  }
}

function defaultConfig(): AccessConfig {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
    ackReaction: '+1',
    sessionTimeout: 3_600_000,
  }
}

export class AccessRepository {
  constructor(private db: Database.Database) {}

  getConfig(): AccessConfig {
    const row = this.db
      .prepare('SELECT * FROM access_config WHERE id = 1')
      .get() as AccessRow | undefined
    return row ? toConfig(row) : defaultConfig()
  }

  updateConfig(patch: Partial<AccessConfig>): AccessConfig {
    const existing = this.getConfig()
    const updated: AccessConfig = { ...existing, ...patch }

    this.db
      .prepare(
        `INSERT INTO access_config (id, dm_policy, allow_from, groups, pending, ack_reaction, session_timeout)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           dm_policy = excluded.dm_policy,
           allow_from = excluded.allow_from,
           groups = excluded.groups,
           pending = excluded.pending,
           ack_reaction = excluded.ack_reaction,
           session_timeout = excluded.session_timeout`,
      )
      .run(
        updated.dmPolicy,
        JSON.stringify(updated.allowFrom),
        JSON.stringify(updated.groups),
        JSON.stringify(updated.pending),
        updated.ackReaction,
        updated.sessionTimeout,
      )

    return updated
  }
}
