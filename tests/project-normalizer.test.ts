import { describe, it, expect } from 'vitest'
import { resolveProjectIdentity } from '../project-normalizer.js'
import { tmpdir } from 'node:os'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

describe('resolveProjectIdentity', () => {
  it('resolves a normal directory path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pn-test-'))
    try {
      const identity = await resolveProjectIdentity(dir)
      expect(identity.cwd).toBeTruthy()
      expect(identity.defaultName).toBeTruthy()
      expect(identity.projectKey).toMatch(/^(git:|path:)/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves a git repository root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pn-git-'))
    try {
      execFileSync('git', ['init', dir], { stdio: 'ignore' })
      const identity = await resolveProjectIdentity(dir)
      expect(identity.projectKey).toMatch(/^git:/)
      // cwd should be the repo root
      expect(identity.cwd).toBeTruthy()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves a non-existent path gracefully', async () => {
    const fakePath = join(tmpdir(), 'does-not-exist-' + Date.now())
    const identity = await resolveProjectIdentity(fakePath)
    // Should still return a result using the resolved path
    expect(identity.cwd).toBeTruthy()
    expect(identity.defaultName).toBeTruthy()
    expect(identity.projectKey).toMatch(/^path:/)
  })

  it('resolves a subdirectory inside a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pn-sub-'))
    const sub = join(dir, 'nested', 'deep')
    try {
      execFileSync('git', ['init', dir], { stdio: 'ignore' })
      mkdirSync(sub, { recursive: true })
      const identity = await resolveProjectIdentity(sub)
      // Should resolve to the git root, not the subdirectory
      expect(identity.projectKey).toMatch(/^git:/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
