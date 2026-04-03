/**
 * relay-server.ts — lightweight WebSocket relay for CLI ↔ Bot sync.
 *
 * The bot is the single client to the codex app-server.  CLI tools
 * (connect.ts) connect here instead and send JSON messages.  The bot
 * initiates turns on their behalf, then broadcasts streaming events
 * back to *all* connected relay clients AND to Telegram.
 *
 * ── Relay protocol (JSON over WS) ──────────────────────────────────
 *
 * Client → Server
 *   { type: "create-thread" }
 *   { type: "list-threads" }
 *   { type: "prompt", threadId: string, text: string }
 *
 * Server → Client
 *   { type: "thread-created",  threadId: string }
 *   { type: "threads",         threads: object[] }
 *   { type: "turn-started",    threadId: string, turnId: string }
 *   { type: "delta",           threadId: string, turnId: string, delta: string }
 *   { type: "turn-completed",  threadId: string, turnId: string }
 *   { type: "error",           message: string }
 */

import { WebSocketServer, WebSocket } from 'ws'
import { EventEmitter } from 'events'

export interface RelayMessage {
  type: string
  [key: string]: unknown
}

export class RelayServer extends EventEmitter {
  private wss: WebSocketServer | null = null
  private clients = new Set<WebSocket>()

  /** Start on an OS-assigned port.  Returns the port number. */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: 0 })

      this.wss.on('listening', () => {
        const addr = this.wss!.address() as { port: number }
        resolve(addr.port)
      })

      this.wss.on('error', reject)

      this.wss.on('connection', (ws) => {
        this.clients.add(ws)
        console.log(`[relay] client connected (total: ${this.clients.size})`)

        ws.on('close', () => {
          this.clients.delete(ws)
          console.log(`[relay] client disconnected (total: ${this.clients.size})`)
        })

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString()) as RelayMessage
            this.emit('message', msg, ws)
          } catch {
            this.send(ws, { type: 'error', message: 'invalid JSON' })
          }
        })
      })
    })
  }

  /** Send a message to ALL connected relay clients. */
  broadcast(msg: RelayMessage): void {
    const data = JSON.stringify(msg)
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    }
  }

  /** Send a message to one specific client. */
  send(ws: WebSocket, msg: RelayMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  get clientCount(): number {
    return this.clients.size
  }

  stop(): void {
    for (const ws of this.clients) ws.close()
    this.clients.clear()
    this.wss?.close()
    this.wss = null
  }
}
