import { describe, it, expect } from 'vitest'
import {
  isStoragePolicy,
  parseStoragePolicy,
  isSharedStoragePolicy,
  isIsolatedStoragePolicy,
  selectThreadSource,
  selectAgentSource,
  canWritebackThreadToSource,
  getImportDecision,
  canImportFromSource,
  getWritebackDecision,
  getAgentSourceOverrideDecision,
  type StorageSourceLike,
  type ThreadSourceSelectionInput,
  type AgentSourceSelectionInput,
} from '../storage-policy.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSource(
  overrides: Partial<StorageSourceLike> & { id: string },
): StorageSourceLike {
  return {
    enabled: true,
    importEnabled: true,
    storagePolicy: 'shared',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// isStoragePolicy
// ---------------------------------------------------------------------------

describe('isStoragePolicy', () => {
  it('returns true for "shared"', () => {
    expect(isStoragePolicy('shared')).toBe(true)
  })

  it('returns true for "isolated"', () => {
    expect(isStoragePolicy('isolated')).toBe(true)
  })

  it('returns false for other strings', () => {
    expect(isStoragePolicy('foo')).toBe(false)
    expect(isStoragePolicy('')).toBe(false)
  })

  it('returns false for non-string values', () => {
    expect(isStoragePolicy(null)).toBe(false)
    expect(isStoragePolicy(undefined)).toBe(false)
    expect(isStoragePolicy(42)).toBe(false)
    expect(isStoragePolicy(true)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseStoragePolicy
// ---------------------------------------------------------------------------

describe('parseStoragePolicy', () => {
  it('returns the value when valid', () => {
    expect(parseStoragePolicy('shared')).toBe('shared')
    expect(parseStoragePolicy('isolated')).toBe('isolated')
  })

  it('returns default fallback "shared" for invalid input', () => {
    expect(parseStoragePolicy('nope')).toBe('shared')
    expect(parseStoragePolicy(null)).toBe('shared')
    expect(parseStoragePolicy(undefined)).toBe('shared')
  })

  it('returns custom fallback for invalid input', () => {
    expect(parseStoragePolicy('nope', 'isolated')).toBe('isolated')
  })
})

// ---------------------------------------------------------------------------
// isSharedStoragePolicy / isIsolatedStoragePolicy
// ---------------------------------------------------------------------------

describe('isSharedStoragePolicy', () => {
  it('returns true for "shared"', () => {
    expect(isSharedStoragePolicy('shared')).toBe(true)
  })

  it('returns true for invalid values (default is shared)', () => {
    expect(isSharedStoragePolicy(null)).toBe(true)
    expect(isSharedStoragePolicy(undefined)).toBe(true)
  })

  it('returns false for "isolated"', () => {
    expect(isSharedStoragePolicy('isolated')).toBe(false)
  })
})

describe('isIsolatedStoragePolicy', () => {
  it('returns true for "isolated"', () => {
    expect(isIsolatedStoragePolicy('isolated')).toBe(true)
  })

  it('returns false for "shared"', () => {
    expect(isIsolatedStoragePolicy('shared')).toBe(false)
  })

  it('returns false for invalid values (default is shared)', () => {
    expect(isIsolatedStoragePolicy(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// selectThreadSource
// ---------------------------------------------------------------------------

describe('selectThreadSource', () => {
  const srcA = makeSource({ id: 'a', storagePolicy: 'shared' })
  const srcB = makeSource({ id: 'b', storagePolicy: 'isolated' })
  const srcDisabled = makeSource({ id: 'dis', enabled: false })

  it('selects explicit preferred source', () => {
    const result = selectThreadSource({
      sources: [srcA, srcB],
      preferredSourceId: 'b',
    })
    expect(result.source).toEqual(srcB)
    expect(result.reason).toBe('explicit-source')
  })

  it('selects project default source', () => {
    const result = selectThreadSource({
      sources: [srcA, srcB],
      projectDefaultSourceId: 'a',
    })
    expect(result.source).toEqual(srcA)
    expect(result.reason).toBe('project-default')
  })

  it('selects policy-matching source when desired', () => {
    const result = selectThreadSource({
      sources: [srcA, srcB],
      desiredPolicy: 'isolated',
    })
    expect(result.source).toEqual(srcB)
    expect(result.reason).toBe('policy-match')
    expect(result.policy).toBe('isolated')
  })

  it('selects first-available when no better match', () => {
    const result = selectThreadSource({
      sources: [srcA],
      desiredPolicy: 'isolated',
    })
    expect(result.source).toEqual(srcA)
    expect(result.reason).toBe('first-available')
  })

  it('returns unavailable when sources are empty', () => {
    const result = selectThreadSource({ sources: [] })
    expect(result.source).toBeUndefined()
    expect(result.reason).toBe('unavailable')
  })

  it('skips disabled sources unless allowDisabled', () => {
    const result = selectThreadSource({
      sources: [srcDisabled],
      preferredSourceId: 'dis',
    })
    expect(result.source).toBeUndefined()
    expect(result.reason).toBe('unavailable')

    const result2 = selectThreadSource({
      sources: [srcDisabled],
      preferredSourceId: 'dis',
      allowDisabled: true,
    })
    expect(result2.source).toEqual(srcDisabled)
    expect(result2.reason).toBe('explicit-source')
  })

  it('forces project default when source is isolated', () => {
    const result = selectThreadSource({
      sources: [srcA, srcB],
      projectDefaultSourceId: 'b',
      preferredSourceId: 'a',
    })
    // isolated project default is forced, so preferred source is overridden
    expect(result.source).toEqual(srcB)
    expect(result.reason).toBe('project-default')
    expect(result.forced).toBe(true)
  })

  it('forces project default with explicit force mode', () => {
    const result = selectThreadSource({
      sources: [srcA, srcB],
      projectDefaultSourceId: 'a',
      preferredSourceId: 'b',
      projectSourceMode: 'force',
    })
    expect(result.source).toEqual(srcA)
    expect(result.reason).toBe('project-default')
    expect(result.forced).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// selectAgentSource
// ---------------------------------------------------------------------------

describe('selectAgentSource', () => {
  const srcA = makeSource({ id: 'a', storagePolicy: 'shared' })
  const srcB = makeSource({ id: 'b', storagePolicy: 'isolated' })

  it('inherits parent thread source when no preference', () => {
    const result = selectAgentSource({
      sources: [srcA, srcB],
      parentThreadSourceId: 'a',
    })
    expect(result.source).toEqual(srcA)
    expect(result.reason).toBe('parent-thread-source')
  })

  it('allows override when parent source is shared', () => {
    const result = selectAgentSource({
      sources: [srcA, srcB],
      preferredSourceId: 'b',
      parentThreadSourceId: 'a',
    })
    expect(result.source).toEqual(srcB)
    expect(result.reason).toBe('explicit-source')
  })

  it('denies override when parent source is isolated (policy-default)', () => {
    const result = selectAgentSource({
      sources: [srcA, srcB],
      preferredSourceId: 'a',
      parentThreadSourceId: 'b',
    })
    expect(result.source).toEqual(srcB)
    expect(result.reason).toBe('parent-thread-source')
    expect(result.forced).toBe(true)
  })

  it('falls back to thread selection when no parent source', () => {
    const result = selectAgentSource({
      sources: [srcA, srcB],
    })
    expect(result.source).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// getAgentSourceOverrideDecision
// ---------------------------------------------------------------------------

describe('getAgentSourceOverrideDecision', () => {
  const srcA = makeSource({ id: 'a', storagePolicy: 'shared' })
  const srcB = makeSource({ id: 'b', storagePolicy: 'isolated' })

  it('allows when no override requested', () => {
    const decision = getAgentSourceOverrideDecision({
      sources: [srcA],
      parentThreadSourceId: 'a',
    })
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('no-override-requested')
  })

  it('allows same-source override', () => {
    const decision = getAgentSourceOverrideDecision({
      sources: [srcA],
      preferredSourceId: 'a',
      parentThreadSourceId: 'a',
    })
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('same-source')
  })

  it('denies override when parent source is isolated', () => {
    const decision = getAgentSourceOverrideDecision({
      sources: [srcA, srcB],
      preferredSourceId: 'a',
      parentThreadSourceId: 'b',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('parent-source-forced')
  })

  it('allows override when explicitly set to allow', () => {
    const decision = getAgentSourceOverrideDecision({
      sources: [srcA, srcB],
      preferredSourceId: 'a',
      parentThreadSourceId: 'b',
      parentSourceOverrideMode: 'allow',
    })
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('override-allowed')
  })
})

// ---------------------------------------------------------------------------
// canWritebackThreadToSource / getWritebackDecision
// ---------------------------------------------------------------------------

describe('canWritebackThreadToSource', () => {
  const src = makeSource({ id: 's1' })
  const thread = { sourceId: 's1', origin: 'telegram' as const }
  const importedThread = { sourceId: 's1', origin: 'imported' as const }

  it('allows writeback for normal thread with matching source', () => {
    expect(canWritebackThreadToSource(thread, src)).toBe(true)
  })

  it('disallows writeback when thread is null', () => {
    expect(canWritebackThreadToSource(null, src)).toBe(false)
  })

  it('disallows writeback when source is null', () => {
    expect(canWritebackThreadToSource(thread, null)).toBe(false)
  })

  it('allows writeback for imported thread on shared source', () => {
    expect(canWritebackThreadToSource(importedThread, src)).toBe(true)
  })

  it('allows writeback for imported thread on isolated source', () => {
    const isolatedSrc = makeSource({ id: 's1', storagePolicy: 'isolated' })
    expect(canWritebackThreadToSource(importedThread, isolatedSrc)).toBe(true)
  })

  it('disallows writeback when source is disabled', () => {
    const disabledSrc = makeSource({ id: 's1', enabled: false })
    expect(canWritebackThreadToSource(thread, disabledSrc)).toBe(false)
  })

  it('disallows writeback when thread sourceId does not match source', () => {
    const mismatchThread = { sourceId: 'other', origin: 'telegram' as const }
    expect(canWritebackThreadToSource(mismatchThread, src)).toBe(false)
  })
})

describe('getWritebackDecision', () => {
  const src = makeSource({ id: 's1' })
  const thread = { sourceId: 's1', origin: 'telegram' as const }

  it('returns allowed for valid thread+source', () => {
    const decision = getWritebackDecision(thread, src)
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('allowed')
  })

  it('returns thread-missing when thread is null', () => {
    const decision = getWritebackDecision(null, src)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('thread-missing')
  })

  it('returns source-missing when source is null', () => {
    const decision = getWritebackDecision(thread, null)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('source-missing')
  })

  it('returns source-disabled for disabled source', () => {
    const disabledSrc = makeSource({ id: 's1', enabled: false })
    const decision = getWritebackDecision(thread, disabledSrc)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('source-disabled')
  })

  it('returns thread-source-mismatch', () => {
    const otherThread = { sourceId: 'other', origin: 'telegram' as const }
    const decision = getWritebackDecision(otherThread, src)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('thread-source-mismatch')
  })

  it('allows imported thread on shared source (bot shares codex home)', () => {
    const importedThread = { sourceId: 's1', origin: 'imported' as const }
    const decision = getWritebackDecision(importedThread, src)
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('allowed')
  })
})

// ---------------------------------------------------------------------------
// getImportDecision / canImportFromSource
// ---------------------------------------------------------------------------

describe('getImportDecision', () => {
  it('allows import for enabled source with import enabled', () => {
    const src = makeSource({ id: 's1' })
    const decision = getImportDecision(src)
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('allowed')
  })

  it('disallows when source is null', () => {
    const decision = getImportDecision(null)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('source-missing')
  })

  it('disallows when source is undefined', () => {
    const decision = getImportDecision(undefined)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('source-missing')
  })

  it('disallows when source is disabled', () => {
    const src = makeSource({ id: 's1', enabled: false })
    const decision = getImportDecision(src)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('source-disabled')
  })

  it('disallows when import is disabled', () => {
    const src = makeSource({ id: 's1', importEnabled: false })
    const decision = getImportDecision(src)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('import-disabled')
  })
})

describe('canImportFromSource', () => {
  it('returns true for enabled source', () => {
    expect(canImportFromSource(makeSource({ id: 's1' }))).toBe(true)
  })

  it('returns false for null', () => {
    expect(canImportFromSource(null)).toBe(false)
  })

  it('returns false for disabled source', () => {
    expect(canImportFromSource(makeSource({ id: 's1', enabled: false }))).toBe(false)
  })
})
