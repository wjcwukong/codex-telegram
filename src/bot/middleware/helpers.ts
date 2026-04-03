export function detectSlashlessCommand(text: string): string | undefined {
  const normalized = text.trim()
  if (!normalized || normalized.startsWith('/')) {
    return undefined
  }

  const candidates = [
    'start',
    'help',
    'pair',
    'new',
    'cwd',
    'kill',
    'cancel',
    'undo',
    'source',
    'agent',
    'project',
    'thread',
    'screenshot',
    'ss',
    'unlock',
    'wake',
    'windows',
  ]

  for (const command of candidates) {
    if (
      normalized === command ||
      normalized.startsWith(`${command} `)
    ) {
      return normalized
    }
  }

  return undefined
}
