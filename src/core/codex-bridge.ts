/**
 * codex-bridge.ts — WebSocket bridge to the Codex app-server.
 *
 * Manages the lifecycle of a `codex app-server` child process,
 * connects via WebSocket, and implements the JSON-RPC 2.0
 * request/response protocol with auto-reconnect.
 */

import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import WebSocket from 'ws'

// ─── JSON-RPC Types ────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  method: string
  id: number
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

// ─── Bridge Options ────────────────────────────────────────────────

export interface CodexBridgeOptions {
  /** Port for app-server WebSocket. Default: 0 (auto-assign) */
  port?: number
  /** Path to codex binary. Default: 'codex' */
  codexBin?: string
  /** Working directory for app-server */
  cwd: string
  /** CODEX_HOME directory */
  codexHome?: string
  /** Client name for the initialize handshake */
  clientName?: string
  /** Client version */
  clientVersion?: string
  /** Reconnect delay in milliseconds. Default: 2000 */
  reconnectDelayMs?: number
  /** Max reconnect attempts. Default: 10 */
  maxReconnectAttempts?: number
}

// ─── Internal Types ────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type NotificationHandler = (params: Record<string, unknown>) => void

const LOG_TAG = '[codex-bridge]'
const REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_RECONNECT_DELAY_MS = 2_000
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10

// ─── CodexBridge ───────────────────────────────────────────────────

/**
 * WebSocket bridge to a Codex app-server process.
 *
 * Emits:
 * - `connected`              — WebSocket opened and handshake complete
 * - `disconnected`           — WebSocket closed
 * - `notification`           — any JSON-RPC notification (method, params)
 * - `error`                  — transport or protocol error
 * - `process-exit`           — app-server process exited (code, signal)
 *
 * @example
 * ```ts
 * const bridge = new CodexBridge({ cwd: '/my/project' })
 * await bridge.start()
 * const result = await bridge.request('someMethod', { key: 'value' })
 * await bridge.shutdown()
 * ```
 */
export class CodexBridge extends EventEmitter {
  // Config
  private readonly port: number
  private readonly codexBin: string
  private readonly cwd: string
  private readonly codexHome: string | undefined
  private readonly clientName: string
  private readonly clientVersion: string
  private readonly reconnectDelayMs: number
  private readonly maxReconnectAttempts: number

  // Runtime state
  private process: ChildProcess | null = null
  private ws: WebSocket | null = null
  private nextId = 1
  private resolvedPort = 0
  private pendingRequests = new Map<number, PendingRequest>()
  private notificationHandlers = new Map<string, Set<NotificationHandler>>()
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private shuttingDown = false
  private initialized = false

  constructor(options: CodexBridgeOptions) {
    super()
    this.port = options.port ?? 0
    this.codexBin = options.codexBin ?? 'codex'
    this.cwd = options.cwd
    this.codexHome = options.codexHome
    this.clientName = options.clientName ?? 'codex-telegram'
    this.clientVersion = options.clientVersion ?? '1.0.0'
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS
  }

  // ─── Public API ────────────────────────────────────────────────

  /** Whether the WebSocket is currently open and the handshake is complete. */
  get connected(): boolean {
    return this.ws !== null
      && this.ws.readyState === WebSocket.OPEN
      && this.initialized
  }

  /** The resolved WebSocket URL (available after start()). */
  get wsUrl(): string | undefined {
    return this.resolvedPort > 0 ? `ws://127.0.0.1:${this.resolvedPort}` : undefined
  }

  /**
   * Spawn the app-server process and establish the WebSocket connection.
   * Resolves once the `initialize` handshake has completed.
   */
  async start(): Promise<void> {
    if (this.shuttingDown) {
      throw new Error(`${LOG_TAG} Cannot start — bridge is shutting down`)
    }

    this.resolvedPort = this.port
    await this.spawnProcess()
    await this.connectWebSocket()
  }

  /**
   * Send a JSON-RPC request and wait for the matching response.
   *
   * @returns The `result` field of the response.
   * @throws If the server returns an error or the request times out.
   */
  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) {
      throw new Error(`${LOG_TAG} Not connected — cannot send request "${method}"`)
    }

    const id = this.nextId++
    const message: JsonRpcRequest = { jsonrpc: '2.0', method, id }
    if (params !== undefined) {
      message.params = params
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`${LOG_TAG} Request "${method}" (id=${id}) timed out after ${REQUEST_TIMEOUT_MS}ms`))
      }, REQUEST_TIMEOUT_MS)

      this.pendingRequests.set(id, { resolve, reject, timer })
      this.sendRaw(message)
    })
  }

  /**
   * Send a JSON-RPC notification (fire-and-forget, no response expected).
   */
  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn(LOG_TAG, `Cannot send notification "${method}" — not connected`)
      return
    }

    const message: JsonRpcNotification = { jsonrpc: '2.0', method }
    if (params !== undefined) {
      message.params = params
    }
    this.sendRaw(message)
  }

  /**
   * Register a handler for a specific JSON-RPC notification method.
   */
  onNotification(method: string, handler: NotificationHandler): void {
    let handlers = this.notificationHandlers.get(method)
    if (!handlers) {
      handlers = new Set()
      this.notificationHandlers.set(method, handlers)
    }
    handlers.add(handler)
  }

  /**
   * Remove a previously registered notification handler.
   */
  offNotification(method: string, handler: NotificationHandler): void {
    const handlers = this.notificationHandlers.get(method)
    if (handlers) {
      handlers.delete(handler)
      if (handlers.size === 0) {
        this.notificationHandlers.delete(method)
      }
    }
  }

  /**
   * Gracefully shut down: close the WebSocket and kill the app-server process.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true

    this.clearReconnectTimer()
    this.rejectAllPending(new Error(`${LOG_TAG} Bridge is shutting down`))

    // Close WebSocket
    if (this.ws) {
      try {
        this.ws.removeAllListeners()
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, 'shutdown')
        }
      } catch {
        // Ignore close errors during shutdown
      }
      this.ws = null
    }

    // Kill process
    await this.killProcess()

    this.initialized = false
    this.emit('disconnected')
  }

  // ─── Process Management ────────────────────────────────────────

  private async spawnProcess(): Promise<void> {
    const listenAddr = `ws://127.0.0.1:${this.resolvedPort}`
    const args = ['app-server', '--listen', listenAddr]

    const env: Record<string, string | undefined> = { ...process.env }
    if (this.codexHome) {
      env['CODEX_HOME'] = this.codexHome
    }

    return new Promise<void>((resolve, reject) => {
      let resolved = false
      let stderrBuf = ''

      try {
        this.process = spawn(this.codexBin, args, {
          cwd: this.cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (error) {
        reject(new Error(`${LOG_TAG} Failed to spawn "${this.codexBin}": ${error}`))
        return
      }

      const proc = this.process

      // Handle spawn errors (e.g. binary not found)
      proc.on('error', (err) => {
        if (!resolved) {
          resolved = true
          reject(new Error(`${LOG_TAG} Failed to spawn "${this.codexBin}": ${err.message}`))
        } else {
          this.emit('error', err)
        }
      })

      // The app-server prints its listen address to stderr, not stdout.
      // Parse stderr for the listen address when port is auto-assigned.
      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        stderrBuf += text

        if (!resolved) {
          const portMatch = text.match(/listening on:\s*ws:\/\/127\.0\.0\.1:(\d+)/)
            ?? text.match(/ws:\/\/127\.0\.0\.1:(\d+)/)
          if (portMatch) {
            this.resolvedPort = parseInt(portMatch[1], 10)
            resolved = true
            resolve()
            return
          }
        }

        if (resolved) {
          console.error(LOG_TAG, text.trimEnd())
        }
      })

      // Log stdout (app-server currently doesn't use it, but just in case)
      proc.stdout?.on('data', (chunk: Buffer) => {
        if (resolved) {
          console.log(LOG_TAG, '[stdout]', chunk.toString().trimEnd())
        }
      })

      proc.on('exit', (code, signal) => {
        if (!resolved) {
          resolved = true
          const detail = stderrBuf.trim() ? `\n${stderrBuf.trim()}` : ''
          reject(new Error(
            `${LOG_TAG} app-server exited before ready (code=${code}, signal=${signal})${detail}`,
          ))
        } else {
          this.handleProcessExit(code, signal)
        }
        this.process = null
      })

      // If the port was already specified (not 0), we still wait for the
      // "listening on" message from stderr, but with a shorter timeout.
      // The main 15s timeout below still applies as a safety net.
      if (this.port !== 0) {
        setTimeout(() => {
          if (!resolved) {
            // If stderr already matched the port, this won't fire.
            // Otherwise assume the server is up on the specified port.
            resolved = true
            resolve()
          }
        }, 3_000)
      }

      // Safety: don't hang forever waiting for the port
      setTimeout(() => {
        if (!resolved) {
          resolved = true
          reject(new Error(`${LOG_TAG} Timed out waiting for app-server to report listen address`))
        }
      }, 15_000)
    })
  }

  private handleProcessExit(code: number | null, signal: string | null): void {
    console.warn(LOG_TAG, `app-server exited (code=${code}, signal=${signal})`)
    this.process = null
    this.emit('process-exit', code, signal)

    // If we weren't shutting down, the disconnect handler on the WebSocket
    // will trigger reconnect. Nothing extra to do here.
  }

  private async killProcess(): Promise<void> {
    const proc = this.process
    if (!proc || proc.killed) {
      this.process = null
      return
    }

    return new Promise<void>((resolve) => {
      const forceKillTimer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* already dead */ }
        resolve()
      }, 5_000)

      proc.once('exit', () => {
        clearTimeout(forceKillTimer)
        resolve()
      })

      try {
        proc.kill('SIGTERM')
      } catch {
        clearTimeout(forceKillTimer)
        resolve()
      }

      this.process = null
    })
  }

  // ─── WebSocket Connection ──────────────────────────────────────

  private async connectWebSocket(): Promise<void> {
    const url = `ws://127.0.0.1:${this.resolvedPort}`

    return new Promise<void>((resolve, reject) => {
      let settled = false

      const ws = new WebSocket(url)
      this.ws = ws

      const settle = (err?: Error) => {
        if (settled) return
        settled = true
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      }

      ws.on('open', () => {
        this.reconnectAttempts = 0
        this.performHandshake()
          .then(() => {
            this.initialized = true
            this.emit('connected')
            settle()
          })
          .catch((err) => {
            settle(new Error(`${LOG_TAG} Handshake failed: ${err.message}`))
          })
      })

      ws.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(data)
      })

      ws.on('close', (code, reason) => {
        const wasInitialized = this.initialized
        this.initialized = false
        this.ws = null
        this.emit('disconnected')

        if (!settled) {
          settle(new Error(
            `${LOG_TAG} WebSocket closed before handshake (code=${code}, reason=${reason.toString()})`,
          ))
          return
        }

        if (!this.shuttingDown && wasInitialized) {
          this.rejectAllPending(new Error(`${LOG_TAG} Connection lost`))
          this.scheduleReconnect()
        }
      })

      ws.on('error', (err) => {
        this.emit('error', err)
        if (!settled) {
          settle(new Error(`${LOG_TAG} WebSocket error: ${err.message}`))
        }
      })

      // Don't hang forever on the initial connection
      setTimeout(() => {
        settle(new Error(`${LOG_TAG} Timed out connecting to app-server at ${url}`))
      }, 10_000)
    })
  }

  // ─── Handshake ─────────────────────────────────────────────────

  private async performHandshake(): Promise<void> {
    const result = await this.requestInternal('initialize', {
      clientInfo: {
        name: this.clientName,
        title: 'Codex Telegram Bot',
        version: this.clientVersion,
      },
    })

    // Send `initialized` notification to confirm
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method: 'initialized' }
    this.sendRaw(msg)

    return result as undefined
  }

  /**
   * Internal request used during handshake (before `initialized` flag is set).
   */
  private async requestInternal(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`${LOG_TAG} WebSocket not open for handshake`)
    }

    const id = this.nextId++
    const message: JsonRpcRequest = { jsonrpc: '2.0', method, id }
    if (params !== undefined) {
      message.params = params
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`${LOG_TAG} Handshake request "${method}" timed out`))
      }, REQUEST_TIMEOUT_MS)

      this.pendingRequests.set(id, { resolve, reject, timer })
      this.sendRaw(message)
    })
  }

  // ─── Message Routing ───────────────────────────────────────────

  private handleMessage(raw: WebSocket.RawData): void {
    let data: Record<string, unknown>
    try {
      data = JSON.parse(raw.toString()) as Record<string, unknown>
    } catch {
      console.error(LOG_TAG, 'Failed to parse incoming message:', raw.toString().slice(0, 200))
      return
    }

    // Response to a pending request (has `id`)
    if ('id' in data && typeof data['id'] === 'number') {
      const pending = this.pendingRequests.get(data['id'])
      if (pending) {
        this.pendingRequests.delete(data['id'])
        clearTimeout(pending.timer)

        if (data['error']) {
          const err = data['error'] as { code: number; message: string; data?: unknown }
          const rpcError = new Error(`${LOG_TAG} RPC error [${err.code}]: ${err.message}`)
          ;(rpcError as unknown as Record<string, unknown>)['rpcCode'] = err.code
          ;(rpcError as unknown as Record<string, unknown>)['rpcData'] = err.data
          pending.reject(rpcError)
        } else {
          pending.resolve(data['result'])
        }
        return
      }
      // Response for unknown id — may have timed out already
      return
    }

    // Notification (has `method` but no `id`)
    if ('method' in data && typeof data['method'] === 'string') {
      const method = data['method'] as string
      const params = (data['params'] ?? {}) as Record<string, unknown>

      // Dispatch to specific handlers
      const handlers = this.notificationHandlers.get(method)
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(params)
          } catch (err) {
            console.error(LOG_TAG, `Notification handler for "${method}" threw:`, err)
          }
        }
      }

      // Emit generic notification event
      this.emit('notification', method, params)
    }
  }

  // ─── Reconnection ─────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.shuttingDown) return

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(LOG_TAG, `Giving up after ${this.reconnectAttempts} reconnect attempts`)
      this.emit('error', new Error(`${LOG_TAG} Max reconnect attempts exceeded`))
      return
    }

    const delay = this.reconnectDelayMs * Math.pow(1.5, this.reconnectAttempts)
    this.reconnectAttempts++

    console.log(LOG_TAG, `Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.attemptReconnect()
    }, delay)
  }

  private attemptReconnect(): void {
    if (this.shuttingDown) return

    // If the process died, we need to restart everything
    if (!this.process || this.process.killed) {
      console.log(LOG_TAG, 'Process died — restarting app-server')
      this.start().catch((err) => {
        console.error(LOG_TAG, 'Failed to restart app-server:', err)
        this.scheduleReconnect()
      })
      return
    }

    // Process is still alive — just reconnect the WebSocket
    this.connectWebSocket().catch((err) => {
      console.error(LOG_TAG, 'Reconnect failed:', err.message)
      this.scheduleReconnect()
    })
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private sendRaw(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn(LOG_TAG, 'Attempted to send on closed WebSocket')
      return
    }
    this.ws.send(JSON.stringify(message))
  }

  private rejectAllPending(reason: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(reason)
      this.pendingRequests.delete(id)
    }
  }
}
