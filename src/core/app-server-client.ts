/**
 * High-level client for the Codex app-server protocol.
 *
 * Wraps the raw JSON-RPC {@link CodexBridge} into a typed, event-driven API
 * covering threads, turns, and streaming item/delta notifications.
 *
 * @module app-server-client
 */

import { EventEmitter } from 'events'

import type { CodexBridge } from './codex-bridge.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal representation of a Codex thread. */
export interface CodexThread {
  id: string
  name?: string | null
  preview?: string
  status?: { type: string } | string
  path?: string
  cwd?: string
  source?: string
}

/** Minimal representation of a Codex turn. */
export interface CodexTurn {
  id: string
  /** `'inProgress'` | `'completed'` | `'interrupted'` | `'errored'` */
  status: string
  items?: CodexItem[]
  error?: unknown
}

/** Minimal representation of an item within a turn. */
export interface CodexItem {
  id: string
  /** e.g. `'userMessage'`, `'agentMessage'`, `'shellCommand'`, `'fileEdit'` */
  type: string
  content?: unknown
}

/** Payload emitted for `turn:completed` events. */
export interface TurnCompletedEvent {
  threadId: string
  turn: CodexTurn
}

/** Payload emitted for `agent:delta` (streaming text) events. */
export interface AgentDeltaEvent {
  threadId: string
  turnId: string
  itemId: string
  /** Incremental text fragment. */
  delta: string
}

/** Payload emitted for `item:started` / `item:completed` events. */
export interface ItemEvent {
  threadId: string
  turnId: string
  item: CodexItem
}

/** Payload emitted for `thread:status` events. */
export interface ThreadStatusEvent {
  threadId: string
  status: string
}

export type TurnCompletedHandler = (event: TurnCompletedEvent) => void
export type AgentDeltaHandler = (event: AgentDeltaEvent) => void
export type ItemHandler = (event: ItemEvent) => void

// ---------------------------------------------------------------------------
// Notification method constants
// ---------------------------------------------------------------------------

const N_THREAD_STARTED = 'thread/started'
const N_THREAD_STATUS_CHANGED = 'thread/status/changed'
const N_ITEM_STARTED = 'item/started'
const N_ITEM_COMPLETED = 'item/completed'
const N_ITEM_AGENT_DELTA = 'item/agentMessage/delta'
const N_TURN_STARTED = 'turn/started'
const N_TURN_COMPLETED = 'turn/completed'

// ---------------------------------------------------------------------------
// AppServerClient
// ---------------------------------------------------------------------------

/**
 * High-level, typed client for the Codex app-server protocol.
 *
 * Extends {@link EventEmitter} and emits the following events:
 *
 * | Event              | Payload                |
 * |--------------------|------------------------|
 * | `turn:completed`   | {@link TurnCompletedEvent} |
 * | `agent:delta`      | {@link AgentDeltaEvent}    |
 * | `item:started`     | {@link ItemEvent}          |
 * | `item:completed`   | {@link ItemEvent}          |
 * | `thread:status`    | {@link ThreadStatusEvent}  |
 * | `thread:started`   | `{ thread: CodexThread }`  |
 * | `turn:started`     | `{ threadId, turn }`       |
 * | `connected`        | (none)                     |
 * | `disconnected`     | (none)                     |
 * | `error`            | `Error`                    |
 */
export class AppServerClient extends EventEmitter {
  private disposed = false

  /**
   * Counter tracking in-flight threadStart() calls.
   * When > 0, the thread:started notification should NOT trigger auto-import
   * because the creating code will handle import itself.
   */
  threadCreationInFlight = 0

  /**
   * Bound handler references so we can unregister them on {@link dispose}.
   * Each entry maps a notification method to its handler function.
   */
  private readonly handlers = new Map<
    string,
    (params: Record<string, unknown>) => void
  >()

  constructor(private readonly bridge: CodexBridge) {
    super()
  }

  /** Whether the underlying bridge is connected and the handshake is complete. */
  get connected(): boolean {
    return this.bridge.connected
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Register notification handlers on the underlying bridge.
   *
   * Call this once after construction to start receiving server-pushed events.
   */
  init(): void {
    this.registerHandler(N_TURN_COMPLETED, (params) => {
      this.emit('turn:completed', {
        threadId: params.threadId as string,
        turn: params.turn as CodexTurn,
      } satisfies TurnCompletedEvent)
    })

    this.registerHandler(N_ITEM_AGENT_DELTA, (params) => {
      this.emit('agent:delta', {
        threadId: params.threadId as string,
        turnId: params.turnId as string,
        itemId: params.itemId as string,
        delta: params.delta as string,
      } satisfies AgentDeltaEvent)
    })

    this.registerHandler(N_ITEM_STARTED, (params) => {
      this.emit('item:started', {
        threadId: params.threadId as string,
        turnId: params.turnId as string,
        item: params.item as CodexItem,
      } satisfies ItemEvent)
    })

    this.registerHandler(N_ITEM_COMPLETED, (params) => {
      this.emit('item:completed', {
        threadId: params.threadId as string,
        turnId: params.turnId as string,
        item: params.item as CodexItem,
      } satisfies ItemEvent)
    })

    this.registerHandler(N_THREAD_STATUS_CHANGED, (params) => {
      this.emit('thread:status', {
        threadId: params.threadId as string,
        status: params.status as string,
      } satisfies ThreadStatusEvent)
    })

    this.registerHandler(N_THREAD_STARTED, (params) => {
      this.emit('thread:started', {
        thread: params.thread as CodexThread,
      })
    })

    this.registerHandler(N_TURN_STARTED, (params) => {
      this.emit('turn:started', {
        threadId: params.threadId as string,
        turn: params.turn as CodexTurn,
      })
    })
  }

  /**
   * Unregister all notification handlers and remove event listeners.
   *
   * After calling this the client is inert; create a new instance if you need
   * to reconnect.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    for (const [method, handler] of this.handlers) {
      this.bridge.offNotification(method, handler)
    }
    this.handlers.clear()
    this.removeAllListeners()
  }

  // -----------------------------------------------------------------------
  // Thread APIs
  // -----------------------------------------------------------------------

  /** Create a new thread. */
  async threadStart(
    options?: {
      cwd?: string
      model?: string
      approvalPolicy?: 'never'
      sandbox?: 'danger-full-access'
    },
  ): Promise<CodexThread> {
    this.threadCreationInFlight++
    try {
      const result = await this.rpc<{ thread: CodexThread }>('thread/start', {
        ...options,
        // Full authorization: never prompt for approval, full filesystem/network access
        approvalPolicy: options?.approvalPolicy ?? 'never',
        sandbox: options?.sandbox ?? 'danger-full-access',
      })
      return result.thread
    } finally {
      this.threadCreationInFlight--
    }
  }

  /** Resume an existing thread. */
  async threadResume(threadId: string): Promise<CodexThread> {
    const result = await this.rpc<{ thread: CodexThread }>('thread/resume', { threadId })
    return result.thread
  }

  /** List threads with optional pagination and filtering. */
  async threadList(
    options?: {
      cursor?: string
      limit?: number
      archived?: boolean
      searchTerm?: string
    },
  ): Promise<{ threads: CodexThread[]; nextCursor?: string }> {
    const result = await this.rpc<{ data: CodexThread[]; nextCursor?: string | null }>(
      'thread/list',
      options ?? {},
    )
    return { threads: result.data ?? [], nextCursor: result.nextCursor ?? undefined }
  }

  /** Read a single thread by id. */
  async threadRead(
    threadId: string,
    includeTurns?: boolean,
  ): Promise<CodexThread> {
    return this.rpc<CodexThread>('thread/read', { threadId, includeTurns })
  }

  /** Archive a thread. */
  async threadArchive(threadId: string): Promise<void> {
    await this.rpc('thread/archive', { threadId })
  }

  /** Set a thread's display name. */
  async threadSetName(threadId: string, name: string): Promise<void> {
    await this.rpc('thread/name/set', { threadId, name })
  }

  /** Roll back the last *count* turns from a thread. */
  async threadRollback(threadId: string, count: number): Promise<CodexThread> {
    return this.rpc<CodexThread>('thread/rollback', { threadId, count })
  }

  /** Unsubscribe from server-pushed events for a thread. */
  async threadUnsubscribe(threadId: string): Promise<void> {
    await this.rpc('thread/unsubscribe', { threadId })
  }

  // -----------------------------------------------------------------------
  // Turn APIs
  // -----------------------------------------------------------------------

  /**
   * Start a new turn (send user input to the model).
   *
   * The returned {@link CodexTurn} will initially have `status: 'running'`.
   * Subscribe to `turn:completed` to know when the model finishes.
   */
  async turnStart(threadId: string, text: string): Promise<CodexTurn> {
    const result = await this.rpc<{ turn: CodexTurn }>('turn/start', {
      threadId,
      input: [{ type: 'text', text }],
      // Reinforce full authorization per-turn in case thread defaults get overridden
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    })
    return result.turn
  }

  /**
   * Steer an in-flight turn by appending additional user input.
   *
   * @returns The turn id that was steered.
   */
  async turnSteer(
    threadId: string,
    turnId: string,
    text: string,
  ): Promise<string> {
    const result = await this.rpc<{ turnId: string }>('turn/steer', {
      threadId,
      turnId,
      input: [{ type: 'text', text }],
    })
    return result.turnId
  }

  /** Interrupt / cancel a running turn. */
  async turnInterrupt(threadId: string, turnId: string): Promise<void> {
    await this.rpc('turn/interrupt', { threadId, turnId })
  }

  // -----------------------------------------------------------------------
  // Typed event helpers
  // -----------------------------------------------------------------------

  /** Subscribe to `turn:completed` events. */
  onTurnCompleted(handler: TurnCompletedHandler): void {
    this.on('turn:completed', handler)
  }

  /** Unsubscribe from `turn:completed` events. */
  offTurnCompleted(handler: TurnCompletedHandler): void {
    this.off('turn:completed', handler)
  }

  /** Subscribe to `agent:delta` (streaming text fragment) events. */
  onAgentDelta(handler: AgentDeltaHandler): void {
    this.on('agent:delta', handler)
  }

  /** Unsubscribe from `agent:delta` events. */
  offAgentDelta(handler: AgentDeltaHandler): void {
    this.off('agent:delta', handler)
  }

  /** Subscribe to `item:started` events. */
  onItemStarted(handler: ItemHandler): void {
    this.on('item:started', handler)
  }

  /** Subscribe to `item:completed` events. */
  onItemCompleted(handler: ItemHandler): void {
    this.on('item:completed', handler)
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Send a JSON-RPC request through the bridge with standard error handling.
   *
   * @throws If the bridge is disconnected or the request fails.
   */
  private async rpc<T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (!this.bridge.connected) {
      throw new Error(
        `Not connected to app-server (attempted ${method})`,
      )
    }

    try {
      return (await this.bridge.request(method, params)) as T
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err)
      throw new Error(`app-server ${method} failed: ${message}`)
    }
  }

  /**
   * Register a single notification handler on the bridge and track it for
   * later cleanup in {@link dispose}.
   */
  private registerHandler(
    method: string,
    handler: (params: Record<string, unknown>) => void,
  ): void {
    this.handlers.set(method, handler)
    this.bridge.onNotification(method, handler)
  }
}
