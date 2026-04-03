import { Composer, InlineKeyboard, InputFile, type Context } from 'grammy'
import { unlink } from 'node:fs/promises'
import { execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { confirmPairing } from '../../../access.js'
import type { SessionManager, CancelResult } from '../../../session-manager.js'
import {
  ensureAuthorized,
  ensurePairingAuthorized,
  getUserId,
  getChatId,
} from '../middleware/auth.js'
import {
  PAIR,
  THREAD,
  CANCEL,
  UNDO,
  SCREEN,
  GENERAL,
  HELP_TOPICS,
} from '../i18n/zh.js'
import { buildMenuKeyboard, buildActionKeyboard } from '../views/keyboards.js'

export interface GeneralCommandsConfig {
  workdir: string
  unlockSwiftPath: string
  tgScreenshotPath: string
}

export function createGeneralCommands(
  sessionManager: SessionManager,
  config: GeneralCommandsConfig,
  router?: import('../callbacks/router.js').CallbackRouter,
): Composer<Context> {
  const composer = new Composer<Context>()

  composer.command('start', async (ctx) => {
    await ctx.reply(GENERAL.WELCOME_NAV, {
      reply_markup: buildMainNavKeyboard(),
    })
  })

  composer.command('help', async (ctx) => {
    await ctx.reply(GENERAL.HELP_MENU, {
      reply_markup: buildHelpMenuKeyboard(),
    })
  })

  composer.command('pair', async (ctx) => {
    if (!ensurePairingAuthorized(ctx)) {
      await ctx.reply(PAIR.ONLY_AUTHORIZED)
      return
    }

    const code = getCommandArg(ctx)

    if (!code) {
      await ctx.reply(PAIR.USAGE)
      return
    }

    if (!confirmPairing(code)) {
      await ctx.reply(PAIR.INVALID_CODE)
      return
    }

    await ctx.reply(PAIR.SUCCESS)
  })

  composer.command('new', async (ctx) => {
    if (!(await ensureAuthorized(ctx))) {
      return
    }

    const userId = getUserId(ctx)
    const chatId = getChatId(ctx)
    const { session, codexThreadId } = await sessionManager.createThread(userId, chatId)
    await ctx.reply(THREAD.NEW_THREAD(session.cwd, codexThreadId), { parse_mode: 'Markdown' })
  })

  composer.command('cwd', async (ctx) => {
    if (!(await ensureAuthorized(ctx))) {
      return
    }

    await ctx.reply(await sessionManager.getCurrentCwd(getUserId(ctx), getChatId(ctx)))
  })

  composer.command('kill', async (ctx) => {
    if (!(await ensureAuthorized(ctx))) {
      return
    }

    const result = await sessionManager.cancelCurrentExecution(
      getUserId(ctx),
      getChatId(ctx),
    )
    await ctx.reply(renderCancelMessage(result), {
      reply_markup: buildPostCancelKeyboard(),
    })
  })

  composer.command('cancel', async (ctx) => {
    if (!(await ensureAuthorized(ctx))) {
      return
    }

    const result = await sessionManager.cancelCurrentExecution(
      getUserId(ctx),
      getChatId(ctx),
    )
    await ctx.reply(renderCancelMessage(result), {
      reply_markup: buildPostCancelKeyboard(),
    })
  })

  composer.command('undo', async (ctx) => {
    if (!(await ensureAuthorized(ctx))) {
      return
    }

    try {
      const result = await sessionManager.undoLastTurn(
        getUserId(ctx),
        getChatId(ctx),
      )
      const kb = buildMenuKeyboard([
        { label: '💬 查看 Thread', data: 't:menu' },
        { label: '📜 查看历史', data: 't:history' },
      ])
      kb.text('🏠 主菜单', 'g:menu').row()
      await ctx.reply(
        [
          `${result.mode === 'rewritten' ? UNDO.MODE_REWRITTEN : UNDO.MODE_HIDDEN}: ${result.thread.title}`,
          `turn: #${result.turn.index}`,
          `entries hidden: ${result.hiddenEntryCount}`,
          `user: ${result.turn.userEntry?.text ?? '-'}`,
          `running killed: ${result.cancel.killedRunning}`,
          `queued cleared: ${result.cancel.clearedQueued}`,
          result.mode === 'rewritten'
            ? `rewritten files: ${result.rewrittenFiles ?? 0}`
            : UNDO.NOTE_LOCAL_ONLY,
        ].join('\n'),
        { reply_markup: kb },
      )
    } catch (error) {
      await ctx.reply(UNDO.FAIL((error as Error).message))
    }
  })

  // ─── Screen / device commands ────────────────────────────────────────────────

  composer.command('unlock', async (ctx) => {
    if (!(await ensureAuthorized(ctx))) {
      return
    }

    const password = process.env.SCREEN_PASSWORD?.trim()
    if (!password) {
      await ctx.reply(SCREEN.NO_PASSWORD)
      return
    }

    await ctx.reply(SCREEN.UNLOCK_PROGRESS)

    try {
      await wakeAndUnlock(password, config.unlockSwiftPath)
      await ctx.reply(SCREEN.UNLOCK_DONE)
    } catch (error) {
      await ctx.reply(SCREEN.UNLOCK_FAIL((error as Error).message))
    }
  })

  composer.command('wake', async (ctx) => {
    if (!(await ensureAuthorized(ctx))) {
      return
    }

    try {
      execFileSync('caffeinate', ['-u', '-t', '10'], { timeout: 15000 })
      await ctx.reply(SCREEN.WAKE_DONE)
    } catch (error) {
      await ctx.reply(SCREEN.WAKE_FAIL((error as Error).message))
    }
  })

  composer.command('lock', async (ctx) => {
    if (!(await ensureAuthorized(ctx))) {
      return
    }

    try {
      execFileSync('pmset', ['displaysleepnow'], { timeout: 10000 })
      await ctx.reply(SCREEN.LOCK_DONE)
    } catch (error) {
      await ctx.reply(SCREEN.LOCK_FAIL((error as Error).message))
    }
  })

  composer.command('windows', async (ctx) => {
    if (!(await ensureAuthorized(ctx))) {
      return
    }

    try {
      const list = listWindows()
      await ctx.reply(SCREEN.WINDOWS_LIST(list))
    } catch (error) {
      await ctx.reply(SCREEN.WINDOWS_FAIL((error as Error).message))
    }
  })

  composer.command('ss', async (ctx) => {
    if (!(await ensureAuthorized(ctx))) {
      return
    }

    const app = getCommandArg(ctx)

    await ctx.reply(app ? SCREEN.SS_APP_PROGRESS(app) : SCREEN.SS_FULL_PROGRESS)

    try {
      const output = `/tmp/tg_bot_ss_${Date.now()}.png`
      const args: string[] = []
      if (app) args.push('--app', app)
      args.push('-o', output)

      execFileSync(config.tgScreenshotPath, args, { timeout: 45000 })

      const compressed = await compressImage(output)
      await ctx.replyWithPhoto(new InputFile(compressed))
      await unlink(output).catch(() => {})
      if (compressed !== output) await unlink(compressed).catch(() => {})
    } catch (error) {
      await ctx.reply(SCREEN.SCREENSHOT_FAIL((error as Error).message))
    }
  })

  router?.register('g', async (ctx, parts) => {
    const action = parts[0]

    if (action === 'menu') {
      await safeEditGeneral(
        ctx,
        GENERAL.WELCOME_NAV,
        buildMainNavKeyboard(),
      )
      return
    }

    if (action === 'help') {
      const topic = parts[1]
      if (!topic) {
        await safeEditGeneral(
          ctx,
          GENERAL.HELP_MENU,
          buildHelpMenuKeyboard(),
        )
        return
      }

      const content = HELP_TOPICS[topic]
      if (!content) return

      const kb = buildActionKeyboard([
        { label: '🔙 返回帮助', data: 'g:help' },
      ])
      await safeEditGeneral(ctx, content, kb)
      return
    }

    // g:noop — used by pagination display buttons
  })

  return composer
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildMainNavKeyboard(): InlineKeyboard {
  return buildMenuKeyboard([
    { label: '📁 Projects', data: 'p:menu' },
    { label: '💬 Threads', data: 't:menu' },
    { label: '🤖 Agents', data: 'a:menu' },
    { label: '🏃 Runs', data: 'r:menu' },
    { label: '📦 Sources', data: 's:list' },
    { label: '❓ Help', data: 'g:help' },
  ])
}

function buildHelpMenuKeyboard(): InlineKeyboard {
  return buildMenuKeyboard([
    { label: '📁 项目管理', data: 'g:help:project' },
    { label: '💬 线程管理', data: 'g:help:thread' },
    { label: '🤖 Agent', data: 'g:help:agent' },
    { label: '🏃 运行管理', data: 'g:help:run' },
    { label: '📦 数据源', data: 'g:help:source' },
    { label: '🔑 权限与配对', data: 'g:help:access' },
    { label: '💡 使用技巧', data: 'g:help:tips' },
  ])
}

function buildPostCancelKeyboard(): InlineKeyboard {
  const kb = buildMenuKeyboard([
    { label: '💬 当前 Thread', data: 't:menu' },
    { label: '📁 当前 Project', data: 'p:menu' },
  ])
  kb.text('🏠 主菜单', 'g:menu').row()
  return kb
}

async function safeEditGeneral(
  ctx: Context,
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  try {
    await ctx.editMessageText(text, { reply_markup: keyboard })
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('message is not modified')
    ) {
      return
    }
    throw error
  }
}

function getCommandArg(ctx: Context): string {
  return ctx.message?.text?.split(/\s+/).slice(1).join(' ').trim() ?? ''
}

function renderCancelMessage(result: CancelResult): string {
  if (!result.hadThread) {
    return CANCEL.NO_THREAD
  }

  if (!result.killedRunning && !result.clearedQueued) {
    return CANCEL.NOTHING_RUNNING
  }

  if (result.killedRunning && result.clearedQueued) {
    return CANCEL.KILLED_AND_CLEARED
  }

  if (result.killedRunning) {
    return CANCEL.KILLED
  }

  return CANCEL.CLEARED
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function wakeAndUnlock(password: string, unlockSwiftPath: string): Promise<void> {
  const keepAlive = nodeSpawn('bash', ['-c', 'for i in $(seq 1 30); do caffeinate -u -t 5 & sleep 1; done'], {
    stdio: 'ignore',
    detached: true,
  })
  keepAlive.unref()

  await sleep(1000)

  try {
    execFileSync(
      'osascript',
      ['-e', 'tell application "System Events" to key code 49'],
      { timeout: 5000 },
    )
  } catch {}

  await sleep(3000)

  execFileSync('swift', [unlockSwiftPath, password], { timeout: 15000 })

  await sleep(3000)

  try { process.kill(-keepAlive.pid!, 'SIGTERM') } catch {}
}

function listWindows(): string {
  const result = execFileSync('swift', ['-e', `
import Cocoa
let exclude: Set<String> = [
    "Window Server", "程序坞", "控制中心", "通知中心",
    "聚焦", "loginwindow", "控制中心帮助程序",
    "universalAccessAuthWarn", "AutoFill", "自动填充",
    "辅助功能", "CursorUIViewService", "Open and Save Panel Service",
    "AuthenticationServicesHelper", "App Cleaner Helper",
    "Raycast", "微信输入法", "Wi-Fi",
    "Doubao Browser Accessory", "歐路詞典 鼠標取詞"
]
let o: CGWindowListOption = [.optionAll, .excludeDesktopElements]
if let l = CGWindowListCopyWindowInfo(o, kCGNullWindowID) as? [[String:Any]] {
    var seen = Set<String>()
    for w in l {
        if let n = w["kCGWindowOwnerName"] as? String,
           let layer = w["kCGWindowLayer"] as? Int, layer == 0,
           !exclude.contains(n), !seen.contains(n) {
            seen.insert(n)
            print(n)
        }
    }
}
`], {
    timeout: 10000,
    encoding: 'utf8',
  }).trim()
  return result || SCREEN.NO_WINDOWS
}

async function compressImage(inputPath: string): Promise<string> {
  const outputPath = inputPath.replace('.png', '_sm.png')
  try {
    execFileSync('python3', ['-c', `
from PIL import Image
import sys

input_path, output_path = sys.argv[1], sys.argv[2]
img = Image.open(input_path)
if img.width > 2560:
    img = img.resize((img.width//2, img.height//2), Image.LANCZOS)
img.save(output_path, optimize=True)
`, inputPath, outputPath], { timeout: 10000 })
    return outputPath
  } catch {
    return inputPath
  }
}
