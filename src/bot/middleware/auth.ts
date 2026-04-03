import type { Context } from 'grammy'
import { gate, isAuthorized, loadAccess, saveAccess } from '../../../access.js'
import { PAIR } from '../i18n/zh.js'

export type AccessDecision = { allowed: boolean; pairingCode?: string }

const ACK_REACTION_ALIASES = new Map<string, string>([
  ['+1', '👍'],
  ['thumbsup', '👍'],
  ['thumbs_up', '👍'],
  ['heart', '❤'],
  ['fire', '🔥'],
])

function normalizeAckReaction(value: string): string {
  const trimmed = value.trim()

  if (!trimmed) {
    return '👍'
  }

  return ACK_REACTION_ALIASES.get(trimmed.toLowerCase()) ?? trimmed
}

export function readAccessConfig() {
  const access = loadAccess()
  const normalizedAckReaction = normalizeAckReaction(access.ackReaction)

  if (normalizedAckReaction !== access.ackReaction) {
    access.ackReaction = normalizedAckReaction
    saveAccess(access)
  }

  return access
}

export function getUserId(ctx: Context): string {
  if (!ctx.from) {
    throw new Error('Cannot handle update without sender information')
  }

  return String(ctx.from.id)
}

export function getChatId(ctx: Context): string {
  if (!ctx.chat) {
    throw new Error('Cannot handle update without chat information')
  }

  return String(ctx.chat.id)
}

export function isGroupChat(ctx: Context): boolean {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup'
}

export function ensurePairingAuthorized(ctx: Context): boolean {
  return isAuthorized(getUserId(ctx), getChatId(ctx), isGroupChat(ctx))
}

export async function ensureAuthorized(ctx: Context): Promise<boolean> {
  const decision = gate(getUserId(ctx), getChatId(ctx), isGroupChat(ctx))

  if (decision.allowed) {
    return true
  }

  if (decision.pairingCode) {
    await replyWithPairingCode(ctx, decision.pairingCode)
  }

  return false
}

export async function authorizeMessage(ctx: Context): Promise<AccessDecision> {
  const decision = gate(getUserId(ctx), getChatId(ctx), isGroupChat(ctx))

  if (!decision.allowed && decision.pairingCode) {
    await replyWithPairingCode(ctx, decision.pairingCode)
  }

  return decision
}

export async function replyWithPairingCode(ctx: Context, pairingCode: string): Promise<void> {
  await ctx.reply(
    [
      PAIR.CODE_PROMPT(pairingCode),
      PAIR.CODE_INSTRUCTION(pairingCode),
    ].join('\n'),
  )
}
