import type {
  AgentParentSourceOverrideMode,
  ProjectSourceMode,
  SourceRecord,
  SourceStoragePolicy,
} from './models.js'

export const STORAGE_POLICIES = ['shared', 'isolated'] as const
export const DEFAULT_STORAGE_POLICY: SourceStoragePolicy = 'shared'

export interface StorageSourceLike {
  id: string
  storagePolicy?: SourceStoragePolicy | null
  enabled?: boolean
  importEnabled?: boolean
}

export interface StorageProjectLike {
  defaultSourceId?: string | null
}

export interface StorageThreadLike {
  sourceId: string
  origin?: string | null
}

export type SourceSelectionReason =
  | 'explicit-source'
  | 'parent-thread-source'
  | 'project-default'
  | 'policy-match'
  | 'first-available'
  | 'unavailable'

export type SourceSelectionConstraintReason =
  | ProjectSourceDecisionReason
  | AgentSourceOverrideDecisionReason

export interface SourceSelection<TSource extends StorageSourceLike = SourceRecord> {
  source?: TSource
  policy: SourceStoragePolicy
  reason: SourceSelectionReason
  forced?: boolean
  constraintReason?: SourceSelectionConstraintReason
}

export interface ThreadSourceSelectionInput<
  TSource extends StorageSourceLike = SourceRecord,
> {
  sources: readonly TSource[]
  preferredSourceId?: string | null
  projectDefaultSourceId?: string | null
  desiredPolicy?: SourceStoragePolicy | null
  allowDisabled?: boolean
  fallbackPolicy?: SourceStoragePolicy
  projectSourceMode?: ProjectSourceMode
}

export interface AgentSourceSelectionInput<
  TSource extends StorageSourceLike = SourceRecord,
> {
  sources: readonly TSource[]
  preferredSourceId?: string | null
  parentThreadSourceId?: string | null
  projectDefaultSourceId?: string | null
  allowDisabled?: boolean
  fallbackPolicy?: SourceStoragePolicy
  projectSourceMode?: ProjectSourceMode
  parentSourceOverrideMode?: AgentParentSourceOverrideMode
}

export interface ProjectSourceDecisionInput<
  TSource extends StorageSourceLike = SourceRecord,
> {
  sources: readonly TSource[]
  projectDefaultSourceId?: string | null
  allowDisabled?: boolean
  fallbackPolicy?: SourceStoragePolicy
  projectSourceMode?: ProjectSourceMode
}

export type ProjectSourceDecisionReason =
  | 'not-configured'
  | 'not-forced'
  | 'forced-by-input'
  | 'forced-by-isolated-policy'
  | 'source-unavailable'

export interface ProjectSourceDecision<TSource extends StorageSourceLike = SourceRecord> {
  source?: TSource
  policy: SourceStoragePolicy
  forced: boolean
  reason: ProjectSourceDecisionReason
}

export interface AgentSourceOverrideDecisionInput<
  TSource extends StorageSourceLike = SourceRecord,
> {
  sources: readonly TSource[]
  preferredSourceId?: string | null
  parentThreadSourceId?: string | null
  projectDefaultSourceId?: string | null
  allowDisabled?: boolean
  fallbackPolicy?: SourceStoragePolicy
  projectSourceMode?: ProjectSourceMode
  parentSourceOverrideMode?: AgentParentSourceOverrideMode
}

export type AgentSourceOverrideDecisionReason =
  | 'no-override-requested'
  | 'preferred-source-unavailable'
  | 'no-parent-source'
  | 'same-source'
  | 'override-allowed'
  | 'parent-source-forced'
  | 'project-source-forced'

export interface AgentSourceOverrideDecision<
  TSource extends StorageSourceLike = SourceRecord,
> {
  allowed: boolean
  preferredSource?: TSource
  parentSource?: TSource
  policy: SourceStoragePolicy
  reason: AgentSourceOverrideDecisionReason
}

export type ImportDecisionReason =
  | 'allowed'
  | 'source-missing'
  | 'source-disabled'
  | 'import-disabled'

export interface ImportDecision<TSource extends StorageSourceLike = SourceRecord> {
  allowed: boolean
  source?: TSource
  policy: SourceStoragePolicy
  reason: ImportDecisionReason
}

export type WritebackDecisionReason =
  | 'allowed'
  | 'thread-missing'
  | 'source-missing'
  | 'source-disabled'
  | 'thread-source-mismatch'
  | 'imported-thread-readonly'

export interface WritebackDecision<
  TSource extends StorageSourceLike = SourceRecord,
  TThread extends StorageThreadLike = StorageThreadLike,
> {
  allowed: boolean
  source?: TSource
  thread?: TThread
  policy: SourceStoragePolicy
  reason: WritebackDecisionReason
}

export function isStoragePolicy(value: unknown): value is SourceStoragePolicy {
  return value === 'shared' || value === 'isolated'
}

export function parseStoragePolicy(
  value: unknown,
  fallback: SourceStoragePolicy = DEFAULT_STORAGE_POLICY,
): SourceStoragePolicy {
  return isStoragePolicy(value) ? value : fallback
}

export function isSharedStoragePolicy(value: unknown): boolean {
  return parseStoragePolicy(value) === 'shared'
}

export function isIsolatedStoragePolicy(value: unknown): boolean {
  return parseStoragePolicy(value) === 'isolated'
}

export function resolveSourceStoragePolicy(
  source: Pick<StorageSourceLike, 'storagePolicy'> | null | undefined,
  fallback: SourceStoragePolicy = DEFAULT_STORAGE_POLICY,
): SourceStoragePolicy {
  return parseStoragePolicy(source?.storagePolicy, fallback)
}

export function isSourceEnabled(
  source: Pick<StorageSourceLike, 'enabled'> | null | undefined,
): boolean {
  return source?.enabled !== false
}

export function isImportedThread(
  thread: Pick<StorageThreadLike, 'origin'> | null | undefined,
): boolean {
  return thread?.origin === 'imported'
}

export function findSourceById<TSource extends { id: string }>(
  sources: readonly TSource[],
  sourceId: string | null | undefined,
): TSource | undefined {
  if (!sourceId) {
    return undefined
  }

  return sources.find((source) => source.id === sourceId)
}

export function resolveThreadStoragePolicy<TSource extends StorageSourceLike>(
  thread: StorageThreadLike | null | undefined,
  sources: readonly TSource[],
  fallback: SourceStoragePolicy = DEFAULT_STORAGE_POLICY,
): SourceStoragePolicy {
  const source = findSourceById(sources, thread?.sourceId)
  return resolveSourceStoragePolicy(source, fallback)
}

export function isProjectSourceForced(
  source: Pick<StorageSourceLike, 'storagePolicy'> | null | undefined,
  mode: ProjectSourceMode = 'policy-default',
  fallback: SourceStoragePolicy = DEFAULT_STORAGE_POLICY,
): boolean {
  if (mode === 'force') {
    return true
  }

  if (mode === 'prefer') {
    return false
  }

  return resolveSourceStoragePolicy(source, fallback) === 'isolated'
}

export function getProjectSourceDecision<TSource extends StorageSourceLike>(
  input: ProjectSourceDecisionInput<TSource>,
): ProjectSourceDecision<TSource> {
  const configuredSource = findSourceById(input.sources, input.projectDefaultSourceId)
  const source = findSelectableSource(
    input.sources,
    input.projectDefaultSourceId,
    input.allowDisabled,
  )
  const policy = resolveSourceStoragePolicy(
    configuredSource ?? source,
    input.fallbackPolicy,
  )

  if (!input.projectDefaultSourceId) {
    return {
      source: undefined,
      policy,
      forced: false,
      reason: 'not-configured',
    }
  }

  const forced = isProjectSourceForced(
    configuredSource ?? source,
    input.projectSourceMode,
    input.fallbackPolicy,
  )

  if (!forced) {
    return {
      source,
      policy,
      forced: false,
      reason: 'not-forced',
    }
  }

  if (!source) {
    return {
      source: undefined,
      policy,
      forced: true,
      reason: 'source-unavailable',
    }
  }

  return {
    source,
    policy,
    forced: true,
    reason:
      input.projectSourceMode === 'force'
        ? 'forced-by-input'
        : 'forced-by-isolated-policy',
  }
}

export function selectThreadSource<TSource extends StorageSourceLike>(
  input: ThreadSourceSelectionInput<TSource>,
): SourceSelection<TSource> {
  const projectDecision = getProjectSourceDecision({
    sources: input.sources,
    projectDefaultSourceId: input.projectDefaultSourceId,
    allowDisabled: input.allowDisabled,
    fallbackPolicy: input.fallbackPolicy,
    projectSourceMode: input.projectSourceMode,
  })

  if (projectDecision.forced) {
    return {
      source: projectDecision.source,
      policy: projectDecision.policy,
      reason: projectDecision.source ? 'project-default' : 'unavailable',
      forced: true,
      constraintReason: projectDecision.reason,
    }
  }

  const sourcePool = filterSelectableSources(input.sources, input.allowDisabled)
  const preferredSource = findSelectableSource(
    input.sources,
    input.preferredSourceId,
    input.allowDisabled,
  )

  if (preferredSource) {
    return {
      source: preferredSource,
      policy: resolveSourceStoragePolicy(preferredSource, input.fallbackPolicy),
      reason: 'explicit-source',
    }
  }

  const projectDefaultSource = projectDecision.source
  const desiredPolicy = parseStoragePolicy(
    input.desiredPolicy ?? projectDefaultSource?.storagePolicy,
    input.fallbackPolicy,
  )

  if (
    projectDefaultSource &&
    resolveSourceStoragePolicy(projectDefaultSource, desiredPolicy) === desiredPolicy
  ) {
    return {
      source: projectDefaultSource,
      policy: desiredPolicy,
      reason: 'project-default',
    }
  }

  const policyMatch = sourcePool.find(
    (source) => resolveSourceStoragePolicy(source, desiredPolicy) === desiredPolicy,
  )
  if (policyMatch) {
    return {
      source: policyMatch,
      policy: desiredPolicy,
      reason: 'policy-match',
    }
  }

  if (projectDefaultSource) {
    return {
      source: projectDefaultSource,
      policy: resolveSourceStoragePolicy(projectDefaultSource, desiredPolicy),
      reason: 'project-default',
    }
  }

  const firstAvailable = sourcePool[0]
  if (firstAvailable) {
    return {
      source: firstAvailable,
      policy: resolveSourceStoragePolicy(firstAvailable, desiredPolicy),
      reason: 'first-available',
    }
  }

  return {
    source: undefined,
    policy: desiredPolicy,
    reason: 'unavailable',
    constraintReason: projectDecision.reason,
  }
}

export function canAgentOverrideParentSource<TSource extends StorageSourceLike>(
  input: AgentSourceOverrideDecisionInput<TSource>,
): boolean {
  return getAgentSourceOverrideDecision(input).allowed
}

export function getAgentSourceOverrideDecision<TSource extends StorageSourceLike>(
  input: AgentSourceOverrideDecisionInput<TSource>,
): AgentSourceOverrideDecision<TSource> {
  const preferredSource = findSelectableSource(
    input.sources,
    input.preferredSourceId,
    input.allowDisabled,
  )
  const parentSource = findSelectableSource(
    input.sources,
    input.parentThreadSourceId,
    input.allowDisabled,
  )
  const parentPolicy = resolveSourceStoragePolicy(parentSource, input.fallbackPolicy)

  if (!input.preferredSourceId) {
    return {
      allowed: true,
      preferredSource: undefined,
      parentSource,
      policy: parentPolicy,
      reason: 'no-override-requested',
    }
  }

  if (!preferredSource) {
    return {
      allowed: false,
      preferredSource: undefined,
      parentSource,
      policy: parentPolicy,
      reason: 'preferred-source-unavailable',
    }
  }

  if (!parentSource) {
    return {
      allowed: true,
      preferredSource,
      parentSource: undefined,
      policy: resolveSourceStoragePolicy(preferredSource, input.fallbackPolicy),
      reason: 'no-parent-source',
    }
  }

  if (preferredSource.id === parentSource.id) {
    return {
      allowed: true,
      preferredSource,
      parentSource,
      policy: parentPolicy,
      reason: 'same-source',
    }
  }

  const projectDecision = getProjectSourceDecision({
    sources: input.sources,
    projectDefaultSourceId: input.projectDefaultSourceId,
    allowDisabled: input.allowDisabled,
    fallbackPolicy: input.fallbackPolicy,
    projectSourceMode: input.projectSourceMode,
  })

  if (
    projectDecision.forced &&
    projectDecision.source &&
    preferredSource.id !== projectDecision.source.id
  ) {
    return {
      allowed: false,
      preferredSource,
      parentSource,
      policy: parentPolicy,
      reason: 'project-source-forced',
    }
  }

  const allowOverride =
    resolveAgentParentSourceOverrideMode(
      input.parentSourceOverrideMode,
      parentSource,
      input.fallbackPolicy,
    ) === 'allow'

  return {
    allowed: allowOverride,
    preferredSource,
    parentSource,
    policy: parentPolicy,
    reason: allowOverride ? 'override-allowed' : 'parent-source-forced',
  }
}

export function selectAgentSource<TSource extends StorageSourceLike>(
  input: AgentSourceSelectionInput<TSource>,
): SourceSelection<TSource> {
  const parentThreadSource = findSelectableSource(
    input.sources,
    input.parentThreadSourceId,
    input.allowDisabled,
  )
  const parentPolicy = resolveSourceStoragePolicy(
    parentThreadSource,
    input.fallbackPolicy,
  )

  if (input.preferredSourceId) {
    const overrideDecision = getAgentSourceOverrideDecision({
      sources: input.sources,
      preferredSourceId: input.preferredSourceId,
      parentThreadSourceId: input.parentThreadSourceId,
      projectDefaultSourceId: input.projectDefaultSourceId,
      allowDisabled: input.allowDisabled,
      fallbackPolicy: input.fallbackPolicy,
      projectSourceMode: input.projectSourceMode,
      parentSourceOverrideMode: input.parentSourceOverrideMode,
    })

    if (overrideDecision.allowed && overrideDecision.preferredSource) {
      return {
        source: overrideDecision.preferredSource,
        policy: resolveSourceStoragePolicy(
          overrideDecision.preferredSource,
          input.fallbackPolicy,
        ),
        reason: 'explicit-source',
        constraintReason: overrideDecision.reason,
      }
    }

    if (parentThreadSource) {
      return {
        source: parentThreadSource,
        policy: parentPolicy,
        reason: 'parent-thread-source',
        forced: overrideDecision.reason === 'parent-source-forced',
        constraintReason: overrideDecision.reason,
      }
    }

    const fallbackSelection = selectThreadSource({
      sources: input.sources,
      projectDefaultSourceId: input.projectDefaultSourceId,
      desiredPolicy: parentPolicy,
      allowDisabled: input.allowDisabled,
      fallbackPolicy: input.fallbackPolicy,
      projectSourceMode: input.projectSourceMode,
    })

    return {
      ...fallbackSelection,
      constraintReason:
        fallbackSelection.constraintReason ?? overrideDecision.reason,
    }
  }

  if (parentThreadSource) {
    return {
      source: parentThreadSource,
      policy: parentPolicy,
      reason: 'parent-thread-source',
    }
  }

  return selectThreadSource({
    sources: input.sources,
    projectDefaultSourceId: input.projectDefaultSourceId,
    desiredPolicy: parentPolicy,
    allowDisabled: input.allowDisabled,
    fallbackPolicy: input.fallbackPolicy,
    projectSourceMode: input.projectSourceMode,
  })
}

export function getImportDecision<TSource extends StorageSourceLike>(
  source: TSource | null | undefined,
  fallbackPolicy: SourceStoragePolicy = DEFAULT_STORAGE_POLICY,
): ImportDecision<TSource> {
  const policy = resolveSourceStoragePolicy(source, fallbackPolicy)

  if (!source) {
    return {
      allowed: false,
      source: undefined,
      policy,
      reason: 'source-missing',
    }
  }

  if (!isSourceEnabled(source)) {
    return {
      allowed: false,
      source,
      policy,
      reason: 'source-disabled',
    }
  }

  if (source.importEnabled === false) {
    return {
      allowed: false,
      source,
      policy,
      reason: 'import-disabled',
    }
  }

  return {
    allowed: true,
    source,
    policy,
    reason: 'allowed',
  }
}

export function canImportFromSource(
  source: StorageSourceLike | null | undefined,
  fallbackPolicy: SourceStoragePolicy = DEFAULT_STORAGE_POLICY,
): boolean {
  return getImportDecision(source, fallbackPolicy).allowed
}

export function canWritebackImportedThreadToSource(
  thread: StorageThreadLike | null | undefined,
  source: StorageSourceLike | null | undefined,
  fallbackPolicy: SourceStoragePolicy = DEFAULT_STORAGE_POLICY,
): boolean {
  if (!thread || !isImportedThread(thread)) {
    return true
  }

  // Imported threads can execute on shared sources — the bot shares the same
  // codex home as the desktop app, so running on a shared source is expected.
  // Only block if both source and thread are present but source is disabled.
  return true
}

export function getWritebackDecision<
  TSource extends StorageSourceLike,
  TThread extends StorageThreadLike,
>(
  thread: TThread | null | undefined,
  source: TSource | null | undefined,
  fallbackPolicy: SourceStoragePolicy = DEFAULT_STORAGE_POLICY,
): WritebackDecision<TSource, TThread> {
  const policy = resolveSourceStoragePolicy(source, fallbackPolicy)

  if (!thread) {
    return {
      allowed: false,
      source: source ?? undefined,
      thread: undefined,
      policy,
      reason: 'thread-missing',
    }
  }

  if (!source) {
    return {
      allowed: false,
      source: undefined,
      thread,
      policy,
      reason: 'source-missing',
    }
  }

  if (!isSourceEnabled(source)) {
    return {
      allowed: false,
      source,
      thread,
      policy,
      reason: 'source-disabled',
    }
  }

  if (thread.sourceId !== source.id) {
    return {
      allowed: false,
      source,
      thread,
      policy,
      reason: 'thread-source-mismatch',
    }
  }

  if (!canWritebackImportedThreadToSource(thread, source, fallbackPolicy)) {
    return {
      allowed: false,
      source,
      thread,
      policy,
      reason: 'imported-thread-readonly',
    }
  }

  return {
    allowed: true,
    source,
    thread,
    policy,
    reason: 'allowed',
  }
}

export function canWritebackThreadToSource(
  thread: StorageThreadLike | null | undefined,
  source: StorageSourceLike | null | undefined,
  fallbackPolicy: SourceStoragePolicy = DEFAULT_STORAGE_POLICY,
): boolean {
  return getWritebackDecision(thread, source, fallbackPolicy).allowed
}

function filterSelectableSources<TSource extends StorageSourceLike>(
  sources: readonly TSource[],
  allowDisabled = false,
): TSource[] {
  return allowDisabled ? [...sources] : sources.filter((source) => isSourceEnabled(source))
}

function findSelectableSource<TSource extends StorageSourceLike>(
  sources: readonly TSource[],
  sourceId: string | null | undefined,
  allowDisabled = false,
): TSource | undefined {
  const source = findSourceById(sources, sourceId)
  if (!source) {
    return undefined
  }

  if (!allowDisabled && !isSourceEnabled(source)) {
    return undefined
  }

  return source
}

function resolveAgentParentSourceOverrideMode(
  mode: AgentParentSourceOverrideMode = 'policy-default',
  parentSource: Pick<StorageSourceLike, 'storagePolicy'> | null | undefined,
  fallback: SourceStoragePolicy = DEFAULT_STORAGE_POLICY,
): AgentParentSourceOverrideMode {
  if (mode === 'allow' || mode === 'deny') {
    return mode
  }

  return resolveSourceStoragePolicy(parentSource, fallback) === 'shared'
    ? 'allow'
    : 'deny'
}
