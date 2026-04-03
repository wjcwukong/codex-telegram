import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SourceRecord, ThreadRecord } from './models.js'
import { StateStore } from './state-store.js'

const DEFAULT_HISTORY_LIMIT = 10
const HISTORY_CURSOR_PREFIX = 'offset:'

export type HistoryEntryRole = 'user' | 'assistant'
export type HistoryEntryView = 'message' | 'agent' | 'tool'
export type HistoryToolPhase = 'call' | 'output'

export interface HistoryEntry {
  role: HistoryEntryRole
  text: string
  timestamp?: string
  view?: HistoryEntryView
  payloadType?: string
  rolloutPath?: string
  toolName?: string
  toolCallId?: string
  toolPhase?: HistoryToolPhase
}

export interface HistoryReadOptions {
  limit?: number
  cursor?: string
  turn?: number
  since?: string | Date
  until?: string | Date
  includeTools?: boolean
  includeAgentMessages?: boolean
}

export interface HistoryPage {
  entries: HistoryEntry[]
  limit: number
  cursor?: string
  nextCursor?: string
  prevCursor?: string
  hasMore: boolean
  total: number
}

export interface HistoryTurn {
  index: number
  userEntry?: HistoryEntry
  responseEntries: HistoryEntry[]
  entries: HistoryEntry[]
  startedAt?: string
  endedAt?: string
  assistantMessageCount: number
  agentMessageCount: number
  toolCallCount: number
  toolOutputCount: number
  hasToolCalls: boolean
  hasAgentMessages: boolean
}

export interface HistoryTurnPage {
  turns: HistoryTurn[]
  limit: number
  cursor?: string
  nextCursor?: string
  prevCursor?: string
  hasMore: boolean
  total: number
}

export interface HistoryTurnSummaryOptions {
  maxUserTextLength?: number
  maxResponseTextLength?: number
  includeTimestamp?: boolean
  includeCounts?: boolean
}

interface RolloutRecord {
  timestamp?: string
  type?: string
  payload?: Record<string, unknown>
}

interface ToolCallSnapshot {
  name?: string
  argumentsText?: string
}

export interface HistoryRawRecord {
  rolloutPath: string
  lineNumber: number
  rawLine: string
  record: RolloutRecord
  entry?: HistoryEntry
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const normalized = normalizeText(value)
    return normalized || undefined
  }

  return undefined
}

function normalizeStructuredText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return undefined
    }

    try {
      return normalizeText(JSON.stringify(JSON.parse(trimmed), null, 2))
    } catch {
      return normalizeText(trimmed)
    }
  }

  if (value === undefined) {
    return undefined
  }

  try {
    return normalizeText(JSON.stringify(value, null, 2))
  } catch {
    return undefined
  }
}

function extractMessageText(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return undefined
  }

  const content = (payload as { content?: unknown }).content
  if (!Array.isArray(content)) {
    return undefined
  }

  const parts = content.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return []
    }

    const typedItem = item as { type?: unknown; text?: unknown }
    if (
      (typedItem.type === 'output_text' ||
        typedItem.type === 'input_text' ||
        typedItem.type === 'text') &&
      typeof typedItem.text === 'string'
    ) {
      return [typedItem.text]
    }

    return []
  })

  const combined = normalizeText(parts.join('\n'))
  return combined || undefined
}

function createToolCallText(name?: string, argumentsText?: string): string | undefined {
  const label = name ? `tool:${name}` : 'tool'
  const text = normalizeText([label, argumentsText].filter(Boolean).join('\n'))
  return text || undefined
}

function createToolOutputText(name?: string, output?: string): string | undefined {
  const label = name ? `tool:${name}:output` : 'tool:output'
  const text = normalizeText([label, output].filter(Boolean).join('\n'))
  return text || undefined
}

function normalizeLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_HISTORY_LIMIT
  }

  return Math.floor(limit)
}

function normalizeTurn(turn?: number): number | undefined {
  if (typeof turn !== 'number' || !Number.isFinite(turn) || turn <= 0) {
    return undefined
  }

  return Math.floor(turn)
}

function parseCursor(cursor?: string): number {
  if (!cursor) {
    return 0
  }

  if (/^\d+$/.test(cursor)) {
    return Number.parseInt(cursor, 10)
  }

  if (!cursor.startsWith(HISTORY_CURSOR_PREFIX)) {
    return 0
  }

  const value = cursor.slice(HISTORY_CURSOR_PREFIX.length)
  if (!/^\d+$/.test(value)) {
    return 0
  }

  return Number.parseInt(value, 10)
}

function formatCursor(offset: number): string | undefined {
  if (!Number.isInteger(offset) || offset <= 0) {
    return undefined
  }

  return `${HISTORY_CURSOR_PREFIX}${offset}`
}

function parseDateBoundary(value?: string | Date): number | undefined {
  if (!value) {
    return undefined
  }

  const date = value instanceof Date ? value : new Date(value)
  const timestamp = date.getTime()
  return Number.isNaN(timestamp) ? undefined : timestamp
}

function matchesTimeWindow(
  entry: HistoryEntry,
  sinceMs?: number,
  untilMs?: number,
): boolean {
  if (sinceMs === undefined && untilMs === undefined) {
    return true
  }

  if (!entry.timestamp) {
    return false
  }

  const entryMs = Date.parse(entry.timestamp)
  if (Number.isNaN(entryMs)) {
    return false
  }

  if (sinceMs !== undefined && entryMs < sinceMs) {
    return false
  }

  if (untilMs !== undefined && entryMs > untilMs) {
    return false
  }

  return true
}

function truncateText(text: string, maxLength: number): string {
  if (!Number.isFinite(maxLength) || maxLength <= 0 || text.length <= maxLength) {
    return text
  }

  return `${text.slice(0, Math.max(0, Math.floor(maxLength) - 1)).trimEnd()}…`
}

export function getHistoryEntryKey(entry: HistoryEntry): string {
  return [
    entry.role,
    entry.view ?? 'message',
    entry.toolPhase ?? '',
    entry.timestamp ?? '',
    entry.rolloutPath ?? '',
    entry.text,
  ].join('|')
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function buildHistoryTurn(index: number, entries: HistoryEntry[]): HistoryTurn {
  const userEntry = entries.find((entry) => entry.role === 'user')
  const responseEntries = userEntry ? entries.slice(entries.indexOf(userEntry) + 1) : [...entries]
  const startedAt = entries[0]?.timestamp
  const endedAt = entries[entries.length - 1]?.timestamp
  const assistantMessageCount = responseEntries.filter(
    (entry) => entry.view === 'message' && entry.role === 'assistant',
  ).length
  const agentMessageCount = responseEntries.filter((entry) => entry.view === 'agent').length
  const toolCallCount = responseEntries.filter(
    (entry) => entry.view === 'tool' && entry.toolPhase === 'call',
  ).length
  const toolOutputCount = responseEntries.filter(
    (entry) => entry.view === 'tool' && entry.toolPhase === 'output',
  ).length

  return {
    index,
    userEntry,
    responseEntries,
    entries,
    startedAt,
    endedAt,
    assistantMessageCount,
    agentMessageCount,
    toolCallCount,
    toolOutputCount,
    hasToolCalls: toolCallCount > 0 || toolOutputCount > 0,
    hasAgentMessages: agentMessageCount > 0,
  }
}

export function groupHistoryEntriesByTurn(entries: HistoryEntry[]): HistoryTurn[] {
  const turns: HistoryTurn[] = []
  let currentEntries: HistoryEntry[] = []

  for (const entry of entries) {
    if (entry.role === 'user') {
      if (currentEntries.length > 0) {
        turns.push(buildHistoryTurn(turns.length + 1, currentEntries))
      }

      currentEntries = [entry]
      continue
    }

    if (currentEntries.length === 0) {
      currentEntries = [entry]
      continue
    }

    currentEntries.push(entry)
  }

  if (currentEntries.length > 0) {
    turns.push(buildHistoryTurn(turns.length + 1, currentEntries))
  }

  return turns
}

export function summarizeHistoryTurn(
  turn: HistoryTurn,
  options: HistoryTurnSummaryOptions = {},
): string {
  const maxUserTextLength =
    typeof options.maxUserTextLength === 'number' ? options.maxUserTextLength : 80
  const maxResponseTextLength =
    typeof options.maxResponseTextLength === 'number' ? options.maxResponseTextLength : 120
  const includeTimestamp = options.includeTimestamp ?? false
  const includeCounts = options.includeCounts ?? true
  const firstResponseEntry = turn.responseEntries.find((entry) => entry.text)
  const userPreview = turn.userEntry
    ? truncateText(turn.userEntry.text, maxUserTextLength)
    : '(response-only turn)'
  const responsePreview = firstResponseEntry
    ? truncateText(firstResponseEntry.text, maxResponseTextLength)
    : 'no response'

  const parts = [userPreview, responsePreview]

  if (includeTimestamp && turn.startedAt) {
    parts.unshift(turn.startedAt)
  }

  if (includeCounts) {
    const counts: string[] = []

    if (turn.assistantMessageCount > 0) {
      counts.push(pluralize(turn.assistantMessageCount, 'assistant message'))
    }

    if (turn.agentMessageCount > 0) {
      counts.push(pluralize(turn.agentMessageCount, 'agent message'))
    }

    if (turn.toolCallCount > 0) {
      counts.push(pluralize(turn.toolCallCount, 'tool call'))
    }

    if (turn.toolOutputCount > 0) {
      counts.push(pluralize(turn.toolOutputCount, 'tool output'))
    }

    if (counts.length > 0) {
      parts.push(`[${counts.join(', ')}]`)
    }
  }

  return parts.join(' | ')
}

export class HistoryReader {
  constructor(private readonly store: StateStore) {}

  async readThreadHistory(
    thread: ThreadRecord,
    limitOrOptions: number | HistoryReadOptions = DEFAULT_HISTORY_LIMIT,
  ): Promise<HistoryEntry[]> {
    if (typeof limitOrOptions === 'number') {
      const entries = await this.readFilteredEntries(thread, { limit: limitOrOptions })
      const limit = normalizeLimit(limitOrOptions)
      return entries.slice(-limit)
    }

    const page = await this.readThreadHistoryPage(thread, limitOrOptions)
    return page.entries
  }

  async readThreadHistoryPage(
    thread: ThreadRecord,
    options: HistoryReadOptions = {},
  ): Promise<HistoryPage> {
    const entries = await this.readFilteredEntries(thread, options)
    return this.createPage(entries, options)
  }

  async readThreadHistoryTurns(
    thread: ThreadRecord,
    limitOrOptions: number | HistoryReadOptions = DEFAULT_HISTORY_LIMIT,
  ): Promise<HistoryTurn[]> {
    if (typeof limitOrOptions === 'number') {
      const turns = await this.readFilteredTurns(thread, { limit: limitOrOptions })
      const limit = normalizeLimit(limitOrOptions)
      return turns.slice(-limit)
    }

    const page = await this.readThreadHistoryTurnPage(thread, limitOrOptions)
    return page.turns
  }

  async readLastThreadHistoryTurn(
    thread: ThreadRecord,
    options: HistoryReadOptions = {},
  ): Promise<HistoryTurn | undefined> {
    const turns = await this.readFilteredTurns(thread, options)
    return turns.at(-1)
  }

  async readThreadHistoryTurnPage(
    thread: ThreadRecord,
    options: HistoryReadOptions = {},
  ): Promise<HistoryTurnPage> {
    const turns = await this.readFilteredTurns(thread, options)
    return this.createTurnPage(turns, options)
  }

  async readThreadRawRecords(thread: ThreadRecord): Promise<HistoryRawRecord[]> {
    if (!thread.codexThreadId) {
      return []
    }

    const source = this.store.getSource(thread.sourceId)
    if (!source) {
      return []
    }

    const rolloutPaths = await this.findRolloutPaths(source, thread.codexThreadId)
    const records: HistoryRawRecord[] = []

    for (const rolloutPath of rolloutPaths) {
      records.push(...(await this.parseRawRollout(rolloutPath)))
    }

    return records
  }

  private async readFilteredEntries(
    thread: ThreadRecord,
    options: HistoryReadOptions,
  ): Promise<HistoryEntry[]> {
    if (!thread.codexThreadId) {
      return []
    }

    const source = this.store.getSource(thread.sourceId)
    if (!source) {
      return []
    }

    const rolloutPaths = await this.findRolloutPaths(source, thread.codexThreadId)
    if (rolloutPaths.length === 0) {
      return []
    }

    const entries = await this.loadEntries(rolloutPaths)
    return this.filterEntries(thread, entries, options)
  }

  private async readFilteredTurns(
    thread: ThreadRecord,
    options: HistoryReadOptions,
  ): Promise<HistoryTurn[]> {
    const entries = await this.readFilteredEntries(thread, options)
    return groupHistoryEntriesByTurn(entries)
  }

  private async findRolloutPaths(
    source: SourceRecord,
    codexThreadId: string,
  ): Promise<string[]> {
    const sessionsRoot = join(source.codexHome, 'sessions')
    const matches: string[] = []

    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }

      entries.sort((left, right) => left.name.localeCompare(right.name))

      for (const entry of entries) {
        if (entry.isFile()) {
          const { name } = entry
          if (
            name.includes(codexThreadId) &&
            name.startsWith('rollout-') &&
            name.endsWith('.jsonl')
          ) {
            matches.push(join(dir, name))
          }
        }
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue
        }

        await walk(join(dir, entry.name))
      }
    }

    await walk(sessionsRoot)
    matches.sort((left, right) => left.localeCompare(right))
    return matches
  }

  private async loadEntries(rolloutPaths: string[]): Promise<HistoryEntry[]> {
    const entries: HistoryEntry[] = []

    for (const rolloutPath of rolloutPaths) {
      const parsedEntries = await this.parseRollout(rolloutPath)
      entries.push(...parsedEntries)
    }

    return this.deduplicateEntries(entries)
  }

  private async parseRollout(rolloutPath: string): Promise<HistoryEntry[]> {
    const rawRecords = await this.parseRawRollout(rolloutPath)
    return rawRecords.flatMap((record) => (record.entry ? [record.entry] : []))
  }

  private async parseRawRollout(rolloutPath: string): Promise<HistoryRawRecord[]> {
    let raw: string
    try {
      raw = await readFile(rolloutPath, 'utf8')
    } catch {
      return []
    }

    const records: HistoryRawRecord[] = []
    const toolCalls = new Map<string, ToolCallSnapshot>()

    raw.split('\n').forEach((line, index) => {
      const trimmed = line.trim()
      if (!trimmed) {
        return
      }

      try {
        const parsed = JSON.parse(trimmed) as RolloutRecord
        const entry = this.parseRecord(parsed, rolloutPath, toolCalls)
        records.push({
          rolloutPath,
          lineNumber: index + 1,
          rawLine: line,
          record: parsed,
          entry: entry ?? undefined,
        })
      } catch {
        // Ignore malformed lines.
      }
    })

    return records
  }

  private parseRecord(
    record: RolloutRecord,
    rolloutPath: string,
    toolCalls: Map<string, ToolCallSnapshot>,
  ): HistoryEntry | undefined {
    const payloadType =
      typeof record.payload?.type === 'string' ? record.payload.type : undefined

    if (record.type === 'event_msg' && payloadType === 'user_message') {
      const message = normalizeOptionalText(record.payload?.message)
      if (!message) {
        return undefined
      }

      return {
        role: 'user',
        text: message,
        timestamp: record.timestamp,
        view: 'message',
        payloadType,
        rolloutPath,
      }
    }

    if (
      record.type === 'response_item' &&
      payloadType === 'message' &&
      record.payload?.role === 'assistant'
    ) {
      const text = extractMessageText(record.payload)
      if (!text) {
        return undefined
      }

      return {
        role: 'assistant',
        text,
        timestamp: record.timestamp,
        view: 'message',
        payloadType,
        rolloutPath,
      }
    }

    if (record.type === 'event_msg' && payloadType === 'agent_message') {
      const message = normalizeOptionalText(record.payload?.message)
      if (!message) {
        return undefined
      }

      return {
        role: 'assistant',
        text: message,
        timestamp: record.timestamp,
        view: 'agent',
        payloadType,
        rolloutPath,
      }
    }

    if (record.type === 'response_item' && payloadType === 'function_call') {
      const name =
        typeof record.payload?.name === 'string' ? record.payload.name : undefined
      const argumentsText = normalizeStructuredText(record.payload?.arguments)
      const callId =
        typeof record.payload?.call_id === 'string'
          ? record.payload.call_id
          : undefined

      if (callId) {
        toolCalls.set(callId, { name, argumentsText })
      }

      const text = createToolCallText(name, argumentsText)
      if (!text) {
        return undefined
      }

      return {
        role: 'assistant',
        text,
        timestamp: record.timestamp,
        view: 'tool',
        payloadType,
        rolloutPath,
        toolName: name,
        toolCallId: callId,
        toolPhase: 'call',
      }
    }

    if (record.type === 'response_item' && payloadType === 'function_call_output') {
      const callId =
        typeof record.payload?.call_id === 'string'
          ? record.payload.call_id
          : undefined
      const output = normalizeStructuredText(record.payload?.output)
      const snapshot = callId ? toolCalls.get(callId) : undefined
      const toolName =
        typeof record.payload?.name === 'string'
          ? record.payload.name
          : snapshot?.name
      const text = createToolOutputText(toolName, output)

      if (!text) {
        return undefined
      }

      return {
        role: 'assistant',
        text,
        timestamp: record.timestamp,
        view: 'tool',
        payloadType,
        rolloutPath,
        toolName,
        toolCallId: callId,
        toolPhase: 'output',
      }
    }

    return undefined
  }

  private deduplicateEntries(entries: HistoryEntry[]): HistoryEntry[] {
    const unique: HistoryEntry[] = []

    for (const entry of entries) {
      const previous = unique[unique.length - 1]

      if (
        previous &&
        previous.role === entry.role &&
        previous.view === entry.view &&
        previous.toolPhase === entry.toolPhase &&
        previous.text === entry.text
      ) {
        continue
      }

      if (
        previous &&
        previous.role === 'assistant' &&
        entry.role === 'assistant' &&
        previous.text === entry.text &&
        ((previous.view === 'agent' && entry.view === 'message') ||
          (previous.view === 'message' && entry.view === 'agent'))
      ) {
        if (previous.view === 'agent' && entry.view === 'message') {
          unique[unique.length - 1] = entry
        }
        continue
      }

      unique.push(entry)
    }

    return unique
  }

  private filterEntries(
    thread: ThreadRecord,
    entries: HistoryEntry[],
    options: HistoryReadOptions,
  ): HistoryEntry[] {
    const sinceMs = parseDateBoundary(options.since)
    const untilMs = parseDateBoundary(options.until)
    const includeTools = options.includeTools ?? false
    const includeAgentMessages = options.includeAgentMessages ?? false
    const hiddenEntries = new Set(thread.hiddenHistoryEntryKeys ?? [])

    return entries.filter((entry) => {
      if (hiddenEntries.has(getHistoryEntryKey(entry))) {
        return false
      }

      if (entry.view === 'tool' && !includeTools) {
        return false
      }

      if (entry.view === 'agent' && !includeAgentMessages) {
        return false
      }

      return matchesTimeWindow(entry, sinceMs, untilMs)
    })
  }

  private createPage(
    entries: HistoryEntry[],
    options: HistoryReadOptions,
  ): HistoryPage {
    const limit = normalizeLimit(options.limit)
    const start = Math.max(0, Math.min(parseCursor(options.cursor), entries.length))
    const end = Math.min(start + limit, entries.length)

    return {
      entries: entries.slice(start, end),
      limit,
      cursor: formatCursor(start),
      nextCursor: end < entries.length ? formatCursor(end) : undefined,
      prevCursor: start > 0 ? formatCursor(Math.max(0, start - limit)) : undefined,
      hasMore: end < entries.length,
      total: entries.length,
    }
  }

  private createTurnPage(
    turns: HistoryTurn[],
    options: HistoryReadOptions,
  ): HistoryTurnPage {
    const limit = normalizeLimit(options.limit)
    const turn = normalizeTurn(options.turn)
    const start = Math.max(
      0,
      Math.min(
        turn ? turn - 1 : parseCursor(options.cursor),
        turns.length,
      ),
    )
    const end = Math.min(start + limit, turns.length)

    return {
      turns: turns.slice(start, end),
      limit,
      cursor: formatCursor(start),
      nextCursor: end < turns.length ? formatCursor(end) : undefined,
      prevCursor: start > 0 ? formatCursor(Math.max(0, start - limit)) : undefined,
      hasMore: end < turns.length,
      total: turns.length,
    }
  }
}
