import type { ProjectRecord, ThreadRecord } from '../../../models.js'
import type { RunRecord, RunStatus } from '../../../run-scheduler.js'
import type { RunDisplayStatus } from '../../../session-manager.js'
import type { HistoryReadOptions } from '../../../history-reader.js'

export const LIST_PAGE_SIZE = 10

export type ViewSortMode = 'name' | 'recent'

export function parsePositiveInt(value?: string): number | undefined {
  if (!value || !/^\d+$/.test(value)) {
    return undefined
  }

  const parsed = Number.parseInt(value, 10)
  return parsed > 0 ? parsed : undefined
}

export function parsePaginationArgs(args: string[]): {
  page: number
  pageSize: number
  start: number
  end: number
} {
  const page = parsePositiveInt(args[0]) ?? 1
  const pageSize = parsePositiveInt(args[1]) ?? LIST_PAGE_SIZE
  const start = (page - 1) * pageSize
  const end = start + pageSize

  return { page, pageSize, start, end }
}

export function parseSortToken(value: string | undefined): ViewSortMode | undefined {
  return value === 'name' || value === 'recent' ? value : undefined
}

export function stripSortArg(args: string[]): { args: string[]; sort: ViewSortMode } {
  const tokens = [...args]
  let sort: ViewSortMode = 'recent'

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== '--sort') {
      continue
    }

    const parsed = parseSortToken(tokens[index + 1])
    if (parsed) {
      sort = parsed
      tokens.splice(index, 2)
    } else {
      tokens.splice(index, 1)
    }
    break
  }

  return { args: tokens, sort }
}

export function parseListControls(args: string[]): {
  page: number
  pageSize: number
  start: number
  end: number
  sort: ViewSortMode
} {
  const stripped = stripSortArg(args)
  return {
    ...parsePaginationArgs(stripped.args),
    sort: stripped.sort,
  }
}

export function parseSearchPaginationArgs(args: string[]): {
  query: string
  page: number
  pageSize: number
  start: number
  end: number
  sort: ViewSortMode
} {
  const stripped = stripSortArg(args)
  let page: number | undefined
  let pageSize: number | undefined
  let queryTokens = [...stripped.args]

  if (queryTokens.length >= 2) {
    const maybePage = parsePositiveInt(queryTokens.at(-2))
    const maybePageSize = parsePositiveInt(queryTokens.at(-1))
    if (maybePage && maybePageSize) {
      page = maybePage
      pageSize = maybePageSize
      queryTokens = queryTokens.slice(0, -2)
    }
  }

  if (!page && queryTokens.length >= 1) {
    const maybePage = parsePositiveInt(queryTokens.at(-1))
    if (maybePage) {
      page = maybePage
      queryTokens = queryTokens.slice(0, -1)
    }
  }

  const pagination = parsePaginationArgs([
    page ? String(page) : '',
    pageSize ? String(pageSize) : '',
  ])

  return {
    query: queryTokens.join(' ').trim(),
    ...pagination,
    sort: stripped.sort,
  }
}

export function resolveIndexedItemIndex<T>(
  items: T[],
  reference: string,
  getAliases: (item: T) => string[],
): number {
  const normalizedReference = reference.trim()
  if (!normalizedReference) {
    return -1
  }

  if (/^\d+$/.test(normalizedReference)) {
    const index = Number.parseInt(normalizedReference, 10) - 1
    return index >= 0 && index < items.length ? index : -1
  }

  return items.findIndex((item) =>
    getAliases(item).some((alias) => alias === normalizedReference),
  )
}

export function isRunStatus(value: string | undefined): value is RunStatus {
  return value === 'queued' ||
    value === 'running' ||
    value === 'cancelled' ||
    value === 'failed' ||
    value === 'completed'
}

export function isRunDisplayStatus(
  value: string | undefined,
): value is RunDisplayStatus {
  return value === 'waiting_approval' || isRunStatus(value)
}

export function parseRunListArgs(args: string[]): {
  status?: string
  page: number
  pageSize: number
  start: number
  end: number
} {
  const [first, ...rest] = args
  const status = isRunDisplayStatus(first) ? first : undefined
  const pagination = parsePaginationArgs(status ? rest : args)

  return {
    status,
    ...pagination,
  }
}

export function parseRunSearchArgs(args: string[]): {
  query: string
  status?: string
  page: number
  pageSize: number
  start: number
  end: number
} {
  let page: number | undefined
  let pageSize: number | undefined
  let status: string | undefined
  let tokens = [...args]

  if (tokens.length >= 2) {
    const maybePage = parsePositiveInt(tokens.at(-2))
    const maybePageSize = parsePositiveInt(tokens.at(-1))
    if (maybePage && maybePageSize) {
      page = maybePage
      pageSize = maybePageSize
      tokens = tokens.slice(0, -2)
    }
  }

  if (!page && tokens.length >= 1) {
    const maybePage = parsePositiveInt(tokens.at(-1))
    if (maybePage) {
      page = maybePage
      tokens = tokens.slice(0, -1)
    }
  }

  if (tokens.length >= 2) {
    const maybeStatus = tokens.at(-1)
    if (isRunDisplayStatus(maybeStatus)) {
      status = maybeStatus
      tokens = tokens.slice(0, -1)
    }
  }

  const pagination = parsePaginationArgs([
    page ? String(page) : '',
    pageSize ? String(pageSize) : '',
  ])

  return {
    query: tokens.join(' ').trim(),
    status,
    ...pagination,
  }
}

export function parseThreadHistoryArgs(
  args: string[],
): HistoryReadOptions {
  const options: HistoryReadOptions = {}
  let index = 0

  if (args[0] && /^\d+$/.test(args[0])) {
    options.limit = Number.parseInt(args[0], 10)
    index = 1
  }

  while (index < args.length) {
    const token = args[index]

    if (token === '--tools') {
      options.includeTools = true
      index += 1
      continue
    }

    if (token === '--agents') {
      options.includeAgentMessages = true
      index += 1
      continue
    }

    if (token === '--cursor' && args[index + 1]) {
      options.cursor = args[index + 1]
      index += 2
      continue
    }

    if (token === '--turn' && args[index + 1] && /^\d+$/.test(args[index + 1])) {
      options.turn = Number.parseInt(args[index + 1], 10)
      index += 2
      continue
    }

    if (token === '--since' && args[index + 1]) {
      options.since = args[index + 1]
      index += 2
      continue
    }

    if (token === '--until' && args[index + 1]) {
      options.until = args[index + 1]
      index += 2
      continue
    }

    index += 1
  }

  return options
}

export function sortProjectsForView(
  projects: ProjectRecord[],
  sort: ViewSortMode,
): ProjectRecord[] {
  return [...projects].sort((left, right) => {
    if (sort === 'name') {
      return (
        left.name.localeCompare(right.name) ||
        left.cwd.localeCompare(right.cwd) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id)
      )
    }

    return (
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.name.localeCompare(right.name) ||
      left.cwd.localeCompare(right.cwd) ||
      left.id.localeCompare(right.id)
    )
  })
}

export function sortThreadsForView(
  threads: ThreadRecord[],
  sort: ViewSortMode,
): ThreadRecord[] {
  return [...threads].sort((left, right) => {
    if (sort === 'name') {
      return (
        left.title.localeCompare(right.title) ||
        left.cwd.localeCompare(right.cwd) ||
        (left.codexThreadId ?? left.id).localeCompare(right.codexThreadId ?? right.id)
      )
    }

    return (
      (right.pinnedAt ?? '').localeCompare(left.pinnedAt ?? '') ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.title.localeCompare(right.title) ||
      (left.codexThreadId ?? left.id).localeCompare(right.codexThreadId ?? right.id)
    )
  })
}
