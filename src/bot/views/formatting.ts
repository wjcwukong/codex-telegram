import { relative } from 'node:path'
import { homedir } from 'node:os'

import { formatForTelegram } from './tg-format.js'
import { PROJECT } from '../i18n/zh.js'
import { chunkText } from '../../../session-manager.js'
import type { SessionManager } from '../../../session-manager.js'
import type { ImportStatusState, SyncProjectsDetails } from '../../../session-manager.js'
import type { RunRecord } from '../../../run-scheduler.js'
import type { ImportPendingSource, ImportSyncOptions } from '../../../importer.js'
import type { ImportSummary } from '../../../models.js'
import type { OrderedListLocation } from '../../../state-store.js'

export const TELEGRAM_MESSAGE_LIMIT = 4000

export type MessageSender = (
  chatId: string,
  text: string,
  options?: {
    entities?: Array<{ type: string; offset: number; length: number }>
    parse_mode?: string
  },
) => Promise<unknown>

export async function sendFormattedOutput(
  sendMessage: MessageSender,
  chatId: string,
  output: string,
): Promise<void> {
  for (const chunk of chunkText(output, TELEGRAM_MESSAGE_LIMIT)) {
    if (!chunk) {
      continue
    }

    // Try HTML formatting first
    const { text: formatted, parse_mode } = formatForTelegram(chunk, TELEGRAM_MESSAGE_LIMIT)
    try {
      await sendMessage(chatId, formatted, {
        ...(parse_mode ? { parse_mode } : {}),
      })
    } catch {
      // Fallback: plain text (with pre entity for multi-line content)
      if (chunk.includes('\n')) {
        await sendMessage(chatId, chunk, {
          entities: [{ type: 'pre', offset: 0, length: chunk.length }],
        })
      } else {
        await sendMessage(chatId, chunk)
      }
    }
  }
}

export async function replyInChunks(
  ctx: { reply: (text: string) => Promise<unknown> },
  text: string,
): Promise<void> {
  for (const chunk of chunkText(text, TELEGRAM_MESSAGE_LIMIT)) {
    if (!chunk) {
      continue
    }

    await ctx.reply(chunk)
  }
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function highlightSearchText(text: string, query: string): string {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) {
    return text
  }

  try {
    const pattern = new RegExp(escapeRegExp(normalizedQuery), 'ig')
    return text.replace(pattern, (match) => `〔${match}〕`)
  } catch {
    return text
  }
}

export function formatTimestamp(timestamp?: string): string {
  if (!timestamp) {
    return '-'
  }

  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return timestamp
  }

  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')

  return `${yyyy}-${mm}-${dd} ${hh}:${min}`
}

export function formatDurationMs(durationMs?: number): string {
  if (!Number.isFinite(durationMs) || durationMs === undefined || durationMs < 0) {
    return '-'
  }

  if (durationMs < 1000) {
    return `${Math.floor(durationMs)}ms`
  }

  const totalSeconds = Math.floor(durationMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  if (minutes <= 0) {
    return `${seconds}s`
  }

  return `${minutes}m ${seconds}s`
}

export function formatThreadCwdSummary(projectCwd: string, threadCwd: string): string {
  if (threadCwd === projectCwd) {
    return '.'
  }

  const relativePath = relative(projectCwd, threadCwd)
  if (
    relativePath &&
    relativePath !== '.' &&
    !relativePath.startsWith('..') &&
    !relativePath.includes('..')
  ) {
    return relativePath
  }

  const home = homedir()
  if (threadCwd === home) {
    return '~'
  }

  if (threadCwd.startsWith(`${home}/`)) {
    return `~/${threadCwd.slice(home.length + 1)}`
  }

  return threadCwd
}

export function countItemsByKey<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const key = getKey(item)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

export function formatStatusCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((left, right) =>
    left[0].localeCompare(right[0]),
  )
  return entries.length > 0
    ? entries.map(([key, value]) => `${key}=${value}`).join(', ')
    : '-'
}

// ─── Originator badge ────────────────────────────────────────────────────────

/** Map an originator string to a compact emoji badge. */
export function originatorBadge(originator: string | undefined): string {
  switch (originator) {
    case 'Codex Desktop':
    case 'codex_vscode':
      return '📱'
    case 'codex_cli':
    case 'codex_cli_rs':
      return '💻'
    case 'telegram':
      return '🤖'
    case 'imported':
      return '📥'
    default:
      return '📋'
  }
}

/** Human-readable originator label with badge. */
export function originatorLabel(originator: string | undefined): string {
  const badge = originatorBadge(originator)
  switch (originator) {
    case 'Codex Desktop':
    case 'codex_vscode':
      return `${badge} Codex Desktop`
    case 'codex_cli':
    case 'codex_cli_rs':
      return `${badge} CLI`
    case 'telegram':
      return `${badge} Telegram`
    case 'imported':
      return `${badge} Imported`
    default:
      return `${badge} ${originator ?? 'Unknown'}`
  }
}

// ─── Import / sync rendering ────────────────────────────────────────────────

export function formatImportSyncOptions(
  options?: ImportSyncOptions,
): string {
  if (!options) {
    return '-'
  }

  const parts = [
    options.onlyIfChanged ? 'onlyIfChanged' : 'full-scan',
    typeof options.lookbackDays === 'number' ? `lookback=${options.lookbackDays}d` : undefined,
    typeof options.maxTrackedFiles === 'number'
      ? `tracked=${options.maxTrackedFiles}`
      : undefined,
    options.sourceIds?.length ? `sources=${options.sourceIds.join(',')}` : undefined,
  ]

  return parts.filter(Boolean).join(', ') || '-'
}

export function formatImportDelta(
  delta: Pick<
    ImportSummary,
    'addedProjects' | 'updatedProjects' | 'addedThreads' | 'updatedThreads'
  >,
): string {
  return [
    `+projects ${delta.addedProjects}`,
    `~projects ${delta.updatedProjects}`,
    `+threads ${delta.addedThreads}`,
    `~threads ${delta.updatedThreads}`,
  ].join(', ')
}

export function renderImportPendingSummary(
  pending?: ImportPendingSource,
): string {
  if (!pending) {
    return 'no pending scan window'
  }

  return pending.hasChanges
    ? `${pending.changedRolloutCount}/${pending.candidateRolloutCount} rollouts changed${pending.sessionIndexChanged ? ', session index changed' : ''}`
    : `no changes in ${pending.candidateRolloutCount} candidate rollouts`
}

export function renderProjectSyncStatus(
  status: ImportStatusState,
): string {
  const changedSources = status.pending.filter((entry) => entry.hasChanges).length
  const pendingRollouts = status.pending.reduce(
    (sum, entry) => sum + entry.changedRolloutCount,
    0,
  )

  const sections = [
    [
      'project sync status',
      `state: ${status.sync.state} (active ${status.sync.activeSyncCount})`,
      `sources: ${status.sources.length}`,
      `changed sources: ${changedSources}`,
      `pending rollouts: ${pendingRollouts}`,
      `last completed: ${formatTimestamp(status.sync.lastCompletedAt)}`,
      `last successful: ${formatTimestamp(status.sync.lastSuccessfulAt)}`,
      status.sync.currentSyncStartedAt
        ? `current sync: started ${formatTimestamp(status.sync.currentSyncStartedAt)}`
        : undefined,
      status.sync.currentSyncOptions
        ? `current options: ${formatImportSyncOptions(status.sync.currentSyncOptions)}`
        : undefined,
      status.sync.lastError ? `last error: ${status.sync.lastError}` : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
  ]

  if (status.sync.lastRun) {
    sections.push(
      [
        'last run',
        `window: ${formatTimestamp(status.sync.lastRun.startedAt)} -> ${formatTimestamp(status.sync.lastRun.completedAt)}`,
        `duration: ${formatDurationMs(status.sync.lastRun.durationMs)}`,
        `mode: ${formatImportSyncOptions(status.sync.lastRun.options)}`,
        `summary: sources ${status.sync.lastRun.summary.scannedSources}, rollouts ${status.sync.lastRun.summary.scannedRollouts}`,
        `delta: ${formatImportDelta(status.sync.lastRun.summary)}`,
        status.sync.lastRun.error ? `error: ${status.sync.lastRun.error}` : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
    )

    if (status.sync.lastRun.sources.length > 0) {
      sections.push(
        [
          'timeline',
          ...status.sync.lastRun.sources.map((source, index) =>
            `${index + 1}. ${source.sourceId} [${source.storagePolicy}] ${source.skipped ? 'no-changes' : 'processed'} | ${source.processedRolloutCount}/${source.candidateRolloutCount} rollouts | ${formatImportDelta(source)} | ${formatTimestamp(source.completedAt)}`,
          ),
        ].join('\n'),
      )
    }
  }

  sections.push(
    [
      'sources',
      ...status.sources.map((entry, index) =>
        renderImportSourceStatusBlock(index + 1, entry),
      ),
    ].join('\n\n'),
  )

  return sections.join('\n\n')
}

export function renderProjectSyncRun(
  details: SyncProjectsDetails,
  summary: {
    projectsBefore: number
    projectsAfter: number
    currentProjectName?: string
    currentProjectLocation?: OrderedListLocation
  },
): string {
  const sections = [
    [
      PROJECT.SYNC_DONE,
      `window: ${formatTimestamp(details.run.startedAt)} -> ${formatTimestamp(details.run.completedAt)}`,
      `duration: ${formatDurationMs(details.run.durationMs)}`,
      `mode: ${formatImportSyncOptions(details.run.options)}`,
      `sources: ${details.run.summary.scannedSources}`,
      `rollouts: ${details.run.summary.scannedRollouts}`,
      `delta: ${formatImportDelta(details.run.summary)}`,
      `projects total: ${summary.projectsAfter} (was ${summary.projectsBefore})`,
      summary.currentProjectName && summary.currentProjectLocation
        ? `current project: ${summary.currentProjectName} (#${summary.currentProjectLocation.ordinal}, page ${summary.currentProjectLocation.page})`
        : undefined,
      details.run.error ? `error: ${details.run.error}` : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
  ]

  if (details.run.sources.length > 0) {
    sections.push(
      [
        'timeline',
        ...details.run.sources.map((source, index) =>
          `${index + 1}. ${source.sourceId} [${source.storagePolicy}] ${source.skipped ? 'no-changes' : 'processed'} | ${source.processedRolloutCount}/${source.candidateRolloutCount} rollouts | ${formatImportDelta(source)} | ${formatDurationMs(source.durationMs)}`,
        ),
      ].join('\n'),
    )

    sections.push(
      [
        'sources',
        ...details.sources.map((source, index) =>
          renderImportSourceRunBlock(index + 1, source),
        ),
      ].join('\n\n'),
    )
  }

  return sections.join('\n\n')
}

export function renderImportSourceStatusBlock(
  index: number,
  entry: ImportStatusState['sources'][number],
): string {
  const lastRun = entry.importStatus.lastRun
  return [
    `${index}. ${entry.source.id} (${entry.source.storagePolicy})${entry.source.enabled ? '' : ' [disabled]'}`,
    entry.source.codexHome,
    `projects: ${entry.projectCount}, threads: ${entry.threadCount}, agents: ${entry.agentCount}`,
    `pending: ${renderImportPendingSummary(entry.importStatus.pending)}`,
    `last scan: ${formatTimestamp(entry.importStatus.cursor.lastScanCompletedAt ?? entry.importStatus.cursor.lastScanAt)}`,
    `tracked: rollouts ${entry.importStatus.trackedRolloutCount}, fingerprints ${entry.importStatus.trackedFingerprintCount}`,
    lastRun
      ? `last run: ${lastRun.skipped ? 'no-changes' : 'processed'} | ${lastRun.processedRolloutCount}/${lastRun.candidateRolloutCount} rollouts | ${formatImportDelta(lastRun)} | ${formatTimestamp(lastRun.completedAt)}`
      : 'last run: -',
  ].join('\n')
}

export function renderImportSourceRunBlock(
  index: number,
  entry: SyncProjectsDetails['sources'][number],
): string {
  const run = entry.run
  return [
    `${index}. ${entry.source.id} (${entry.source.storagePolicy})${entry.source.enabled ? '' : ' [disabled]'}`,
    entry.source.codexHome,
    `projects: ${entry.projectCount}, threads: ${entry.threadCount}, agents: ${entry.agentCount}`,
    run
      ? `window: ${formatTimestamp(run.startedAt)} -> ${formatTimestamp(run.completedAt)}`
      : 'window: -',
    run
      ? `result: ${run.skipped ? 'no-changes' : 'processed'} | ${run.processedRolloutCount}/${run.candidateRolloutCount} rollouts${run.sessionIndexChanged ? ' | session index changed' : ''}`
      : 'result: -',
    run ? `delta: ${formatImportDelta(run)}` : undefined,
    run ? `cursor: ${formatTimestamp(run.cursorBefore.lastScanCompletedAt ?? run.cursorBefore.lastScanAt)} -> ${formatTimestamp(run.cursorAfter.lastScanCompletedAt ?? run.cursorAfter.lastScanAt)}` : undefined,
  ]
    .filter(Boolean)
    .join('\n')
}

// ─── Issue / action summary builders ────────────────────────────────────────

export type AgentIssueKind = 'waiting_approval' | 'failed' | 'cancelled'
export type RunIssueKind = 'waiting_approval' | 'failed' | 'cancelled'
export type GetRunDisplayStatus = (run: RunRecord) => string

export function normalizeIssueText(text?: string): string | undefined {
  if (!text) {
    return undefined
  }

  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 0 ? normalized : undefined
}

export function summarizeIssueText(text: string, maxLength = 120): string {
  if (text.length <= maxLength) {
    return text
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

export function stripIssuePrefix(text: string, prefix: string): string {
  return text.toLowerCase().startsWith(prefix.toLowerCase())
    ? text.slice(prefix.length).trimStart().replace(/^:\s*/, '')
    : text
}

export function detectAgentIssueKind(
  status: string,
  lastError?: string,
): AgentIssueKind | undefined {
  const normalizedError = normalizeIssueText(lastError)
  if (status === 'failed' && normalizedError?.toLowerCase().startsWith('waiting_approval')) {
    return 'waiting_approval'
  }

  if (status === 'failed' || status === 'cancelled') {
    return status
  }

  return undefined
}

export function detectRunIssueKind(
  run: RunRecord,
  getRunDisplayStatus: GetRunDisplayStatus,
): RunIssueKind | undefined {
  const displayStatus = getRunDisplayStatus(run)
  if (
    displayStatus === 'waiting_approval' ||
    displayStatus === 'failed' ||
    displayStatus === 'cancelled'
  ) {
    return displayStatus
  }

  return undefined
}

export function buildAgentIssueSummary(
  status: string,
  lastError?: string,
): { kind?: AgentIssueKind; detail?: string } {
  const kind = detectAgentIssueKind(status, lastError)
  const normalizedError = normalizeIssueText(lastError)

  if (kind === 'waiting_approval') {
    return {
      kind,
      detail: summarizeIssueText(
        stripIssuePrefix(
          normalizedError ?? 'Approval required before this agent can continue.',
          'waiting_approval',
        ),
      ),
    }
  }

  if (kind === 'failed') {
    return {
      kind,
      detail: summarizeIssueText(
        normalizedError ?? 'Agent failed without a stored error.',
      ),
    }
  }

  if (kind === 'cancelled') {
    return {
      kind,
      detail: summarizeIssueText(
        normalizedError ?? 'This agent stopped before completing the subtask.',
      ),
    }
  }

  return {}
}

export function buildRunIssueSummary(
  run: RunRecord,
  getRunDisplayStatus: GetRunDisplayStatus,
): { kind?: RunIssueKind; detail?: string } {
  const kind = detectRunIssueKind(run, getRunDisplayStatus)
  const detail = normalizeIssueText(run.error ?? run.cancelReason)

  if (kind === 'waiting_approval') {
    return {
      kind,
      detail: summarizeIssueText(detail ?? 'Approval required before this run can continue.'),
    }
  }

  if (kind === 'failed') {
    return {
      kind,
      detail: summarizeIssueText(detail ?? 'Run failed without a stored error.'),
    }
  }

  if (kind === 'cancelled') {
    return {
      kind,
      detail: summarizeIssueText(detail ?? 'Run was cancelled.'),
    }
  }

  return {}
}

export function formatRunIssueLinkage(
  run: RunRecord,
): string {
  return [
    `/run show ${run.context.runId}`,
    `/thread use ${run.context.threadId}`,
    run.context.agentId ? `/agent show ${run.context.agentId}` : undefined,
    `/project use ${run.context.projectId}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join(' | ')
}

export function formatAgentIssueLinkage(
  agent: {
    id: string
    parentThreadId: string
    threadId?: string
    projectId?: string
    writebackRunId?: string
  },
): string {
  return [
    `/agent show ${agent.id}`,
    `parent /thread use ${agent.parentThreadId}`,
    agent.threadId && agent.threadId !== agent.parentThreadId
      ? `child /thread use ${agent.threadId}`
      : undefined,
    agent.projectId ? `/project use ${agent.projectId}` : undefined,
    agent.writebackRunId ? `/run show ${agent.writebackRunId}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join(' | ')
}

export function buildAgentIssueLines(
  details: NonNullable<Awaited<ReturnType<SessionManager['getAgentDetails']>>>,
  getRunDisplayStatus: GetRunDisplayStatus,
): string[] {
  const lines: string[] = []
  const issue = buildAgentIssueSummary(
    details.agent.status.effective,
    details.agent.status.lastError,
  )

  if (issue.kind === 'waiting_approval') {
    lines.push(`waiting_approval: ${issue.detail}`)
  }

  if (issue.kind === 'failed') {
    lines.push(`failed: ${issue.detail}`)
  }

  if (issue.kind === 'cancelled') {
    lines.push(`cancelled: ${issue.detail}`)
  }

  if (issue.kind) {
    lines.push(
      `links: ${formatAgentIssueLinkage({
        id: details.agent.agent.id,
        parentThreadId: details.agent.relation.parentThreadId,
        threadId: details.agent.relation.childThreadId,
        projectId: details.agent.agent.projectId,
        writebackRunId: details.agent.agent.writebackRunId,
      })}`,
    )
  }

  if (!details.agent.relation.parentExists) {
    lines.push(`parent thread missing: ${details.agent.relation.parentThreadId}`)
  }

  if (!details.agent.relation.childExists) {
    lines.push(`child thread missing: ${details.agent.relation.childThreadId}`)
  }

  if (
    details.agent.writeback.mode === 'apply_result' &&
    !details.agent.agent.writebackRunId
  ) {
    lines.push(`writeback ready: /agent apply ${details.agent.agent.id}`)
  }

  if (details.agent.agent.writebackRunId && !details.writebackRun) {
    lines.push(`writeback run missing: ${details.agent.agent.writebackRunId}`)
  }

  if (details.writebackRun) {
    const writebackStatus = getRunDisplayStatus(details.writebackRun)
    if (writebackStatus === 'waiting_approval') {
      lines.push(`writeback waiting_approval: /run show ${details.writebackRun.context.runId}`)
      lines.push(`writeback links: ${formatRunIssueLinkage(details.writebackRun)}`)
    } else if (writebackStatus === 'failed') {
      lines.push(
        details.writebackRun.retryable
          ? `writeback failed: /run retry ${details.writebackRun.context.runId}`
          : `writeback failed: /run show ${details.writebackRun.context.runId}`,
      )
      lines.push(`writeback links: ${formatRunIssueLinkage(details.writebackRun)}`)
    } else if (writebackStatus === 'cancelled') {
      lines.push(`writeback cancelled: /run show ${details.writebackRun.context.runId}`)
      lines.push(`writeback links: ${formatRunIssueLinkage(details.writebackRun)}`)
    }
  }

  return lines
}

export function buildAgentActionHints(
  agent: {
    id: string
    parentThreadId: string
    role: string
    task: string
    status: string
    lastError?: string
    writebackMode?: string
    writebackRunId?: string
  },
): string[] {
  const issue = buildAgentIssueSummary(agent.status, agent.lastError)
  const normalizedTask = normalizeIssueText(agent.task)

  if (issue.kind === 'waiting_approval') {
    return [
      `next: /agent show ${agent.id}`,
      agent.writebackRunId ? `next: /run show ${agent.writebackRunId}` : 'next: /run list waiting_approval',
      `next: /thread use ${agent.parentThreadId}`,
    ]
  }

  if (issue.kind === 'failed') {
    return [
      `next: /agent show ${agent.id}`,
      `next: /thread use ${agent.parentThreadId}`,
      normalizedTask && normalizedTask.length <= 120
        ? `after switching thread: /agent spawn ${agent.role} ${normalizedTask}`
        : undefined,
    ].filter(Boolean) as string[]
  }

  if (issue.kind === 'cancelled') {
    return [
      `next: /agent show ${agent.id}`,
      `next: /thread use ${agent.parentThreadId}`,
      normalizedTask && normalizedTask.length <= 120
        ? `after switching thread: /agent spawn ${agent.role} ${normalizedTask}`
        : undefined,
    ].filter(Boolean) as string[]
  }

  if (
    agent.status === 'completed' &&
    agent.writebackMode === 'apply_result' &&
    !agent.writebackRunId
  ) {
    return [
      `next: /agent apply ${agent.id}`,
      `next: /thread use ${agent.parentThreadId}`,
    ]
  }

  if (agent.writebackRunId) {
    return [
      `next: /run show ${agent.writebackRunId}`,
    ]
  }

  return []
}

export function buildAgentListIssueSummary(
  agents: Array<{
    id: string
    parentThreadId: string
    threadId: string
    projectId: string
    role: string
    task: string
    status: string
    lastError?: string
    writebackRunId?: string
  }>,
): string[] {
  const issues = agents
    .map((agent) => ({
      agent,
      issue: buildAgentIssueSummary(agent.status, agent.lastError),
    }))
    .filter(
      (
        entry,
      ): entry is {
        agent: (typeof agents)[number]
        issue: { kind: AgentIssueKind; detail: string }
      } => Boolean(entry.issue.kind && entry.issue.detail),
    )

  if (issues.length === 0) {
    return []
  }

  const priority = new Map<AgentIssueKind, number>([
    ['waiting_approval', 0],
    ['failed', 1],
    ['cancelled', 2],
  ])
  const sorted = issues
    .slice()
    .sort((left, right) => priority.get(left.issue.kind)! - priority.get(right.issue.kind)!)
  const counts = countItemsByKey(sorted, (entry) => entry.issue.kind)
  const first = sorted[0]
  const preview = sorted
    .slice(0, 3)
    .map((entry) => `${entry.issue.kind}: ${entry.agent.id} (${entry.issue.detail})`)

  return [
    `counts: ${formatStatusCounts(counts)}`,
    `inspect first: /agent show ${first.agent.id}`,
    first.issue.kind === 'waiting_approval'
      ? first.agent.writebackRunId
        ? `next: /run show ${first.agent.writebackRunId}`
        : 'next: /run list waiting_approval'
      : `next: /thread use ${first.agent.parentThreadId}`,
    `links: ${sorted
      .slice(0, 2)
      .map((entry) =>
        `${entry.issue.kind}: ${formatAgentIssueLinkage({
          id: entry.agent.id,
          parentThreadId: entry.agent.parentThreadId,
          threadId: entry.agent.threadId,
          projectId: entry.agent.projectId,
          writebackRunId: entry.issue.kind === 'waiting_approval'
            ? entry.agent.writebackRunId
            : undefined,
        })}`,
      )
      .join(' || ')}`,
    `examples: ${preview.join(' | ')}`,
  ]
}

export function buildProjectIssueLines(
  details: Awaited<ReturnType<SessionManager['getProjectDetails']>>,
): string[] {
  if (!details.project) {
    return []
  }

  const issues: string[] = []
  if (!details.defaultSource) {
    issues.push(`default source missing: ${details.project.defaultSourceId}`)
  } else if (!details.defaultSource.enabled) {
    issues.push(`default source disabled: /source enable ${details.defaultSource.id}`)
  }

  if (details.project.archivedAt) {
    issues.push(`archived: ${formatTimestamp(details.project.archivedAt)}`)
  }

  return issues
}

export function buildSourceIssueLines(
  details: NonNullable<Awaited<ReturnType<SessionManager['getSourceDetails']>>>,
): string[] {
  const issues: string[] = []
  if (!details.source.enabled) {
    issues.push(`disabled: /source enable ${details.source.id}`)
  }

  if (details.source.enabled && !details.source.importEnabled) {
    issues.push('imports disabled for this source')
  }

  return issues
}

export function buildRunIssueLines(
  run: RunRecord,
  getRunDisplayStatus: GetRunDisplayStatus,
): string[] {
  const issue = buildRunIssueSummary(run, getRunDisplayStatus)
  if (issue.kind === 'waiting_approval') {
    return [
      `waiting_approval: ${issue.detail}`,
      `links: ${formatRunIssueLinkage(run)}`,
    ]
  }

  if (issue.kind === 'failed') {
    return [
      `failed: ${issue.detail}`,
      `links: ${formatRunIssueLinkage(run)}`,
    ]
  }

  if (issue.kind === 'cancelled') {
    return [
      `cancelled: ${issue.detail}`,
      `links: ${formatRunIssueLinkage(run)}`,
    ]
  }

  return []
}

export function buildRunActionHints(
  run: RunRecord,
  getRunDisplayStatus: GetRunDisplayStatus,
): string[] {
  const issue = buildRunIssueSummary(run, getRunDisplayStatus)
  if (issue.kind === 'waiting_approval') {
    return [
      `next: /run show ${run.context.runId}`,
      run.retryable
        ? `after approval: /run retry ${run.context.runId}`
        : `next: /thread use ${run.context.threadId}`,
      run.context.agentId ? `next: /agent show ${run.context.agentId}` : 'next: /run list waiting_approval',
    ].filter(Boolean) as string[]
  }

  if (issue.kind === 'failed') {
    return [
      `next: /run show ${run.context.runId}`,
      run.retryable ? `next: /run retry ${run.context.runId}` : undefined,
      `next: /thread use ${run.context.threadId}`,
      run.context.agentId ? `next: /agent show ${run.context.agentId}` : undefined,
    ].filter(Boolean) as string[]
  }

  if (issue.kind === 'cancelled') {
    return [
      `next: /run show ${run.context.runId}`,
      run.retryable ? `next: /run retry ${run.context.runId}` : undefined,
      `next: /thread use ${run.context.threadId}`,
      run.context.agentId ? `next: /agent show ${run.context.agentId}` : undefined,
    ].filter(Boolean) as string[]
  }

  return []
}

export function buildRunListIssueSummary(
  runs: RunRecord[],
  getRunDisplayStatus: GetRunDisplayStatus,
): string[] {
  const issues = runs
    .map((run) => ({
      run,
      issue: buildRunIssueSummary(run, getRunDisplayStatus),
    }))
    .filter(
      (
        entry,
      ): entry is {
        run: RunRecord
        issue: { kind: RunIssueKind; detail: string }
      } => Boolean(entry.issue.kind && entry.issue.detail),
    )

  if (issues.length === 0) {
    return []
  }

  const priority = new Map<RunIssueKind, number>([
    ['waiting_approval', 0],
    ['failed', 1],
    ['cancelled', 2],
  ])
  const sorted = issues
    .slice()
    .sort((left, right) => priority.get(left.issue.kind)! - priority.get(right.issue.kind)!)
  const counts = countItemsByKey(sorted, (entry) => entry.issue.kind)
  const first = sorted[0]
  const preview = sorted
    .slice(0, 3)
    .map((entry) => `${entry.issue.kind}: ${entry.run.context.runId} (${entry.issue.detail})`)

  return [
    `counts: ${formatStatusCounts(counts)}`,
    `inspect first: /run show ${first.run.context.runId}`,
    first.issue.kind === 'waiting_approval'
      ? 'next: /run list waiting_approval'
      : first.run.retryable
        ? `next: /run retry ${first.run.context.runId}`
        : `next: /thread use ${first.run.context.threadId}`,
    `links: ${sorted
      .slice(0, 2)
      .map((entry) => `${entry.issue.kind}: ${formatRunIssueLinkage(entry.run)}`)
      .join(' || ')}`,
    `examples: ${preview.join(' | ')}`,
  ]
}
