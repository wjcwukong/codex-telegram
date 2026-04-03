import { randomBytes } from 'node:crypto'

import { getDatabase } from './state-store.js'
import { AccessRepository } from './src/data/repositories/access-repo.js'

export interface AccessConfig {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, { requireMention: boolean; allowFrom: string[] }>
  pending: Record<
    string,
    { senderId: string; chatId: string; createdAt: number; expiresAt: number }
  >
  ackReaction: string
  sessionTimeout: number
}

const PAIRING_TTL_MS = 60 * 60 * 1000

function getRepo(): AccessRepository {
  return new AccessRepository(getDatabase())
}

function pruneExpiredPairings(config: AccessConfig, now = Date.now()): number {
  let removed = 0

  for (const [code, pairing] of Object.entries(config.pending)) {
    if (pairing.expiresAt <= now) {
      delete config.pending[code]
      removed += 1
    }
  }

  return removed
}

function hasAccess(
  config: AccessConfig,
  senderId: string,
  chatId: string,
  isGroup: boolean,
): boolean {
  if (config.allowFrom.includes(senderId)) {
    return true
  }

  if (!isGroup) {
    return false
  }

  return config.groups[chatId]?.allowFrom.includes(senderId) ?? false
}

function findPendingCode(
  config: AccessConfig,
  senderId: string,
  chatId: string,
  now: number,
): string | undefined {
  for (const [code, pairing] of Object.entries(config.pending)) {
    if (
      pairing.senderId === senderId &&
      pairing.chatId === chatId &&
      pairing.expiresAt > now
    ) {
      return code
    }
  }

  return undefined
}

function generatePairingCode(config: AccessConfig): string {
  let code = randomBytes(3).toString('hex')

  while (config.pending[code]) {
    code = randomBytes(3).toString('hex')
  }

  return code
}

export function loadAccess(): AccessConfig {
  return getRepo().getConfig()
}

export function saveAccess(config: AccessConfig): void {
  getRepo().updateConfig(config)
}

export function gate(
  senderId: string,
  chatId: string,
  isGroup: boolean,
): { allowed: boolean; pairingCode?: string } {
  const config = loadAccess()
  const now = Date.now()
  const removed = pruneExpiredPairings(config, now)

  if (hasAccess(config, senderId, chatId, isGroup)) {
    if (removed > 0) {
      saveAccess(config)
    }

    return { allowed: true }
  }

  if (isGroup || config.dmPolicy !== 'pairing') {
    if (removed > 0) {
      saveAccess(config)
    }

    return { allowed: false }
  }

  const existingCode = findPendingCode(config, senderId, chatId, now)
  if (existingCode) {
    if (removed > 0) {
      saveAccess(config)
    }

    return { allowed: false, pairingCode: existingCode }
  }

  const pairingCode = generatePairingCode(config)
  config.pending[pairingCode] = {
    senderId,
    chatId,
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
  }

  saveAccess(config)
  return { allowed: false, pairingCode }
}

export function isAuthorized(
  senderId: string,
  chatId: string,
  isGroup: boolean,
): boolean {
  const config = loadAccess()
  const removed = pruneExpiredPairings(config)

  if (removed > 0) {
    saveAccess(config)
  }

  return hasAccess(config, senderId, chatId, isGroup)
}

export function ensureAllowedUser(senderId: string): boolean {
  const normalizedSenderId = senderId.trim()

  if (!normalizedSenderId) {
    return false
  }

  const config = loadAccess()
  const removed = pruneExpiredPairings(config)
  let changed = removed > 0

  if (!config.allowFrom.includes(normalizedSenderId)) {
    config.allowFrom.push(normalizedSenderId)
    changed = true
  }

  if (changed) {
    saveAccess(config)
  }

  return changed
}

export function confirmPairing(code: string): boolean {
  const normalizedCode = code.trim().toLowerCase()
  if (!normalizedCode) {
    return false
  }

  const config = loadAccess()
  const removed = pruneExpiredPairings(config)
  const pairing = config.pending[normalizedCode]

  if (!pairing) {
    if (removed > 0) {
      saveAccess(config)
    }

    return false
  }

  if (!config.allowFrom.includes(pairing.senderId)) {
    config.allowFrom.push(pairing.senderId)
  }

  delete config.pending[normalizedCode]
  saveAccess(config)
  return true
}

export function cleanExpiredPairings(): number {
  const config = loadAccess()
  const removed = pruneExpiredPairings(config)

  if (removed > 0) {
    saveAccess(config)
  }

  return removed
}
