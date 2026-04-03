import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { ImportCursorStore, type SourceCursor } from './import-cursor.js'
import type { ImportSummary, SourceRecord } from './models.js'
import { resolveProjectIdentity } from './project-normalizer.js'
import { StateStore } from './state-store.js'
import { canImportFromSource } from './storage-policy.js'

interface SessionIndexEntry {
  id: string
  thread_name?: string
  updated_at?: string
}

export interface ImportSyncOptions {
  sourceIds?: string[]
  onlyIfChanged?: boolean
  lookbackDays?: number
  maxTrackedFiles?: number
}

export interface ImportPendingSource {
  sourceId: string
  hasChanges: boolean
  candidateRolloutCount: number
  changedRolloutCount: number
  sessionIndexChanged: boolean
  lastScanCompletedAt?: string
}

export type ImportSyncState = 'idle' | 'running' | 'succeeded' | 'failed'

export interface ImportSourceSyncSummary {
  sourceId: string
  sourceName: string
  codexHome: string
  storagePolicy: SourceRecord['storagePolicy']
  candidateRolloutCount: number
  changedRolloutCount: number
  processedRolloutCount: number
  sessionIndexChanged: boolean
  skipped: boolean
  skipReason?: 'no-changes'
  addedProjects: number
  updatedProjects: number
  addedThreads: number
  updatedThreads: number
  startedAt: string
  completedAt: string
  durationMs: number
  cursorBefore: SourceCursor
  cursorAfter: SourceCursor
}

export interface ImportSyncRunResult {
  state: Exclude<ImportSyncState, 'idle' | 'running'>
  startedAt: string
  completedAt: string
  durationMs: number
  options: ImportSyncOptions
  summary: ImportSummary
  sources: ImportSourceSyncSummary[]
  error?: string
}

export interface ImportSourceSyncStatus {
  sourceId: string
  sourceName: string
  codexHome: string
  enabled: boolean
  importEnabled: boolean
  canImport: boolean
  storagePolicy: SourceRecord['storagePolicy']
  cursor: SourceCursor
  trackedRolloutCount: number
  trackedFingerprintCount: number
  pending?: ImportPendingSource
  lastRun?: ImportSourceSyncSummary
}

export interface ImportSyncStatus {
  state: ImportSyncState
  activeSyncCount: number
  currentSyncStartedAt?: string
  currentSyncOptions?: ImportSyncOptions
  lastCompletedAt?: string
  lastSuccessfulAt?: string
  lastError?: string
  lastRun?: ImportSyncRunResult
  sources: ImportSourceSyncStatus[]
}

interface SourceSyncPlan {
  cursor: SourceCursor
  rolloutPaths: string[]
  changedRolloutPaths: string[]
  sessionIndexMtimeMs?: number
  sessionIndexFingerprint?: string
  sessionIndexChanged: boolean
}

const DEFAULT_LOOKBACK_DAYS = 2
const DEFAULT_MAX_TRACKED_FILES = 256

export class Importer {
  private readonly cursorStore: ImportCursorStore
  private readonly ready: Promise<void>
  private activeSyncCount = 0
  private currentSyncStartedAt?: string
  private currentSyncOptions?: ImportSyncOptions
  private lastSuccessfulAt?: string
  private lastCompletedAt?: string
  private lastError?: string
  private lastRun?: ImportSyncRunResult

  constructor(
    private readonly store: StateStore,
    cursorStore?: ImportCursorStore,
  ) {
    this.cursorStore = cursorStore ?? new ImportCursorStore()
    this.ready = this.cursorStore.init()
  }

  async syncEnabledSources(
    options: ImportSyncOptions = {},
  ): Promise<ImportSummary> {
    const result = await this.syncEnabledSourcesDetailed(options)
    return result.summary
  }

  async syncEnabledSourcesDetailed(
    options: ImportSyncOptions = {},
  ): Promise<ImportSyncRunResult> {
    await this.ready

    const normalizedOptions = cloneImportSyncOptions(options)
    const summary: ImportSummary = {
      scannedSources: 0,
      scannedRollouts: 0,
      addedProjects: 0,
      updatedProjects: 0,
      addedThreads: 0,
      updatedThreads: 0,
    }
    const sourceSummaries: ImportSourceSyncSummary[] = []
    const syncStartedAt = nowIso()

    const sourceIdFilter = normalizedOptions.sourceIds
      ? new Set(normalizedOptions.sourceIds.map((sourceId) => sourceId.trim()).filter(Boolean))
      : undefined

    this.beginSync(syncStartedAt, normalizedOptions)

    try {
      for (const source of this.store.listSources()) {
        if (!canImportFromSource(source)) {
          continue
        }
        if (sourceIdFilter && !sourceIdFilter.has(source.id)) {
          continue
        }

        summary.scannedSources += 1
        sourceSummaries.push(await this.syncSource(source, summary, normalizedOptions))
      }

      const completedAt = nowIso()
      const result: ImportSyncRunResult = {
        state: 'succeeded',
        startedAt: syncStartedAt,
        completedAt,
        durationMs: durationMs(syncStartedAt, completedAt),
        options: normalizedOptions,
        summary: cloneImportSummary(summary),
        sources: sourceSummaries,
      }
      this.completeSync(result)
      return result
    } catch (error) {
      const completedAt = nowIso()
      const message = error instanceof Error ? error.message : String(error)
      const result: ImportSyncRunResult = {
        state: 'failed',
        startedAt: syncStartedAt,
        completedAt,
        durationMs: durationMs(syncStartedAt, completedAt),
        options: normalizedOptions,
        summary: cloneImportSummary(summary),
        sources: sourceSummaries,
        error: message,
      }
      this.completeSync(result)
      throw error
    }
  }

  async syncPendingSources(
    options: Omit<ImportSyncOptions, 'onlyIfChanged'> = {},
  ): Promise<ImportSummary> {
    return this.syncEnabledSources({
      ...options,
      onlyIfChanged: true,
    })
  }

  async listPendingEnabledSources(
    options: Omit<ImportSyncOptions, 'onlyIfChanged'> = {},
  ): Promise<ImportPendingSource[]> {
    await this.ready

    const sourceIdFilter = options.sourceIds
      ? new Set(options.sourceIds.map((sourceId) => sourceId.trim()).filter(Boolean))
      : undefined
    const pending: ImportPendingSource[] = []

    for (const source of this.store.listSources()) {
      if (!canImportFromSource(source)) {
        continue
      }
      if (sourceIdFilter && !sourceIdFilter.has(source.id)) {
        continue
      }

      const plan = await this.planSourceSync(source, {
        ...options,
        onlyIfChanged: true,
      })
      pending.push({
        sourceId: source.id,
        hasChanges:
          plan.changedRolloutPaths.length > 0 || plan.sessionIndexChanged,
        candidateRolloutCount: plan.rolloutPaths.length,
        changedRolloutCount: plan.changedRolloutPaths.length,
        sessionIndexChanged: plan.sessionIndexChanged,
        lastScanCompletedAt: plan.cursor.lastScanCompletedAt ?? plan.cursor.lastScanAt,
      })
    }

    return pending
  }

  async getSyncStatus(
    options: Omit<ImportSyncOptions, 'onlyIfChanged'> = {},
  ): Promise<ImportSyncStatus> {
    await this.ready

    return {
      state: this.getCurrentSyncState(),
      activeSyncCount: this.activeSyncCount,
      currentSyncStartedAt: this.currentSyncStartedAt,
      currentSyncOptions: this.currentSyncOptions
        ? cloneImportSyncOptions(this.currentSyncOptions)
        : undefined,
      lastCompletedAt: this.lastCompletedAt,
      lastSuccessfulAt: this.lastSuccessfulAt,
      lastError: this.lastError,
      lastRun: this.lastRun ? cloneImportSyncRunResult(this.lastRun) : undefined,
      sources: await this.listSourceSyncStatuses(options),
    }
  }

  async getSourceSyncStatus(
    sourceId: string,
    options: Omit<ImportSyncOptions, 'onlyIfChanged' | 'sourceIds'> = {},
  ): Promise<ImportSourceSyncStatus | undefined> {
    const statuses = await this.listSourceSyncStatuses({
      ...options,
      sourceIds: [sourceId],
    })
    return statuses[0]
  }

  private async syncSource(
    source: SourceRecord,
    summary: ImportSummary,
    options: ImportSyncOptions,
  ): Promise<ImportSourceSyncSummary> {
    const syncStartedAt = new Date().toISOString()
    await this.cursorStore.patchSourceCursor(source.id, {
      lastScanStartedAt: syncStartedAt,
    })

    const titleIndex = await this.loadSessionIndex(source)
    const plan = await this.planSourceSync(source, options)
    const beforeSummary = cloneImportSummary(summary)
    const rolloutPaths =
      plan.onlyIfChanged && !plan.sessionIndexChanged
        ? plan.changedRolloutPaths
        : plan.rolloutPaths

    summary.scannedRollouts += rolloutPaths.length
    let latestImportedMtimeMs = plan.cursor.lastImportedMtimeMs ?? 0
    let latestImportedPath = plan.cursor.lastImportedPath
    let latestSeenMtimeMs = plan.cursor.lastSeenMtimeMs ?? 0
    let latestSeenPath = plan.cursor.lastSeenPath
    const trackedFiles = { ...plan.cursor.files }
    const trackedFingerprints = { ...(plan.cursor.fileFingerprints ?? {}) }

    for (const rolloutPath of rolloutPaths) {
      const rolloutStats = await stat(rolloutPath)
      trackedFiles[rolloutPath] = rolloutStats.mtimeMs
      trackedFingerprints[rolloutPath] = await this.readRolloutFingerprint(rolloutPath)
      if (
        rolloutStats.mtimeMs > latestSeenMtimeMs ||
        (rolloutStats.mtimeMs === latestSeenMtimeMs &&
          rolloutPath > (latestSeenPath ?? ''))
      ) {
        latestSeenMtimeMs = rolloutStats.mtimeMs
        latestSeenPath = rolloutPath
      }

      const metadata = await this.readSessionMeta(rolloutPath)
      if (!metadata?.id || !metadata.cwd) {
        continue
      }

      const identity = await resolveProjectIdentity(metadata.cwd)
      let project = this.store.findProjectByProjectKey(identity.projectKey)
      if (!project) {
        project = await this.store.createProject(
          identity.defaultName || basename(identity.cwd) || identity.cwd,
          identity.cwd,
          source.id,
          identity.projectKey,
        )
        summary.addedProjects += 1
      } else if (
        project.cwd !== identity.cwd ||
        project.projectKey !== identity.projectKey
      ) {
        project = await this.store.updateProject(project.id, {
          cwd: identity.cwd,
          projectKey: identity.projectKey,
        })
        summary.updatedProjects += 1
      }

      const indexed = titleIndex.get(metadata.id)
      const title =
        indexed?.thread_name?.trim() || deriveTitle(identity.defaultName, metadata.id)
      const updatedAt =
        indexed?.updated_at ||
        metadata.timestamp ||
        metadata.metaTimestamp ||
        undefined
      const { created } = await this.store.upsertThread({
        projectId: project.id,
        sourceId: source.id,
        cwd: metadata.cwd,
        title,
        origin: 'imported',
        originator: metadata.originator ?? 'imported',
        codexThreadId: metadata.id,
        status: 'idle',
        updatedAt,
      })

      if (created) {
        summary.addedThreads += 1
      } else {
        summary.updatedThreads += 1
      }

      if (
        rolloutStats.mtimeMs > latestImportedMtimeMs ||
        (rolloutStats.mtimeMs === latestImportedMtimeMs &&
          rolloutPath > (latestImportedPath ?? ''))
      ) {
        latestImportedMtimeMs = rolloutStats.mtimeMs
        latestImportedPath = rolloutPath
      }
    }

    const cursorAfter = {
      ...plan.cursor,
      lastScanAt: new Date().toISOString(),
      lastScanStartedAt: syncStartedAt,
      lastScanCompletedAt: new Date().toISOString(),
      lastImportedMtimeMs: latestImportedMtimeMs || undefined,
      lastImportedPath: latestImportedPath,
      lastSeenMtimeMs: latestSeenMtimeMs || undefined,
      lastSeenPath: latestSeenPath,
      lastSessionIndexMtimeMs: plan.sessionIndexMtimeMs,
      lastSessionIndexFingerprint: plan.sessionIndexFingerprint,
      files: trimTrackedFiles(
        trackedFiles,
        options.maxTrackedFiles ?? DEFAULT_MAX_TRACKED_FILES,
      ),
      fileFingerprints: trimTrackedFingerprints(
        trackedFingerprints,
        trackedFiles,
        options.maxTrackedFiles ?? DEFAULT_MAX_TRACKED_FILES,
      ),
    }

    await this.cursorStore.setSourceCursor(source.id, cursorAfter)

    const completedAt = nowIso()
    return {
      sourceId: source.id,
      sourceName: source.name,
      codexHome: source.codexHome,
      storagePolicy: source.storagePolicy,
      candidateRolloutCount: plan.rolloutPaths.length,
      changedRolloutCount: plan.changedRolloutPaths.length,
      processedRolloutCount: rolloutPaths.length,
      sessionIndexChanged: plan.sessionIndexChanged,
      skipped: rolloutPaths.length === 0,
      skipReason: rolloutPaths.length === 0 ? 'no-changes' : undefined,
      addedProjects: summary.addedProjects - beforeSummary.addedProjects,
      updatedProjects: summary.updatedProjects - beforeSummary.updatedProjects,
      addedThreads: summary.addedThreads - beforeSummary.addedThreads,
      updatedThreads: summary.updatedThreads - beforeSummary.updatedThreads,
      startedAt: syncStartedAt,
      completedAt,
      durationMs: durationMs(syncStartedAt, completedAt),
      cursorBefore: cloneSourceCursor(plan.cursor),
      cursorAfter: cloneSourceCursor(cursorAfter),
    }
  }

  private async planSourceSync(
    source: SourceRecord,
    options: ImportSyncOptions,
    existingCursor?: SourceCursor,
  ): Promise<SourceSyncPlan & { onlyIfChanged: boolean }> {
    const cursor = existingCursor ?? this.cursorStore.getSourceCursor(source.id)
    const sessionsRoot = join(source.codexHome, 'sessions')
    const sessionIndexPath = join(source.codexHome, 'session_index.jsonl')
    const sessionIndexMtimeMs = await this.readOptionalMtimeMs(sessionIndexPath)
    const shouldReadSessionIndexFingerprint =
      sessionIndexMtimeMs !== undefined
        ? sessionIndexMtimeMs !== cursor.lastSessionIndexMtimeMs ||
          !cursor.lastSessionIndexFingerprint
        : false
    const sessionIndexFingerprint = shouldReadSessionIndexFingerprint
      ? await this.readOptionalFileFingerprint(sessionIndexPath)
      : sessionIndexMtimeMs === undefined
        ? undefined
        : cursor.lastSessionIndexFingerprint
    const rolloutPaths = await this.collectRolloutPaths(
      sessionsRoot,
      cursor.lastScanCompletedAt ?? cursor.lastScanAt,
      options.lookbackDays,
    )
    const changedRolloutPaths = await this.filterChangedRollouts(
      rolloutPaths,
      cursor,
      options.maxTrackedFiles,
    )

    return {
      cursor,
      rolloutPaths,
      changedRolloutPaths,
      sessionIndexMtimeMs,
      sessionIndexFingerprint,
      sessionIndexChanged:
        sessionIndexMtimeMs !== cursor.lastSessionIndexMtimeMs ||
        sessionIndexFingerprint !== cursor.lastSessionIndexFingerprint,
      onlyIfChanged: options.onlyIfChanged ?? false,
    }
  }

  private async loadSessionIndex(
    source: SourceRecord,
  ): Promise<Map<string, SessionIndexEntry>> {
    const indexPath = join(source.codexHome, 'session_index.jsonl')
    const entries = new Map<string, SessionIndexEntry>()

    try {
      const raw = await readFile(indexPath, 'utf8')

      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) {
          continue
        }

        try {
          const parsed = JSON.parse(trimmed) as SessionIndexEntry
          if (typeof parsed.id === 'string' && parsed.id.length > 0) {
            entries.set(parsed.id, parsed)
          }
        } catch {
          // Ignore malformed lines.
        }
      }
    } catch {
      // session_index.jsonl is optional.
    }

    return entries
  }

  private async collectRolloutPaths(
    root: string,
    lastScanAt?: string,
    lookbackDays = DEFAULT_LOOKBACK_DAYS,
  ): Promise<string[]> {
    const paths: string[] = []
    const sinceDate = lastScanAt ? new Date(lastScanAt) : undefined

    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry.name)

        if (entry.isDirectory()) {
          await walk(fullPath)
          continue
        }

        if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          paths.push(fullPath)
        }
      }
    }

    if (sinceDate && !Number.isNaN(sinceDate.getTime())) {
      const start = new Date(
        Date.UTC(
          sinceDate.getUTCFullYear(),
          sinceDate.getUTCMonth(),
          sinceDate.getUTCDate(),
        ),
      )
      start.setUTCDate(start.getUTCDate() - Math.max(0, lookbackDays))
      const today = new Date()
      for (
        let cursor = start;
        cursor <= today;
        cursor = new Date(
          Date.UTC(
            cursor.getUTCFullYear(),
            cursor.getUTCMonth(),
            cursor.getUTCDate() + 1,
          ),
        )
      ) {
        await walk(join(root, ...getDatePath(cursor)))
      }
    } else {
      await walk(root)
    }

    paths.sort()
    return paths
  }

  private async filterChangedRollouts(
    rolloutPaths: string[],
    cursor: SourceCursor,
    maxTrackedFiles = DEFAULT_MAX_TRACKED_FILES,
  ): Promise<string[]> {
    const changed: string[] = []
    const recentTrackedEntries = Object.entries(cursor.files)
      .sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0]))
      .slice(0, Math.max(1, maxTrackedFiles))
    const recentTracked = new Map<string, number>(recentTrackedEntries)
    const recentFingerprints = new Map<string, string>()
    for (const [rolloutPath] of recentTrackedEntries) {
      const fingerprint = cursor.fileFingerprints?.[rolloutPath]
      if (fingerprint) {
        recentFingerprints.set(rolloutPath, fingerprint)
      }
    }

    for (const rolloutPath of rolloutPaths) {
      const rolloutStats = await stat(rolloutPath)
      const cachedMtimeMs = recentTracked.get(rolloutPath)
      if (cachedMtimeMs === rolloutStats.mtimeMs) {
        continue
      }

      const fingerprint = await this.readRolloutFingerprint(rolloutPath)
      const cachedFingerprint = recentFingerprints.get(rolloutPath)
      if (
        cachedMtimeMs !== undefined &&
        cachedFingerprint &&
        cachedFingerprint === fingerprint
      ) {
        continue
      }

      changed.push(rolloutPath)
    }

    return changed
  }

  private async readSessionMeta(
    rolloutPath: string,
  ): Promise<
    | {
        id?: string
        cwd?: string
        timestamp?: string
        metaTimestamp?: string
        originator?: string
      }
    | undefined
  > {
    try {
      const raw = await readFile(rolloutPath, 'utf8')
      const firstLine = raw.split('\n', 1)[0]?.trim()

      if (!firstLine) {
        return undefined
      }

      const parsed = JSON.parse(firstLine) as {
        timestamp?: string
        type?: string
        payload?: {
          id?: string
          cwd?: string
          timestamp?: string
          originator?: string
          source?: string
        }
      }

      if (parsed.type !== 'session_meta') {
        return undefined
      }

      const rawOriginator = parsed.payload?.originator
      const payloadSource = parsed.payload?.source
      let originator: string
      if (rawOriginator === 'Codex Desktop' || payloadSource === 'vscode') {
        originator = 'Codex Desktop'
      } else if (rawOriginator) {
        originator = rawOriginator
      } else {
        originator = 'imported'
      }

      return {
        id: parsed.payload?.id,
        cwd: parsed.payload?.cwd,
        timestamp: parsed.payload?.timestamp,
        metaTimestamp: parsed.timestamp,
        originator,
      }
    } catch {
      return undefined
    }
  }

  private async readOptionalMtimeMs(path: string): Promise<number | undefined> {
    try {
      const stats = await stat(path)
      return stats.mtimeMs
    } catch {
      return undefined
    }
  }

  private async readRolloutFingerprint(rolloutPath: string): Promise<string> {
    try {
      const raw = await readFile(rolloutPath, 'utf8')
      return createHash('sha1').update(raw).digest('hex')
    } catch {
      return ''
    }
  }

  private async readOptionalFileFingerprint(path: string): Promise<string | undefined> {
    try {
      const raw = await readFile(path, 'utf8')
      return createHash('sha1').update(raw).digest('hex')
    } catch {
      return undefined
    }
  }

  private async listSourceSyncStatuses(
    options: Omit<ImportSyncOptions, 'onlyIfChanged'> = {},
  ): Promise<ImportSourceSyncStatus[]> {
    const sourceIdFilter = options.sourceIds
      ? new Set(options.sourceIds.map((sourceId) => sourceId.trim()).filter(Boolean))
      : undefined
    const pendingBySource = new Map<string, ImportPendingSource>()
    const pendingSources = await this.listPendingEnabledSources(options)
    for (const pending of pendingSources) {
      pendingBySource.set(pending.sourceId, pending)
    }
    const lastRunBySource = new Map(
      (this.lastRun?.sources ?? []).map((source) => [source.sourceId, source] as const),
    )

    return this.store
      .listSources({ includeDisabled: true })
      .filter((source) => !sourceIdFilter || sourceIdFilter.has(source.id))
      .map((source) => {
        const cursor = this.cursorStore.getSourceCursor(source.id)
        return {
          sourceId: source.id,
          sourceName: source.name,
          codexHome: source.codexHome,
          enabled: source.enabled,
          importEnabled: source.importEnabled,
          canImport: canImportFromSource(source),
          storagePolicy: source.storagePolicy,
          cursor: cloneSourceCursor(cursor),
          trackedRolloutCount: Object.keys(cursor.files).length,
          trackedFingerprintCount: Object.keys(cursor.fileFingerprints ?? {}).length,
          pending: pendingBySource.get(source.id),
          lastRun: lastRunBySource.get(source.id),
        }
      })
  }

  private beginSync(startedAt: string, options: ImportSyncOptions): void {
    this.activeSyncCount += 1
    this.currentSyncStartedAt = startedAt
    this.currentSyncOptions = cloneImportSyncOptions(options)
    this.lastError = undefined
  }

  private completeSync(result: ImportSyncRunResult): void {
    this.activeSyncCount = Math.max(0, this.activeSyncCount - 1)
    this.lastCompletedAt = result.completedAt
    this.lastRun = cloneImportSyncRunResult(result)

    if (result.state === 'succeeded') {
      this.lastSuccessfulAt = result.completedAt
      this.lastError = undefined
    } else {
      this.lastError = result.error
    }

    if (this.activeSyncCount === 0) {
      this.currentSyncStartedAt = undefined
      this.currentSyncOptions = undefined
    }
  }

  private getCurrentSyncState(): ImportSyncState {
    if (this.activeSyncCount > 0) {
      return 'running'
    }
    if (this.lastRun) {
      return this.lastRun.state
    }
    if (this.lastError) {
      return 'failed'
    }
    return 'idle'
  }
}

function deriveTitle(projectName: string, threadId: string): string {
  return `${projectName} ${threadId.slice(0, 8)}`
}

function nowIso(): string {
  return new Date().toISOString()
}

function durationMs(startedAt: string, completedAt: string): number {
  const started = Date.parse(startedAt)
  const completed = Date.parse(completedAt)
  if (Number.isNaN(started) || Number.isNaN(completed)) {
    return 0
  }
  return Math.max(0, completed - started)
}

function cloneImportSummary(summary: ImportSummary): ImportSummary {
  return { ...summary }
}

function cloneImportSyncOptions(options: ImportSyncOptions): ImportSyncOptions {
  return {
    ...options,
    sourceIds: options.sourceIds ? [...options.sourceIds] : undefined,
  }
}

function cloneSourceCursor(cursor: SourceCursor): SourceCursor {
  return {
    ...cursor,
    files: { ...cursor.files },
    fileFingerprints: cursor.fileFingerprints
      ? { ...cursor.fileFingerprints }
      : undefined,
  }
}

function cloneImportSourceSyncSummary(
  summary: ImportSourceSyncSummary,
): ImportSourceSyncSummary {
  return {
    ...summary,
    cursorBefore: cloneSourceCursor(summary.cursorBefore),
    cursorAfter: cloneSourceCursor(summary.cursorAfter),
  }
}

function cloneImportSyncRunResult(
  result: ImportSyncRunResult,
): ImportSyncRunResult {
  return {
    ...result,
    options: cloneImportSyncOptions(result.options),
    summary: cloneImportSummary(result.summary),
    sources: result.sources.map(cloneImportSourceSyncSummary),
  }
}

function getDatePath(date: Date): string[] {
  const year = String(date.getUTCFullYear())
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return [year, month, day]
}

function trimTrackedFiles(
  files: Record<string, number>,
  maxEntries: number,
): Record<string, number> {
  const limit = Number.isFinite(maxEntries) && maxEntries > 0
    ? Math.floor(maxEntries)
    : DEFAULT_MAX_TRACKED_FILES

  return Object.fromEntries(
    Object.entries(files)
      .sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0]))
      .slice(0, limit),
  )
}

function trimTrackedFingerprints(
  fingerprints: Record<string, string>,
  files: Record<string, number>,
  maxEntries: number,
): Record<string, string> {
  const limit = Number.isFinite(maxEntries) && maxEntries > 0
    ? Math.floor(maxEntries)
    : DEFAULT_MAX_TRACKED_FILES
  const keepPaths = new Set(
    Object.entries(files)
      .sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0]))
      .slice(0, limit)
      .map(([path]) => path),
  )

  return Object.fromEntries(
    Object.entries(fingerprints)
      .filter(([path]) => keepPaths.has(path))
      .sort((left, right) => left[0].localeCompare(right[0])),
  )
}
