import { Composer, type Context } from 'grammy'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { SessionManager } from '../../../session-manager.js'
import {
  getUserId,
  getChatId,
  authorizeMessage,
} from '../middleware/auth.js'
import { acknowledge } from '../middleware/ack.js'
import { detectSlashlessCommand } from '../middleware/helpers.js'
import { GENERAL } from '../i18n/zh.js'

export interface MessageHandlersConfig {
  botToken: string
  inboxDir: string
}

export function createMessageHandlers(
  sessionManager: SessionManager,
  config: MessageHandlersConfig,
): Composer<Context> {
  const composer = new Composer<Context>()

  composer.on('message:text', async (ctx) => {
    const decision = await authorizeMessage(ctx)

    if (!decision.allowed) {
      return
    }

    const slashlessCommand = detectSlashlessCommand(ctx.message.text)
    if (slashlessCommand) {
      await ctx.reply(
        GENERAL.LOOKS_LIKE_COMMAND(slashlessCommand),
      )
      return
    }

    void acknowledge(ctx)

    const userId = getUserId(ctx)
    const chatId = getChatId(ctx)
    try {
      await sessionManager.sendInput(userId, chatId, ctx.message.text)
    } catch (err: unknown) {
      await replySendInputError(ctx, err, '[messages] sendInput failed:')
    }
  })

  composer.on('message:document', async (ctx) => {
    const decision = await authorizeMessage(ctx)

    if (!decision.allowed) {
      return
    }

    const savedPath = await downloadDocument(ctx, config.botToken, config.inboxDir)

    void acknowledge(ctx)

    const userId = getUserId(ctx)
    const chatId = getChatId(ctx)
    try {
      await sessionManager.sendInput(userId, chatId, savedPath)
    } catch (err: unknown) {
      await replySendInputError(ctx, err, '[messages] sendInput (document) failed:')
    }
  })

  return composer
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function downloadDocument(
  ctx: Context,
  botToken: string,
  inboxDir: string,
): Promise<string> {
  const document = ctx.message?.document

  if (!document) {
    throw new Error('Document payload is missing')
  }

  const file = await ctx.getFile()

  if (!file.file_path) {
    throw new Error('Telegram did not provide a file_path for this document')
  }

  const response = await fetch(
    `https://api.telegram.org/file/bot${botToken}/${file.file_path}`,
  )

  if (!response.ok) {
    throw new Error(
      `Telegram file download failed with status ${response.status} ${response.statusText}`,
    )
  }

  const originalName = basename(document.file_name?.trim() || file.file_path)
  const safeName = sanitizeFileName(originalName || `${document.file_unique_id}.bin`)
  const targetPath = join(
    inboxDir,
    `${Date.now()}-${document.file_unique_id}-${safeName}`,
  )
  const body = await response.arrayBuffer()

  await writeFile(targetPath, Buffer.from(body))
  return targetPath
}

async function replySendInputError(
  ctx: Context,
  err: unknown,
  logPrefix: string,
): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('No active project')) {
    await ctx.reply('⚠️ 当前没有激活 project。先用 /project list 选择一个项目，或发送 /start 开始。')
    return
  }
  if (msg.startsWith('Thread busy:')) {
    await ctx.reply(`⚠️ ${msg.slice('Thread busy:'.length).trim()}`)
    return
  }
  console.error(logPrefix, msg)
  await ctx.reply(`❌ 执行失败: ${msg}`)
}

function sanitizeFileName(name: string): string {
  const sanitized = name
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .replace(/[\\/:%*?"<>|]/g, '_')
    .replace(/\s+/g, '_')

  return sanitized || 'upload.bin'
}
