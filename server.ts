import dotenv from 'dotenv'
import { Bot, GrammyError, HttpError } from 'grammy'
import { chmodSync } from 'node:fs'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { ensureAllowedUser, cleanExpiredPairings } from './access.js'
import { SessionManager } from './session-manager.js'
import { DeliveryQueue, type StreamHandle } from './src/bot/delivery.js'
import { CallbackRouter } from './src/bot/callbacks/router.js'
import { createProjectCommands } from './src/bot/commands/project.js'
import { createThreadCommands } from './src/bot/commands/thread.js'
import { createAgentCommands } from './src/bot/commands/agent.js'
import { createRunCommands } from './src/bot/commands/run.js'
import { createSourceCommands } from './src/bot/commands/source.js'
import { createGeneralCommands } from './src/bot/commands/general.js'
import { createMessageHandlers } from './src/bot/commands/messages.js'
import { readAccessConfig } from './src/bot/middleware/auth.js'
import type { GetRunDisplayStatus } from './src/bot/views/formatting.js'
import { CodexBridge } from './src/core/codex-bridge.js'
import { AppServerClient } from './src/core/app-server-client.js'
import { RelayServer } from './src/core/relay-server.js'

// ─── Paths & constants ───────────────────────────────────────────────────────

const APP_DIR = dirname(fileURLToPath(import.meta.url))
const ENV_PATH = join(APP_DIR, '.env')
const WORKDIR = process.cwd()
const INBOX_DIR = join(homedir(), '.codex-telegram', 'inbox')
const UNLOCK_SWIFT = join(APP_DIR, 'unlock.swift')
const TG_SCREENSHOT = join(APP_DIR, 'scripts', 'tg-screenshot')
const APP_SERVER_INFO = join(homedir(), '.codex-telegram', 'app-server.json')
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000
const PROJECT_SYNC_INTERVAL_MS = 10 * 60 * 1000

// ─── Environment ─────────────────────────────────────────────────────────────

try {
  chmodSync(ENV_PATH, 0o600)
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}

dotenv.config({ path: ENV_PATH })

const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
const ownerTelegramId = process.env.OWNER_TELEGRAM_ID?.trim()

if (!token) throw new Error(`Missing TELEGRAM_BOT_TOKEN in ${ENV_PATH}`)

await mkdir(INBOX_DIR, { recursive: true })

if (ownerTelegramId) {
  if (ensureAllowedUser(ownerTelegramId)) {
    console.log(`[server] bootstrapped owner access for Telegram user ${ownerTelegramId}`)
  }
}

// ─── Bot & core services ────────────────────────────────────────────────────

const bot = new Bot(token)
const delivery = new DeliveryQueue(bot)

// ─── Codex App-Server ────────────────────────────────────────────────────────

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex')
const APP_SERVER_PORT = parseInt(process.env.CODEX_APP_SERVER_PORT || '0', 10)

const codexBridge = new CodexBridge({
  cwd: WORKDIR,
  codexHome: CODEX_HOME,
  port: APP_SERVER_PORT,
  clientName: 'codex-telegram',
  clientVersion: '1.0.0',
})

const appServerClient = new AppServerClient(codexBridge)
appServerClient.init()

// ─── Relay server (for connect.ts CLI ↔ Bot sync) ───────────────────────────
const relay = new RelayServer()

// Start bridge (non-blocking — bot works without it via spawn fallback)
codexBridge.start().then(async () => {
  console.log('[server] codex app-server connected via WebSocket')

  // Start relay server
  const relayPort = await relay.start()
  const relayUrl = `ws://127.0.0.1:${relayPort}`
  console.log(`[server] relay server listening on ${relayUrl}`)

  // Save both URLs so connect.ts can discover them
  const wsUrl = codexBridge.wsUrl
  await writeFile(
    APP_SERVER_INFO,
    JSON.stringify({ wsUrl, relayUrl, pid: process.pid }),
    'utf-8',
  )
  console.log(`[server] app-server info saved to ${APP_SERVER_INFO}`)
}).catch((error: Error) => {
  console.warn('[server] codex app-server failed to start, falling back to spawn mode:', error.message)
})

// ─── Session Manager ─────────────────────────────────────────────────────────

// Track active stream handles keyed by `${chatId}:${turnId}`
const activeStreams = new Map<string, StreamHandle>()

// Track pending stream creation promises (to handle the race where finalize is called
// before startStream resolves)
const pendingStreams = new Map<string, Promise<StreamHandle>>()

// Map chatId to turnIds for cleanup
const chatTurnMap = new Map<string, Set<string>>()

function getStreamKey(chatId: string, turnId: string): string {
  return `${chatId}:${turnId}`
}

async function finalizeStream(chatId: string, turnId: string, text: string): Promise<boolean> {
  const key = getStreamKey(chatId, turnId)

  // If stream is still being created, wait for it
  const pending = pendingStreams.get(key)
  if (pending) {
    pendingStreams.delete(key)
    try {
      const handle = await pending
      activeStreams.delete(key)
      const turns = chatTurnMap.get(chatId)
      turns?.delete(turnId)
      if (turns?.size === 0) chatTurnMap.delete(chatId)
      await handle.finalize(text)
      return true
    } catch {
      return false
    }
  }

  const handle = activeStreams.get(key)
  if (handle) {
    activeStreams.delete(key)
    const turns = chatTurnMap.get(chatId)
    turns?.delete(turnId)
    if (turns?.size === 0) chatTurnMap.delete(chatId)
    await handle.finalize(text).catch((err) => {
      console.error('[server] stream finalize error:', err)
    })
    return true
  }
  return false
}

async function finalizeAllStreamsForChat(chatId: string, text: string): Promise<boolean> {
  const turns = chatTurnMap.get(chatId)
  if (!turns || turns.size === 0) {
    // Check pending streams too
    let found = false
    for (const [key] of pendingStreams) {
      if (key.startsWith(`${chatId}:`)) {
        const turnId = key.slice(chatId.length + 1)
        if (await finalizeStream(chatId, turnId, text)) found = true
      }
    }
    return found
  }
  let finalized = false
  for (const turnId of [...turns]) {
    if (await finalizeStream(chatId, turnId, text)) {
      finalized = true
    }
  }
  return finalized
}

const sessionManager = new SessionManager(
  async (_userId, chatId, output) => {
    // If there's an active stream for this chat, finalize it instead of sending a new message
    if (!(await finalizeAllStreamsForChat(chatId, output))) {
      delivery.enqueue(chatId, output)
    }
  },
  {
    cwd: WORKDIR,
    sessionTimeoutMs: readAccessConfig().sessionTimeout,
    onStreamDelta: (_userId, chatId, delta, meta) => {
      const key = getStreamKey(chatId, meta.turnId)
      const existing = activeStreams.get(key)
      if (existing) {
        existing.appendDelta(delta)
      } else if (!pendingStreams.has(key)) {
        // First delta for this turn — create a stream
        const promise = delivery.startStream(chatId).then((handle) => {
          pendingStreams.delete(key)
          activeStreams.set(key, handle)
          let turns = chatTurnMap.get(chatId)
          if (!turns) {
            turns = new Set()
            chatTurnMap.set(chatId, turns)
          }
          turns.add(meta.turnId)
          handle.appendDelta(delta)
          return handle
        })
        pendingStreams.set(key, promise)
        promise.catch((err) => {
          pendingStreams.delete(key)
          console.error('[server] failed to start stream:', err)
        })
      } else {
        // Stream is being created — buffer the delta and append once ready
        void pendingStreams.get(key)!.then((handle) => {
          handle.appendDelta(delta)
        }).catch(() => {})
      }
    },
    onBotPrompt: (codexThreadId, turnId, text) => {
      relay.broadcast({ type: 'telegram-prompt', threadId: codexThreadId, turnId, text })
    },
  },
  appServerClient,
)

// ─── External turn forwarding + Relay ─────────────────────────────────────
// Relay-initiated turns: bot initiates on app-server, receives ALL events,
// forwards to both Telegram (external forwarding) and relay clients (broadcast).
// Bot-initiated turns (from Telegram): relay broadcasts so CLI sees them too.

const externalStreams = new Map<string, { chatId: string; buffer: string }>()

// For externally created threads, use the owner's chatId (private chat = userId)
const ownerChatId = ownerTelegramId ?? undefined

// Track relay-initiated turnIds (not in botTurnIds, but we know they came from relay)
const relayTurnIds = new Set<string>()

// ── Relay message handler ──────────────────────────────────────────────────
relay.on('message', async (msg: { type: string; [k: string]: unknown }, ws) => {
  try {
    if (msg.type === 'create-thread') {
      const thread = await appServerClient.threadStart({
        cwd: process.cwd(),
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      })
      // Auto-import into bot DB
      if (ownerChatId) {
        const existing = sessionManager.findChatByCodexThreadId(thread.id)
        if (!existing) {
          await sessionManager.importExternalThread(ownerChatId, thread.id, process.cwd())
        }
      }
      relay.send(ws, { type: 'thread-created', threadId: thread.id })
    } else if (msg.type === 'list-threads') {
      const result = await appServerClient.threadList()
      relay.send(ws, { type: 'threads', threads: result.threads })
    } else if (msg.type === 'prompt') {
      const threadId = msg.threadId as string
      const text = msg.text as string
      const turn = await appServerClient.turnStart(threadId, text)
      relayTurnIds.add(turn.id)
      relay.send(ws, { type: 'turn-started', threadId, turnId: turn.id })
    } else {
      relay.send(ws, { type: 'error', message: `unknown type: ${msg.type}` })
    }
  } catch (err) {
    relay.send(ws, { type: 'error', message: String(err) })
  }
})

// ── Auto-import externally created threads ─────────────────────────────────
appServerClient.on('thread:started', (event: { thread: { id: string; cwd?: string } }) => {
  if (!ownerChatId) return
  // Skip auto-import if the bot itself is creating a thread (via /new or relay create-thread)
  if (appServerClient.threadCreationInFlight > 0) return
  const codexThreadId = event.thread.id
  const existing = sessionManager.findChatByCodexThreadId(codexThreadId)
  if (existing) return

  console.log(`[server] external thread detected: ${codexThreadId}, auto-importing`)
  void sessionManager.importExternalThread(ownerChatId, codexThreadId, event.thread.cwd ?? process.cwd())
    .then(() => {
      delivery.enqueue(ownerChatId!, `🖥️ 本地新建了 thread\n\n🆔 \`${codexThreadId}\`\n\n已自动导入，直接发消息即可对话。`)
    })
    .catch((err) => console.error('[server] auto-import failed:', err))
})

// ── Stream forwarding (agent:delta) ────────────────────────────────────────
appServerClient.on('agent:delta', (event: { threadId: string; turnId: string; delta: string }) => {
  // Always broadcast to relay clients (CLI sees ALL turns)
  relay.broadcast({ type: 'delta', threadId: event.threadId, turnId: event.turnId, delta: event.delta })

  // For Telegram: skip bot-initiated turns (already handled by execution-engine streaming)
  if (sessionManager.botTurnIds.has(event.turnId)) return

  // External / relay turn → forward to Telegram
  const existing = externalStreams.get(event.turnId)
  if (existing) {
    existing.buffer += event.delta
    const key = getStreamKey(existing.chatId, event.turnId)
    const handle = activeStreams.get(key)
    if (handle) {
      handle.appendDelta(event.delta)
    } else if (pendingStreams.has(key)) {
      // Stream is being created — buffer delta and append once ready
      void pendingStreams.get(key)!.then((h) => h.appendDelta(event.delta)).catch(() => {})
    }
    return
  }

  // First delta for this external turn — find which chat owns this thread
  const chatId = sessionManager.findChatByCodexThreadId(event.threadId) ?? ownerChatId
  if (!chatId) return

  externalStreams.set(event.turnId, { chatId, buffer: event.delta })
  const key = getStreamKey(chatId, event.turnId)
  const promise = delivery.startStream(chatId).then((handle) => {
    pendingStreams.delete(key)
    activeStreams.set(key, handle)
    let turns = chatTurnMap.get(chatId)
    if (!turns) {
      turns = new Set()
      chatTurnMap.set(chatId, turns)
    }
    turns.add(event.turnId)
    // Replay buffered deltas
    const info = externalStreams.get(event.turnId)
    if (info) {
      handle.appendDelta(info.buffer)
    }
    return handle
  })
  pendingStreams.set(key, promise)
  promise.catch((err) => {
    pendingStreams.delete(key)
    console.error('[server] failed to start external stream:', err)
  })
})

// ── Turn completion ────────────────────────────────────────────────────────
appServerClient.on('turn:completed', (event: { threadId: string; turn: { id: string; status: string } }) => {
  // Always broadcast to relay clients
  relay.broadcast({ type: 'turn-completed', threadId: event.threadId, turnId: event.turn.id })

  // Cleanup relay tracking
  relayTurnIds.delete(event.turn.id)

  // For Telegram: skip bot-initiated turns
  if (sessionManager.botTurnIds.has(event.turn.id)) return

  const info = externalStreams.get(event.turn.id)
  if (info) {
    const finalText = info.buffer.trim() || '(external turn completed)'
    externalStreams.delete(event.turn.id)
    void finalizeStream(info.chatId, event.turn.id, `🖥️ 本地:\n${finalText}`).then((ok) => {
      if (!ok) {
        // Stream wasn't found — send as a new message
        delivery.enqueue(info.chatId, `🖥️ 本地:\n${finalText}`)
      }
    })
  }
})

// ── Item events (thinking, tool calls, etc.) ───────────────────────────────
appServerClient.on('item:started', (event: { threadId: string; turnId: string; item: { id: string; type: string; content?: unknown } }) => {
  relay.broadcast({ type: 'item-started', threadId: event.threadId, turnId: event.turnId, item: event.item })
})

appServerClient.on('item:completed', (event: { threadId: string; turnId: string; item: { id: string; type: string; content?: unknown } }) => {
  relay.broadcast({ type: 'item-completed', threadId: event.threadId, turnId: event.turnId, item: event.item })
})

const getRunDisplayStatus: GetRunDisplayStatus = (run) =>
  sessionManager.getRunDisplayStatus(run)

// ─── Callback router ────────────────────────────────────────────────────────

const callbackRouter = new CallbackRouter()
bot.on('callback_query:data', (ctx) => callbackRouter.route(ctx))

// ─── Command & handler composition ──────────────────────────────────────────

bot.use(createGeneralCommands(sessionManager, {
  workdir: WORKDIR,
  unlockSwiftPath: UNLOCK_SWIFT,
  tgScreenshotPath: TG_SCREENSHOT,
}, callbackRouter))
bot.use(createProjectCommands(sessionManager, callbackRouter))
bot.use(createThreadCommands(sessionManager, callbackRouter))
bot.use(createSourceCommands(sessionManager, callbackRouter))
bot.use(createAgentCommands(sessionManager, getRunDisplayStatus, callbackRouter))
bot.use(createRunCommands(sessionManager, getRunDisplayStatus, callbackRouter))
bot.use(createMessageHandlers(sessionManager, {
  botToken: token,
  inboxDir: INBOX_DIR,
}))

// ─── Error handler ──────────────────────────────────────────────────────────

bot.catch((error) => {
  const { ctx } = error
  console.error(
    `[server] Telegram update ${ctx.update.update_id} failed:`,
    error.error instanceof GrammyError || error.error instanceof HttpError
      ? error.error
      : error,
  )
  // Best-effort: notify the user about the error
  const msg = error.error instanceof Error ? error.error.message : String(error.error)
  ctx.reply(`❌ 内部错误: ${msg}`).catch(() => {/* ignore reply failure */})
})

// ─── Background tasks ───────────────────────────────────────────────────────

const cleanupTimer = setInterval(() => {
  const removedPairings = cleanExpiredPairings()
  const removedSessions = sessionManager.cleanup(readAccessConfig().sessionTimeout)

  if (removedPairings > 0 || removedSessions > 0) {
    console.log(
      `[server] cleanup: removed ${removedPairings} expired pairings, ${removedSessions} stale sessions`,
    )
  }
}, CLEANUP_INTERVAL_MS)
cleanupTimer.unref?.()

let backgroundSyncInFlight = false
const backgroundSyncTimer = setInterval(() => {
  if (backgroundSyncInFlight) return
  backgroundSyncInFlight = true
  void sessionManager
    .syncProjects()
    .then((summary) => {
      if (summary.addedProjects || summary.updatedProjects || summary.addedThreads || summary.updatedThreads) {
        console.log(
          `[server] background sync: sources=${summary.scannedSources}, rollouts=${summary.scannedRollouts}, +projects=${summary.addedProjects}, ~projects=${summary.updatedProjects}, +threads=${summary.addedThreads}, ~threads=${summary.updatedThreads}`,
        )
      }
    })
    .catch((error) => console.error('[server] background sync failed:', error))
    .finally(() => { backgroundSyncInFlight = false })
}, PROJECT_SYNC_INTERVAL_MS)
backgroundSyncTimer.unref?.()

// ─── Graceful shutdown ──────────────────────────────────────────────────────

let shuttingDown = false

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(cleanupTimer)
  clearInterval(backgroundSyncTimer)
  process.stdin.pause()
  console.log(`[server] shutting down (${reason})`)
  try { await bot.stop() } catch (error) { console.error('[server] failed to stop bot cleanly:', error) }
  relay.stop()
  sessionManager.killAll()
  await codexBridge.shutdown()
  await unlink(APP_SERVER_INFO).catch(() => {})
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.stdin.resume()
process.stdin.once('end', () => void shutdown('stdin end'))
process.stdin.once('close', () => void shutdown('stdin close'))

// ─── Start ──────────────────────────────────────────────────────────────────

await bot.init()

await bot.api.setMyCommands([
  { command: 'start', description: '开始使用' },
  { command: 'help', description: '使用说明' },
  { command: 'new', description: '新建 thread' },
  { command: 'project', description: '项目管理 [list|new|use|search|show|rename|archive|delete|sync|set-source]' },
  { command: 'thread', description: '线程管理 [list|new|use|search|history|turns|show|rename|move|pin|archive|delete]' },
  { command: 'agent', description: 'Agent 管理 [spawn|show|cancel|apply|search]' },
  { command: 'run', description: '运行管理 [list|show|cancel|retry|search]' },
  { command: 'source', description: '数据源管理 [list|show|enable|disable|search]' },
  { command: 'cwd', description: '当前工作目录' },
  { command: 'kill', description: '终止当前执行' },
  { command: 'cancel', description: '取消当前执行' },
  { command: 'undo', description: '撤销上一轮' },
  { command: 'pair', description: '配对授权 <code>' },
  { command: 'ss', description: '截图 [app]' },
  { command: 'unlock', description: '解锁屏幕' },
  { command: 'lock', description: '锁定屏幕' },
  { command: 'wake', description: '唤醒屏幕' },
  { command: 'windows', description: '列出窗口' },
])

console.log(`[server] bot @${bot.botInfo.username} starting long polling in ${WORKDIR}`)
await bot.start()
