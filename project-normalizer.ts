import { execFileSync } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

export interface ProjectIdentity {
  cwd: string
  defaultName: string
  projectKey: string
}

async function normalizePath(path: string): Promise<string> {
  const resolved = resolve(path)

  try {
    return await realpath(resolved)
  } catch {
    return resolved
  }
}

function resolveGitCommonDir(cwd: string): string | undefined {
  try {
    const output = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim()

    return output || undefined
  } catch {
    return undefined
  }
}

export async function resolveProjectIdentity(cwd: string): Promise<ProjectIdentity> {
  const normalizedCwd = await normalizePath(cwd)
  const commonGitDir = resolveGitCommonDir(normalizedCwd)

  if (commonGitDir) {
    const normalizedCommonGitDir = await normalizePath(commonGitDir)
    const repoRoot = dirname(normalizedCommonGitDir)

    return {
      cwd: repoRoot,
      defaultName: basename(repoRoot) || repoRoot,
      projectKey: `git:${normalizedCommonGitDir}`,
    }
  }

  return {
    cwd: normalizedCwd,
    defaultName: basename(normalizedCwd) || normalizedCwd,
    projectKey: `path:${normalizedCwd}`,
  }
}
