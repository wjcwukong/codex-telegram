/**
 * connect.ts — CLI tool to connect to the bot's relay server for real-time sync.
 *
 * Usage:
 *   npm run connect --                  # list threads, pick one
 *   npm run connect -- <threadId>       # join an existing thread
 *   npm run connect -- --new            # create a new thread
 *
 * Messages sent here stream to Telegram in real-time.
 * Messages sent in Telegram also stream here.
 */

import { createInterface } from 'node:readline'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import WebSocket from 'ws'

const APP_SERVER_INFO = join(homedir(), '.codex-telegram', 'app-server.json')

// ─── ANSI colors ───────────────────────────────────────────────────

const RESET  = '\x1b[0m'
const BOLD   = '\x1b[1m'
const DIM    = '\x1b[2m'
const RED    = '\x1b[31m'
const GREEN  = '\x1b[32m'
const YELLOW = '\x1b[33m'
const BLUE   = '\x1b[34m'
const CYAN   = '\x1b[36m'
const ITALIC = '\x1b[3m'
const STRIKETHROUGH = '\x1b[9m'
const LIGHT_BLUE = '\x1b[94m'
const UNDERLINE    = '\x1b[4m'
const NO_UNDERLINE = '\x1b[24m'

// ─── Path helpers ─────────────────────────────────────────────────

function isLocalPath(url: string): boolean {
  return url.startsWith('/') || url.startsWith('./') || url.startsWith('../')
    || url.startsWith('~/') || url.startsWith('file://')
}

function shortenPath(filepath: string): string {
  let p = filepath.startsWith('file://') ? filepath.slice(7) : filepath
  const cwd = process.cwd()
  if (p.startsWith(cwd + '/')) {
    p = p.slice(cwd.length + 1)
  } else if (p.startsWith(cwd)) {
    p = p.slice(cwd.length)
    if (p.startsWith('/')) p = p.slice(1)
  }
  const home = process.env.HOME || ''
  if (home && p.startsWith(home + '/')) {
    p = '~/' + p.slice(home.length + 1)
  }
  return p || filepath
}

// ─── Display helpers ───────────────────────────────────────────────

function getBoxWidth(): number {
  const cols = process.stdout.columns || 80
  return Math.min(cols - 2, 72)
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

function banner(title: string, lines: string[]) {
  const bw = getBoxWidth()
  const inner = bw - 4
  const dash = '─'.repeat(Math.max(0, bw - title.length - 5))
  console.log(`\n${BOLD}${CYAN}╭─ ${title} ${dash}╮${RESET}`)
  for (const l of lines) {
    const vis = stripAnsi(l).length
    const pad = Math.max(0, inner - vis)
    console.log(`${CYAN}│${RESET}  ${l}${' '.repeat(pad)}${CYAN}│${RESET}`)
  }
  console.log(`${CYAN}╰${'─'.repeat(bw - 2)}╯${RESET}`)
}

const MAX_TREE_LINES = 0
const MAX_TREE_LINE_LEN = 200

function printTreeOutput(output: string) {
  const all = output.split('\n').filter(l => l.trim())
  const truncated = all.length > MAX_TREE_LINES
  const lines = all.slice(0, MAX_TREE_LINES)
  if (lines.length === 0) return
  if (lines.length === 1 && !truncated) {
    console.log(`${DIM}    └ ${RESET}${lines[0].slice(0, MAX_TREE_LINE_LEN)}`)
  } else {
    for (let i = 0; i < lines.length; i++) {
      const isLast = i === lines.length - 1 && !truncated
      const prefix = isLast ? '└' : '│'
      console.log(`${DIM}    ${prefix} ${RESET}${lines[i].slice(0, MAX_TREE_LINE_LEN)}`)
    }
    if (truncated) {
      console.log(`${DIM}    └ … ${all.length - MAX_TREE_LINES} more lines${RESET}`)
    }
  }
}

/** Print wrapped thinking text with │ indent prefix */
function printThinkingText(text: string) {
  const cols = getCols()
  const maxWidth = Math.min(cols - 8, 100) // comfortable reading width
  const pfx = `${DIM}  │ `
  const words = text.split(/\s+/)
  let line = ''
  for (const word of words) {
    if (line.length + word.length + 1 > maxWidth && line.length > 0) {
      console.log(`${pfx}${line}${RESET}`)
      line = word
    } else {
      line = line ? line + ' ' + word : word
    }
  }
  if (line) console.log(`${pfx}${line}${RESET}`)
}

function separator() {
  const bw = getBoxWidth()
  console.log(`${DIM}${'─'.repeat(bw)}${RESET}`)
}

// ─── Terminal Markdown Rendering ──────────────────────────────────

let mdInCodeBlock = false
let streamBuf = ''

function getCols(): number { return process.stdout.columns || 80 }

/** Render inline markdown: bold, italic, code, links */
function renderInline(text: string): string {
  text = text.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`)
  text = text.replace(/`([^`\n]+)`/g, `${CYAN}$1${RESET}`)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
    if (isLocalPath(url)) {
      const display = shortenPath(url)
      return `${CYAN}${display}${RESET}`
    }
    return `${CYAN}${UNDERLINE}${label}${NO_UNDERLINE}${RESET} ${DIM}(${url})${RESET}`
  })
  text = text.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, `${ITALIC}$1${RESET}`)
  return text
}

/** Word-wrap raw text to maxWidth, then apply inline rendering */
function wrapAndRender(text: string, maxWidth: number): string[] {
  if (text.length <= maxWidth) return [renderInline(text)]
  const words = text.split(/( +)/)
  const lines: string[] = []
  let cur = ''
  let curLen = 0
  for (const word of words) {
    if (curLen + word.length > maxWidth && curLen > 0) {
      lines.push(cur)
      cur = word.trimStart()
      curLen = cur.length
    } else {
      cur += word
      curLen += word.length
    }
  }
  if (cur.trim()) lines.push(cur)
  return lines.map(l => renderInline(l))
}

/** Render a single markdown line to the terminal with │ prefix */
function printMdLine(line: string): void {
  const cols = getCols()
  const contentWidth = cols - 5
  const pfx = `${BLUE}  │ ${RESET}`

  // Code block boundaries
  if (line.startsWith('```')) {
    if (!mdInCodeBlock) {
      mdInCodeBlock = true
      const lang = line.slice(3).trim()
      const label = lang || 'code'
      const bar = '─'.repeat(Math.max(0, contentWidth - label.length - 4))
      process.stdout.write(`${pfx}${DIM}┌─ ${label} ${bar}${RESET}\n`)
    } else {
      mdInCodeBlock = false
      process.stdout.write(`${pfx}${DIM}└${'─'.repeat(Math.max(0, contentWidth))}${RESET}\n`)
    }
    return
  }

  // Inside code block
  if (mdInCodeBlock) {
    process.stdout.write(`${pfx}${DIM}│ ${line}${RESET}\n`)
    return
  }

  // Empty line → paragraph break
  if (line.trim() === '') {
    process.stdout.write(`${pfx}\n`)
    return
  }

  // Determine line type → extract raw content and format each wrapped line
  let prefix = ''
  let raw: string
  let lineStyle: (s: string) => string = s => s

  if (line.startsWith('### ')) {
    raw = line.slice(4)
    lineStyle = s => `${BOLD}${ITALIC}${s}${RESET}`
  } else if (line.startsWith('## ')) {
    raw = line.slice(3)
    lineStyle = s => `${BOLD}${s}${RESET}`
  } else if (line.startsWith('# ')) {
    raw = line.slice(2)
    lineStyle = s => `${BOLD}${UNDERLINE}${s}${NO_UNDERLINE}${RESET}`
  } else if (/^\s+[-*]\s/.test(line)) {
    const indentLen = line.match(/^(\s+)/)![1].length
    prefix = `${' '.repeat(indentLen)}• `
    raw = line.replace(/^\s+[-*]\s/, '')
  } else if (/^[-*]\s/.test(line)) {
    prefix = `  • `
    raw = line.replace(/^[-*]\s/, '')
  } else if (/^\d+\.\s/.test(line)) {
    const m = line.match(/^(\d+)\.\s(.*)/)!
    prefix = `  ${LIGHT_BLUE}${m[1]}.${RESET} `
    raw = m[2]
  } else if (line.startsWith('> ')) {
    prefix = `${GREEN}▎ `
    raw = line.slice(2)
    lineStyle = s => `${s}${RESET}`
  } else if (/^---+$/.test(line.trim())) {
    process.stdout.write(`${pfx}${DIM}${'─'.repeat(Math.min(contentWidth, 40))}${RESET}\n`)
    return
  } else {
    raw = line
  }

  // Measure prefix visible width for continuation indent
  const prefixVisLen = stripAnsi(prefix).length
  const wrapWidth = contentWidth - prefixVisLen

  const wrapped = wrapAndRender(raw, wrapWidth)
  for (let i = 0; i < wrapped.length; i++) {
    const linePrefix = i === 0 ? prefix : ' '.repeat(prefixVisLen)
    process.stdout.write(`${pfx}${linePrefix}${lineStyle(wrapped[i])}\n`)
  }
}

// ─── Item data extractors (Codex app-server format) ──────────────

/** Any item from the Codex app-server */
type AppItem = Record<string, unknown>

function getCommand(item: AppItem): string {
  // commandExecution items have commandActions[0].command (user-facing)
  // and a top-level `command` (full /bin/zsh -lc ... wrapper)
  if (Array.isArray(item.commandActions)) {
    for (const a of item.commandActions as Array<Record<string, unknown>>) {
      if (typeof a.command === 'string') return a.command
    }
  }
  if (typeof item.command === 'string') {
    // Strip shell wrapper: "/bin/zsh -lc cmd" → "cmd"
    const raw = item.command as string
    const m = raw.match(/^\/bin\/\w+\s+-\w+\s+(.+)$/)
    return m ? m[1] : raw
  }
  return ''
}

function getOutput(item: AppItem): string {
  if (typeof item.aggregatedOutput === 'string') return item.aggregatedOutput
  return ''
}

function getThinkingText(item: AppItem): string {
  // agentMessage with phase "commentary" = thinking
  if (typeof item.text === 'string' && (item.text as string).trim()) return (item.text as string).trim()
  // Legacy: reasoning items with summary/content arrays
  if (Array.isArray(item.summary)) {
    for (const s of item.summary as unknown[]) {
      if (typeof s === 'string' && s.trim()) return s.trim()
      if (s && typeof s === 'object' && 'text' in (s as Record<string, unknown>)) {
        const text = String((s as Record<string, unknown>).text).trim()
        if (text) return text
      }
    }
  }
  if (Array.isArray(item.content)) {
    for (const c of item.content as unknown[]) {
      if (typeof c === 'string' && c.trim()) return c.trim()
      if (c && typeof c === 'object') {
        const obj = c as Record<string, unknown>
        if (typeof obj.text === 'string' && obj.text.trim()) return String(obj.text).trim()
      }
    }
  }
  return ''
}

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  // 1. Read relay URL from app-server.json
  let info: { relayUrl?: string; wsUrl?: string }
  try {
    info = JSON.parse(await readFile(APP_SERVER_INFO, 'utf-8'))
  } catch {
    console.error(`${RED}✗ Bot not running. Start the bot first (npx tsx server.ts).${RESET}`)
    console.error(`${DIM}  Expected info file at: ${APP_SERVER_INFO}${RESET}`)
    process.exit(1)
  }

  const relayUrl = info.relayUrl
  if (!relayUrl) {
    console.error(`${RED}✗ Bot is running but relay server not available. Restart the bot.${RESET}`)
    process.exit(1)
  }

  // 2. Connect to relay WebSocket
  const ws = new WebSocket(relayUrl)

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })

  // State
  let currentThreadId: string | undefined
  let streaming = false
  let suppressDelta = false  // suppress delta for commentary (thinking) items

  // 3. Handle incoming relay messages
  ws.on('message', (raw) => {
    let msg: { type: string; [k: string]: unknown }
    try {
      msg = JSON.parse(raw.toString())
    } catch { return }

    switch (msg.type) {
      case 'telegram-prompt': {
        if (msg.threadId !== currentThreadId) return
        const text = msg.text as string
        if (streaming) {
          process.stdout.write('\n')
          streaming = false
        }
        console.log(`\n${BOLD}${RED}  ← telegram:${RESET} ${text}`)
        break
      }
      case 'item-started': {
        if (msg.threadId !== currentThreadId) return
        const si = msg.item as AppItem
        if (si.type === 'commandExecution') {
          if (streaming) { process.stdout.write('\n'); streaming = false }
          const cmd = getCommand(si)
          console.log(`  • ${BOLD}Ran${RESET} ${cmd || '(command)'}`)
          suppressDelta = true
        } else if (si.type === 'reasoning') {
          // App-server reasoning items are always empty — suppress silently
          suppressDelta = true
        } else if (si.type === 'agentMessage' && si.phase === 'commentary') {
          if (streaming) { process.stdout.write('\n'); streaming = false }
          process.stdout.write(`${DIM}  ⏵ thinking...${RESET}`)
          suppressDelta = true
        } else if (si.type === 'agentMessage' && si.phase === 'final_answer') {
          suppressDelta = false
        } else if (si.type === 'fileEdit') {
          if (streaming) { process.stdout.write('\n'); streaming = false }
          console.log(`  • ${BOLD}Edited${RESET} ${CYAN}${shortenPath(String(si.filepath || si.file || si.path || ''))}${RESET}`)
          suppressDelta = true
        } else if (si.type === 'fileRead') {
          if (streaming) { process.stdout.write('\n'); streaming = false }
          console.log(`  • ${BOLD}Read${RESET} ${CYAN}${shortenPath(String(si.filepath || si.file || si.path || ''))}${RESET}`)
          suppressDelta = true
        }
        break
      }
      case 'item-completed': {
        if (msg.threadId !== currentThreadId) return
        const di = msg.item as AppItem
        if (di.type === 'commandExecution') {
          const output = getOutput(di)
          if (output.trim()) {
            printTreeOutput(output)
          }
        } else if (di.type === 'reasoning') {
          // Always-empty reasoning items — no output needed
        } else if (di.type === 'agentMessage' && di.phase === 'commentary') {
          process.stdout.write(`\r\x1b[K`)
          const text = getThinkingText(di)
          if (text) {
            console.log(`${DIM}  ⏷ thinking (done)${RESET}`)
            printThinkingText(text)
          } else {
            console.log(`${DIM}  ⏷ thinking (done)${RESET}`)
          }
        }
        // No separator after each item — let turn-completed handle the final divider
        break
      }
      case 'delta': {
        if (msg.threadId !== currentThreadId) return
        if (suppressDelta) break
        const delta = msg.delta as string
        if (!streaming) {
          streaming = true
          process.stdout.write('\n')
        }
        streamBuf += delta
        // Only render complete lines (newline-gated); partial lines wait for
        // the next delta or finalize so code-block state stays consistent.
        let nlIdx: number
        while ((nlIdx = streamBuf.indexOf('\n')) !== -1) {
          const line = streamBuf.slice(0, nlIdx)
          streamBuf = streamBuf.slice(nlIdx + 1)
          printMdLine(line)
        }
        break
      }
      case 'turn-completed': {
        if (msg.threadId !== currentThreadId) return
        // Finalize: flush remaining partial content
        if (streamBuf) {
          printMdLine(streamBuf)
          streamBuf = ''
        }
        mdInCodeBlock = false
        streaming = false
        console.log()
        separator()
        console.log()
        rl.prompt()
        break
      }
      case 'thread-created': {
        currentThreadId = msg.threadId as string
        console.log(`${GREEN}  ✓ thread${RESET} ${currentThreadId}`)
        console.log(`${DIM}    synced with Telegram${RESET}`)
        break
      }
      case 'threads': {
        const threads = msg.threads as Array<{ id: string; preview?: string }>
        if (threads.length === 0) {
          console.log(`${DIM}  No threads. Use --new to create one.${RESET}`)
        } else {
          console.log()
          threads.forEach((t, i) => {
            const mark = t.id === currentThreadId ? `${GREEN}▸ ` : `${DIM}  `
            const preview = t.preview ? ` ${DIM}— ${t.preview.slice(0, 50)}${RESET}` : ''
            console.log(`${mark}${i + 1}.${RESET} ${t.id}${preview}`)
          })
          console.log()
        }
        break
      }
      case 'turn-started':
        break
      case 'error':
        console.error(`\n${RED}  ✗ ${msg.message}${RESET}\n`)
        rl.prompt()
        break
    }
  })

  ws.on('close', () => {
    console.log(`\n${DIM}Disconnected.${RESET}`)
    process.exit(0)
  })

  // Helper to send a relay message and wait for a specific response type
  function sendRelay(msg: Record<string, unknown>): void {
    ws.send(JSON.stringify(msg))
  }

  function waitFor(type: string, timeoutMs = 10000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs)
      const handler = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === type) {
          clearTimeout(timer)
          ws.off('message', handler)
          resolve(msg)
        }
      }
      ws.on('message', handler)
    })
  }

  // 4. Parse args and enter thread
  const args = process.argv.slice(2)
  const isNew = args.includes('--new')
  const threadIdArg = args.find(a => !a.startsWith('-'))

  if (threadIdArg) {
    currentThreadId = threadIdArg
  } else if (isNew) {
    sendRelay({ type: 'create-thread' })
    const resp = await waitFor('thread-created')
    currentThreadId = resp.threadId as string
  } else {
    // List and pick
    sendRelay({ type: 'list-threads' })
    const resp = await waitFor('threads')
    const threads = resp.threads as Array<{ id: string; preview?: string }>
    if (threads.length === 0) {
      console.log(`${DIM}  No threads. Creating a new one...${RESET}`)
      sendRelay({ type: 'create-thread' })
      const r = await waitFor('thread-created')
      currentThreadId = r.threadId as string
    } else {
      threads.forEach((t, i) => {
        const preview = t.preview ? ` ${DIM}— ${t.preview.slice(0, 60)}${RESET}` : ''
        console.log(`  ${i + 1}. ${t.id}${preview}`)
      })
      console.log()
      const pick = await question(`${CYAN}Pick (1-${threads.length}) or 'n' for new:${RESET} `)
      if (pick === 'n') {
        sendRelay({ type: 'create-thread' })
        const r = await waitFor('thread-created')
        currentThreadId = r.threadId as string
      } else {
        const idx = parseInt(pick, 10) - 1
        if (idx < 0 || idx >= threads.length) {
          console.error(`${RED}✗ Invalid selection.${RESET}`)
          process.exit(1)
        }
        currentThreadId = threads[idx].id
      }
    }
  }

  // 5. Interactive REPL
  banner('codex-telegram', [
    `${DIM}relay${RESET}   ${relayUrl}`,
    `${DIM}thread${RESET}  ${currentThreadId!.slice(0, 36)}`,
  ])
  console.log(`${DIM}  Type a message and press Enter. Ctrl+C to exit.${RESET}\n`)

  if (process.stdin.isTTY) {
    rl.prompt()
  } else {
    process.stdin.on('end', () => {
      ws.close()
      process.exit(0)
    })
  }

  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) { rl.prompt(); return }

    if (text === '/threads') {
      sendRelay({ type: 'list-threads' })
      return
    }
    if (text.startsWith('/switch ')) {
      currentThreadId = text.slice(8).trim()
      console.log(`${GREEN}✓ Switched to thread: ${BOLD}${currentThreadId}${RESET}`)
      rl.prompt()
      return
    }

    console.log(`\n${BOLD}${BLUE}> ${RESET}${text}`)
    console.log()
    sendRelay({ type: 'prompt', threadId: currentThreadId, text })
  })

  rl.on('close', () => {
    ws.close()
    process.exit(0)
  })
}

// ─── Readline helpers ──────────────────────────────────────────────

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `${BOLD}${CYAN}› ${RESET}`,
})

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve)
  })
}

main().catch((err) => {
  console.error(`${RED}✗ Fatal:${RESET}`, err)
  process.exit(1)
})
