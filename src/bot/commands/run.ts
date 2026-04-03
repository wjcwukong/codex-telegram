import { Composer, type Context } from 'grammy'
import { InlineKeyboard } from 'grammy'

import type { SessionManager } from '../../../session-manager.js'
import type { RunDisplayStatus } from '../../../session-manager.js'
import {
  LIST_PAGE_SIZE,
  parsePositiveInt,
  parseRunListArgs,
  parseRunSearchArgs,
  isRunDisplayStatus,
} from '../views/pagination.js'
import { renderSections } from '../views/sections.js'
import {
  highlightSearchText,
  formatTimestamp,
  formatStatusCounts,
  countItemsByKey,
  buildRunIssueLines,
  buildRunActionHints,
  buildRunListIssueSummary,
  type GetRunDisplayStatus,
} from '../views/formatting.js'
import {
  buildMenuKeyboard,
  buildListKeyboard,
  buildActionKeyboard,
  buildConfirmKeyboard,
  truncateLabel,
} from '../views/keyboards.js'
import { ensureAuthorized, getUserId, getChatId } from '../middleware/auth.js'
import { RUN } from '../i18n/zh.js'

export function createRunCommands(
  sessionManager: SessionManager,
  getRunDisplayStatus: GetRunDisplayStatus,
  router?: import('../callbacks/router.js').CallbackRouter,
): Composer<Context> {
  const composer = new Composer<Context>()

  composer.command('run', async (ctx) => {
    if (!(await ensureAuthorized(ctx))) {
      return
    }

    const args = ctx.message?.text?.trim().split(/\s+/).slice(1) ?? []
    const action = args[0]?.toLowerCase()
    const userId = getUserId(ctx)
    const chatId = getChatId(ctx)

    if (!action) {
      await ctx.reply('🏃 Run 管理', {
        reply_markup: buildRunMenuKeyboard(),
      })
      return
    }

    if (action === 'show') {
      await handleShow(ctx, args, sessionManager, getRunDisplayStatus)
      return
    }

    if (action === 'cancel') {
      await handleCancel(ctx, args, sessionManager)
      return
    }

    if (action === 'retry') {
      await handleRetry(ctx, args, sessionManager, getRunDisplayStatus)
      return
    }

    if (action === 'where') {
      await handleWhere(ctx, args, userId, chatId, sessionManager)
      return
    }

    if (action === 'search') {
      await handleSearchRuns(ctx, args, userId, chatId, sessionManager, getRunDisplayStatus)
      return
    }

    await handleListRuns(ctx, args, action, userId, chatId, sessionManager, getRunDisplayStatus)
  })

  router?.register('r', async (ctx, parts) => {
    await handleRunCallback(ctx, parts, sessionManager, getRunDisplayStatus)
  })

  return composer
}

async function handleShow(
  ctx: Context,
  args: string[],
  sessionManager: SessionManager,
  getRunDisplayStatus: GetRunDisplayStatus,
): Promise<void> {
  const runId = args[1]?.trim()

  if (!runId) {
    await ctx.reply(RUN.SHOW_USAGE)
    return
  }

  const run = await sessionManager.getRunDetails(runId)
  if (!run) {
    await ctx.reply(RUN.NOT_FOUND(runId))
    return
  }

  await ctx.reply(renderSections([
    {
      title: 'Identity',
      lines: [
        `run: ${run.context.runId}`,
        `project: ${run.context.projectId}`,
        `thread: ${run.context.threadId}`,
        run.context.agentId ? `agent: ${run.context.agentId}` : undefined,
        run.context.label ? `label: ${run.context.label}` : undefined,
      ],
    },
    {
      title: 'Status',
      lines: [
        `status: ${getRunDisplayStatus(run)}`,
        `queued: ${formatTimestamp(run.queuedAt)}`,
        run.startedAt ? `started: ${formatTimestamp(run.startedAt)}` : undefined,
        run.finishedAt ? `finished: ${formatTimestamp(run.finishedAt)}` : undefined,
        run.retryOfRunId ? `retryOf: ${run.retryOfRunId}` : undefined,
        run.retryable ? 'retryable: yes' : 'retryable: no',
        run.cancelReason ? `cancelReason: ${run.cancelReason}` : undefined,
        run.error ? `error: ${run.error}` : undefined,
      ],
    },
    {
      title: 'Top Issues',
      lines: buildRunIssueLines(run, getRunDisplayStatus),
    },
    {
      title: 'Links',
      lines: [
        `project use: /project use ${run.context.projectId}`,
        `thread use: /thread use ${run.context.threadId}`,
        run.context.agentId ? `agent show: /agent show ${run.context.agentId}` : undefined,
      ],
    },
    {
      title: 'Actions',
      lines: [
        `jump: /run where ${run.context.runId}`,
        ...buildRunActionHints(run, getRunDisplayStatus),
        `next: /project use ${run.context.projectId}`,
        `next: /thread use ${run.context.threadId}`,
        run.context.agentId ? `next: /agent show ${run.context.agentId}` : undefined,
      ],
    },
  ]))
}

async function handleCancel(
  ctx: Context,
  args: string[],
  sessionManager: SessionManager,
): Promise<void> {
  const runId = args[1]?.trim()

  if (!runId) {
    await ctx.reply(RUN.CANCEL_USAGE)
    return
  }

  const cancelled = await sessionManager.cancelRun(runId)
  await ctx.reply(cancelled ? RUN.CANCELLED(runId) : RUN.CANCEL_UNABLE(runId))
}

async function handleRetry(
  ctx: Context,
  args: string[],
  sessionManager: SessionManager,
  getRunDisplayStatus: GetRunDisplayStatus,
): Promise<void> {
  const runId = args[1]?.trim()

  if (!runId) {
    await ctx.reply(RUN.RETRY_USAGE)
    return
  }

  try {
    const run = await sessionManager.retryRun(runId)
    await ctx.reply(
      [
        RUN.RETRIED(runId),
        `new run: ${run.context.runId}`,
        `status: ${getRunDisplayStatus(run)}`,
        `thread: ${run.context.threadId}`,
      ].join('\n'),
    )
  } catch (error) {
    await ctx.reply(RUN.RETRY_FAIL((error as Error).message))
  }
}

async function handleWhere(
  ctx: Context,
  args: string[],
  userId: string,
  chatId: string,
  sessionManager: SessionManager,
): Promise<void> {
  const runId = args[1]?.trim()
  const pageSize = parsePositiveInt(args[2]) ?? LIST_PAGE_SIZE
  if (!runId) {
    await ctx.reply(RUN.WHERE_USAGE)
    return
  }

  const state = await sessionManager.getRunState(userId, chatId)
  const index = state.runs.findIndex((run) => run.context.runId === runId)
  if (index < 0) {
    await ctx.reply(RUN.NOT_FOUND(runId))
    return
  }

  const page = Math.floor(index / pageSize) + 1
  await ctx.reply(
    [
      `run: ${runId}`,
      `index: #${index + 1}/${state.runs.length}`,
      `page: ${page}`,
      `pageSize: ${pageSize}`,
      `jump: /run list ${page} ${pageSize}`,
    ].join('\n'),
  )
}

async function handleSearchRuns(
  ctx: Context,
  args: string[],
  userId: string,
  chatId: string,
  sessionManager: SessionManager,
  getRunDisplayStatus: GetRunDisplayStatus,
): Promise<void> {
  const {
    status: statusFilter,
    page,
    pageSize,
    start,
    end,
    query,
  } = parseRunSearchArgs(args.slice(1))
  if (!query) {
    await ctx.reply(RUN.SEARCH_USAGE)
    return
  }

  const state = await sessionManager.searchRuns(userId, chatId, query, {
    status: isRunDisplayStatus(statusFilter) ? statusFilter : undefined,
  })
  const runs = state.runs.slice(start, end)
  const total = state.runs.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const hasPrev = start > 0
  const hasNext = end < total

  if (total === 0) {
    await ctx.reply(RUN.NO_MATCH(query))
    return
  }

  await ctx.reply(renderSections([
    {
      title: 'Scope',
      lines: [
        `run search: ${query}`,
        `project: ${state.project?.name ?? '-'}`,
        `thread: ${state.thread?.title ?? '-'}`,
        statusFilter ? `status: ${statusFilter}` : 'status: all',
        `page ${page}/${totalPages}, pageSize ${pageSize}`,
        `total: ${total}`,
        `status counts: ${formatStatusCounts(countItemsByKey(state.runs, (run) => getRunDisplayStatus(run)))}`,
      ],
    },
    {
      title: 'Top Issues',
      lines: buildRunListIssueSummary(state.runs, getRunDisplayStatus),
    },
    {
      title: 'Actions',
      lines: [
        hasPrev
          ? `prev: /run search ${query}${statusFilter ? ` ${statusFilter}` : ''} ${Math.max(1, page - 1)} ${pageSize}`
          : undefined,
        hasNext
          ? `next: /run search ${query}${statusFilter ? ` ${statusFilter}` : ''} ${page + 1} ${pageSize}`
          : undefined,
      ],
    },
    {
      title: 'Results',
      lines: runs.map(
        (run, index) =>
          `${start + index + 1}. [${getRunDisplayStatus(run)}] ${highlightSearchText(run.context.runId, query)}\nthread: ${highlightSearchText(run.context.threadId, query)}${run.context.agentId ? `\nagent: ${highlightSearchText(run.context.agentId, query)}` : ''}${run.retryOfRunId ? `\nretryOf: ${highlightSearchText(run.retryOfRunId, query)}` : ''}\nqueued: ${formatTimestamp(run.queuedAt)}`,
      ),
    },
  ]))
}

async function handleListRuns(
  ctx: Context,
  args: string[],
  action: string,
  userId: string,
  chatId: string,
  sessionManager: SessionManager,
  getRunDisplayStatus: GetRunDisplayStatus,
): Promise<void> {
  const {
    status: statusFilter,
    page,
    pageSize,
    start,
    end,
  } = parseRunListArgs(action === 'list' ? args.slice(1) : args)
  const state = await sessionManager.getRunState(userId, chatId, {
    status: isRunDisplayStatus(statusFilter) ? statusFilter : undefined,
  })
  const runs = state.runs.slice(start, end)
  const total = state.runs.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const hasPrev = start > 0
  const hasNext = end < total

  if (state.runs.length === 0) {
    await ctx.reply(RUN.NO_RUNS)
    return
  }

  await ctx.reply(renderSections([
    {
      title: 'Scope',
      lines: [
        `project: ${state.project?.name ?? '-'}`,
        `thread: ${state.thread?.title ?? '-'}`,
        statusFilter ? `status: ${statusFilter}` : 'status: all',
        `page ${page}/${totalPages}, pageSize ${pageSize}`,
        `total: ${total}`,
        `status counts: ${formatStatusCounts(countItemsByKey(state.runs, (run) => getRunDisplayStatus(run)))}`,
      ],
    },
    {
      title: 'Top Issues',
      lines: buildRunListIssueSummary(state.runs, getRunDisplayStatus),
    },
    {
      title: 'Actions',
      lines: [
        hasPrev
          ? `prev: /run list${statusFilter ? ` ${statusFilter}` : ''} ${Math.max(1, page - 1)} ${pageSize}`
          : undefined,
        hasNext
          ? `next: /run list${statusFilter ? ` ${statusFilter}` : ''} ${page + 1} ${pageSize}`
          : undefined,
      ],
    },
    {
      title: 'Results',
      lines: runs.map(
        (run, index) =>
          `${start + index + 1}. [${getRunDisplayStatus(run)}] ${run.context.runId}\nthread: ${run.context.threadId}${run.context.agentId ? `\nagent: ${run.context.agentId}` : ''}${run.retryOfRunId ? `\nretryOf: ${run.retryOfRunId}` : ''}\nqueued: ${formatTimestamp(run.queuedAt)}`,
      ),
    },
  ]))
}

// ---------------------------------------------------------------------------
// Inline keyboard helpers
// ---------------------------------------------------------------------------

const RUN_STATUS_EMOJI: Record<string, string> = {
  completed: '✅',
  running: '🔵',
  queued: '🟡',
  failed: '🔴',
  cancelled: '⚪',
  waiting_approval: '🟠',
}

function runStatusEmoji(status: string): string {
  return RUN_STATUS_EMOJI[status] ?? '⚪'
}

function shortRunId(id: string): string {
  return id.slice(0, 16)
}

const STATUS_FILTERS: Array<{
  label: string
  filter: string
}> = [
  { label: '📋 全部', filter: 'all' },
  { label: '🟡 排队中', filter: 'queued' },
  { label: '🔵 运行中', filter: 'running' },
  { label: '🔴 失败', filter: 'failed' },
  { label: '✅ 已完成', filter: 'completed' },
  { label: '⚪ 已取消', filter: 'cancelled' },
]

const STATUS_FILTER_SHORT: Record<string, string> = {
  all: '全部',
  queued: '排队',
  running: '运行中',
  failed: '失败',
  completed: '完成',
  cancelled: '取消',
}

function buildRunMenuKeyboard(): InlineKeyboard {
  const items = STATUS_FILTERS.map((sf) => ({
    label: sf.label,
    data: `r:list:1:${sf.filter}`,
  }))
  items.push({ label: '🔙 主菜单', data: 'g:menu' })
  return buildMenuKeyboard(items)
}

function buildRunListKeyboard(
  runs: Array<{ context: { runId: string; threadId: string }; status: string }>,
  page: number,
  totalPages: number,
  currentFilter: string,
  getStatus: GetRunDisplayStatus,
): InlineKeyboard {
  const items = runs.map((run) => ({
    label: `${runStatusEmoji(getStatus(run as never))} ${run.context.runId.slice(0, 20)} — ${run.context.threadId.slice(0, 20)}`,
    data: `r:show:${shortRunId(run.context.runId)}`,
  }))
  const kb = buildListKeyboard(items, page, totalPages, `r:list`)

  // Status filter toggle row
  const filterRow: Array<{ label: string; data: string }> = STATUS_FILTERS.map((sf) => ({
    label: sf.filter === currentFilter
      ? `[${STATUS_FILTER_SHORT[sf.filter]}]`
      : STATUS_FILTER_SHORT[sf.filter] ?? sf.filter,
    data: `r:list:1:${sf.filter}`,
  }))
  for (let i = 0; i < filterRow.length; i++) {
    kb.text(truncateLabel(filterRow[i].label, 8), filterRow[i].data)
  }
  kb.row()

  kb.text('🔙 返回', 'r:menu').row()
  return kb
}

function buildRunDetailKeyboard(
  runId: string,
  status: string,
  retryable: boolean,
): InlineKeyboard {
  const actions: Array<{ label: string; data: string }> = []
  const sid = shortRunId(runId)
  if (status === 'queued' || status === 'running') {
    actions.push({ label: '❌ Cancel', data: `r:cancel:${sid}` })
  }
  if ((status === 'failed' || status === 'cancelled') && retryable) {
    actions.push({ label: '🔄 Retry', data: `r:retry:${sid}` })
  }
  const kb = buildActionKeyboard(actions)
  kb.text('🔙 返回列表', 'r:list:1:all').row()
  return kb
}

function renderRunDetailText(
  run: NonNullable<Awaited<ReturnType<SessionManager['getRunDetails']>>>,
  getStatus: GetRunDisplayStatus,
): string {
  return renderSections([
    {
      title: 'Identity',
      lines: [
        `id: ${run.context.runId}`,
        `thread: ${run.context.threadId}`,
        run.context.agentId ? `agent: ${run.context.agentId}` : undefined,
        run.context.label ? `label: ${run.context.label}` : undefined,
      ],
    },
    {
      title: 'Status',
      lines: [
        `status: ${getStatus(run)}`,
        run.startedAt ? `started: ${formatTimestamp(run.startedAt)}` : undefined,
        run.finishedAt ? `finished: ${formatTimestamp(run.finishedAt)}` : undefined,
        run.error ? `error: ${run.error}` : undefined,
      ],
    },
  ])
}

// ---------------------------------------------------------------------------
// Callback handler
// ---------------------------------------------------------------------------

async function safeEditRun(
  ctx: Context,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  try {
    await ctx.editMessageText(text, {
      reply_markup: keyboard,
    })
  } catch (error: unknown) {
    const msg = (error as Error).message ?? ''
    if (!msg.includes('message is not modified')) throw error
  }
}

async function handleRunCallback(
  ctx: Context,
  parts: string[],
  sessionManager: SessionManager,
  getRunDisplayStatus: GetRunDisplayStatus,
): Promise<void> {
  const action = parts[0]
  const userId = getUserId(ctx)
  const chatId = getChatId(ctx)

  // r:menu — show run management menu
  if (action === 'menu') {
    await safeEditRun(ctx, '🏃 Run 管理', buildRunMenuKeyboard())
    return
  }

  // r:list:PAGE:FILTER — paginated run list
  if (action === 'list') {
    const page = parsePositiveInt(parts[1]) ?? 1
    const filter = parts[2] ?? 'all'
    const statusFilter = isRunDisplayStatus(filter) ? filter : undefined
    const state = await sessionManager.getRunState(userId, chatId, {
      status: statusFilter,
    })

    if (state.runs.length === 0) {
      await safeEditRun(
        ctx,
        RUN.NO_RUNS,
        buildMenuKeyboard([{ label: '🔙 返回', data: 'r:menu' }]),
      )
      return
    }

    const total = state.runs.length
    const pageSize = LIST_PAGE_SIZE
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const safePage = Math.min(page, totalPages)
    const start = (safePage - 1) * pageSize
    const pageRuns = state.runs.slice(start, start + pageSize)

    const filterLabel = filter === 'all' ? '' : ` — ${STATUS_FILTER_SHORT[filter] ?? filter}`
    const text = `🏃 Runs${filterLabel} (page ${safePage}/${totalPages})`
    const kb = buildRunListKeyboard(
      pageRuns.map((run) => ({
        context: run.context,
        status: getRunDisplayStatus(run),
      })),
      safePage,
      totalPages,
      filter,
      getRunDisplayStatus,
    )
    await safeEditRun(ctx, text, kb)
    return
  }

  // r:show:ID — run detail view
  if (action === 'show') {
    const ref = parts[1]
    if (!ref) return
    const run = await sessionManager.getRunDetails(ref)
    if (!run) {
      await safeEditRun(ctx, RUN.NOT_FOUND(ref))
      return
    }
    const text = renderRunDetailText(run, getRunDisplayStatus)
    const kb = buildRunDetailKeyboard(
      run.context.runId,
      getRunDisplayStatus(run),
      run.retryable ?? false,
    )
    await safeEditRun(ctx, text, kb)
    return
  }

  // r:cancel:ID — show confirmation
  if (action === 'cancel') {
    const ref = parts[1]
    if (!ref) return
    const run = await sessionManager.getRunDetails(ref)
    if (!run) {
      await safeEditRun(ctx, RUN.NOT_FOUND(ref))
      return
    }
    await safeEditRun(
      ctx,
      `确定要取消 run "${truncateLabel(run.context.runId, 30)}" 吗？`,
      buildConfirmKeyboard(
        `r:cancel_y:${shortRunId(run.context.runId)}`,
        `r:cancel_n:${shortRunId(run.context.runId)}`,
      ),
    )
    return
  }

  // r:cancel_y:ID — confirmed cancel
  if (action === 'cancel_y') {
    const ref = parts[1]
    if (!ref) return
    const cancelled = await sessionManager.cancelRun(ref)
    await safeEditRun(
      ctx,
      cancelled ? RUN.CANCELLED(ref) : RUN.CANCEL_UNABLE(ref),
      buildMenuKeyboard([{ label: '🔙 返回列表', data: 'r:list:1:all' }]),
    )
    return
  }

  // r:cancel_n:ID — cancel aborted, back to detail
  if (action === 'cancel_n') {
    const ref = parts[1]
    if (!ref) return
    const run = await sessionManager.getRunDetails(ref)
    if (!run) {
      await safeEditRun(ctx, RUN.NOT_FOUND(ref))
      return
    }
    const text = renderRunDetailText(run, getRunDisplayStatus)
    const kb = buildRunDetailKeyboard(
      run.context.runId,
      getRunDisplayStatus(run),
      run.retryable ?? false,
    )
    await safeEditRun(ctx, text, kb)
    return
  }

  // r:retry:ID — retry a run
  if (action === 'retry') {
    const ref = parts[1]
    if (!ref) return
    try {
      const run = await sessionManager.retryRun(ref)
      await safeEditRun(
        ctx,
        [
          RUN.RETRIED(ref),
          `new run: ${run.context.runId}`,
          `status: ${getRunDisplayStatus(run)}`,
        ].join('\n'),
        buildMenuKeyboard([
          { label: '📋 查看新 Run', data: `r:show:${shortRunId(run.context.runId)}` },
          { label: '🔙 返回列表', data: 'r:list:1:all' },
        ]),
      )
    } catch (error) {
      await safeEditRun(
        ctx,
        RUN.RETRY_FAIL((error as Error).message),
        buildMenuKeyboard([{ label: '🔙 返回', data: `r:show:${ref}` }]),
      )
    }
    return
  }
}
