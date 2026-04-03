import { Composer, type Context, InlineKeyboard } from 'grammy'

import type { SessionManager } from '../../../session-manager.js'
import {
  LIST_PAGE_SIZE,
  parsePositiveInt,
  parseListControls,
  parseSearchPaginationArgs,
  parseThreadHistoryArgs,
  sortThreadsForView,
} from '../views/pagination.js'
import { renderSections } from '../views/sections.js'
import {
  highlightSearchText,
  formatTimestamp,
  formatThreadCwdSummary,
  originatorBadge,
  originatorLabel,
} from '../views/formatting.js'
import { THREAD, UNDO } from '../i18n/zh.js'
import { ensureAuthorized, getUserId, getChatId } from '../middleware/auth.js'
import {
  buildMenuKeyboard,
  buildListKeyboard,
  buildConfirmKeyboard,
  buildBackKeyboard,
} from '../views/keyboards.js'

// ─── Inline keyboard helpers ─────────────────────────────────────────────────

const THREAD_ID_MAX = 16
const HISTORY_TEXT_LIMIT = 3500

/** Truncate a thread ID for callback_data (max 64 bytes). */
function shortId(id: string): string {
  return id.length > THREAD_ID_MAX ? id.slice(0, THREAD_ID_MAX) : id
}

/** editMessageText that silently ignores "message is not modified" errors. */
async function safeEdit(
  ctx: Context,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  try {
    await ctx.editMessageText(text, keyboard ? { reply_markup: keyboard } : undefined)
  } catch (error) {
    if (String(error).includes('message is not modified')) return
    throw error
  }
}

/** Build the thread subcommand menu keyboard. */
function threadMenuKeyboard(): InlineKeyboard {
  return buildMenuKeyboard([
    { label: '📋 列表', data: 't:list:1' },
    { label: '➕ 新建', data: 't:new' },
    { label: '📊 详情', data: 't:show' },
    { label: '📜 历史', data: 't:hist' },
    { label: '📝 摘要', data: 't:summary' },
    { label: '🔄 同步', data: 't:sync' },
  ])
}

/** Build detail-view action keyboard for a thread. */
function threadDetailKeyboard(thread: { id: string; pinnedAt?: string | null }): InlineKeyboard {
  const tid = shortId(thread.id)
  const kb = new InlineKeyboard()
  kb.text('📝 重命名', 't:rename')
    .text(thread.pinnedAt ? '📌 Unpin' : '📌 Pin', thread.pinnedAt ? `t:unpin:${tid}` : `t:pin:${tid}`)
    .text('📦 归档', `t:archive:${tid}`)
    .row()
  kb.text('🗑 删除', `t:del:${tid}`)
    .text('↩️ Undo', `t:undo:${tid}`)
    .text('📋 移动', `t:move:${tid}`)
    .row()
  kb.text('📜 历史', 't:hist')
    .text('📝 摘要', 't:summary')
    .text('🔄 Turns', 't:turns')
    .row()
  kb.text('🔙 返回列表', 't:list:1')
    .row()
  return kb
}

/** Build list-view keyboard with thread buttons + pagination. */
function threadListKeyboard(
  threads: Array<{ id: string; title: string; status: string; originator?: string; pinnedAt?: string | null; archivedAt?: string | null }>,
  page: number,
  totalPages: number,
  startIndex: number,
): InlineKeyboard {
  const items = threads.map((thread, index) => {
    const num = startIndex + index + 1
    const statusSuffix = thread.status !== 'idle' ? ` ▶ ${thread.status}` : ''
    const pinIcon = thread.pinnedAt ? ' 📌' : ''
    const archiveIcon = thread.archivedAt ? ' 📦' : ''
    const badge = originatorBadge(thread.originator)
    return {
      label: `${badge} ${num}. ${thread.title}${pinIcon}${archiveIcon}${statusSuffix}`,
      data: `t:use:${shortId(thread.id)}`,
    }
  })
  const kb = buildListKeyboard(items, page, totalPages, 't:list')
  kb.text('🔙 返回', 't:menu').row()
  return kb
}

/** Build navigation keyboard for history / turns content. */
function historyNavKeyboard(
  prevCursor: string | null | undefined,
  nextCursor: string | null | undefined,
  action: string,
): InlineKeyboard {
  const kb = new InlineKeyboard()
  if (prevCursor) kb.text('⬅ 更早', `t:${action}:${prevCursor}`)
  if (nextCursor) kb.text('更新 ➡', `t:${action}:${nextCursor}`)
  if (prevCursor || nextCursor) kb.row()
  kb.text('🔙 返回详情', 't:show').row()
  return kb
}

// ─── Subcommand handlers ────────────────────────────────────────────────────

async function handleNew(ctx: Context, sm: SessionManager, userId: string, chatId: string) {
  const { session, codexThreadId } = await sm.createThread(userId, chatId)
  await ctx.reply(THREAD.NEW_THREAD(session.cwd, codexThreadId), { parse_mode: 'Markdown' })
}

async function handleList(
  ctx: Context,
  sm: SessionManager,
  userId: string,
  chatId: string,
  args: string[],
) {
  const state = await sm.getThreadState(userId, chatId)
  const { page, pageSize, start, end, sort } = parseListControls(args.slice(1))
  const orderedThreads = sortThreadsForView(state.threads, sort)
  const threads = orderedThreads.slice(start, end)
  const total = orderedThreads.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const hasPrev = start > 0
  const hasNext = end < total
  const currentThreadIndex = state.currentThread
    ? orderedThreads.findIndex((thread) => thread.id === state.currentThread?.id)
    : -1
  const currentThreadOnPage =
    currentThreadIndex >= start && currentThreadIndex < end

  if (!state.currentProject) {
    await ctx.reply(THREAD.NO_ACTIVE_PROJECT)
    return
  }

  if (state.threads.length === 0) {
    await ctx.reply(THREAD.NO_SAVED_THREADS)
    return
  }

  await ctx.reply(
    [
      THREAD.CURRENT_PROJECT(state.currentProject.name),
      `sort: ${sort}`,
      `page ${page}/${totalPages}, pageSize ${pageSize}`,
      state.currentThread
        ? `current: ${state.currentThread.title} (#${currentThreadIndex + 1}${currentThreadOnPage ? ', on this page' : ', not on this page'})`
        : 'current: -',
      `total: ${total}`,
      hasPrev ? `prev: /thread list ${Math.max(1, page - 1)} ${pageSize} --sort ${sort}` : undefined,
      hasNext ? `next: /thread list ${page + 1} ${pageSize} --sort ${sort}` : undefined,
      sort === 'name' ? THREAD.SORT_BY_TITLE : THREAD.SORT_BY_UPDATED,
      'threads:',
      ...threads.map((thread, index) =>
        `${state.currentThread?.id === thread.id ? '* ' : ''}${originatorBadge(thread.originator)} ${start + index + 1}. [${thread.sourceId}] ${thread.title}${thread.archivedAt ? ' [archived]' : ''}\n${thread.codexThreadId ?? thread.id}\nupdated: ${formatTimestamp(thread.updatedAt)}\ncwd: ${formatThreadCwdSummary(state.currentProject!.cwd, thread.cwd)}`,
      ),
    ]
      .filter(Boolean)
      .join('\n'),
    { reply_markup: threadListKeyboard(threads, page, totalPages, start) },
  )
}

async function handleSearch(
  ctx: Context,
  sm: SessionManager,
  userId: string,
  chatId: string,
  args: string[],
) {
  const { query, page, pageSize, start, end, sort } = parseSearchPaginationArgs(args.slice(1))

  if (!query) {
    await ctx.reply(THREAD.SEARCH_USAGE)
    return
  }

  const state = await sm.searchThreads(userId, chatId, query)
  const orderedThreads = sortThreadsForView(state.threads, sort)
  const threads = orderedThreads.slice(start, end)
  const total = orderedThreads.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const hasPrev = start > 0
  const hasNext = end < total
  const currentThreadIndex = state.currentThread
    ? orderedThreads.findIndex((thread) => thread.id === state.currentThread?.id)
    : -1
  const currentThreadOnPage =
    currentThreadIndex >= start && currentThreadIndex < end

  if (!state.currentProject) {
    await ctx.reply(THREAD.NO_ACTIVE_PROJECT)
    return
  }

  if (state.threads.length === 0) {
    await ctx.reply(THREAD.NO_MATCH(query))
    return
  }

  await ctx.reply(
    [
      `thread search: ${query}`,
      `project: ${state.currentProject.name}`,
      `sort: ${sort}`,
      `page ${page}/${totalPages}, pageSize ${pageSize}`,
      state.currentThread
        ? `current: ${state.currentThread.title} (${currentThreadIndex >= 0 ? `#${currentThreadIndex + 1}${currentThreadOnPage ? ', on this page' : ', not on this page'}` : 'not in results'})`
        : 'current: -',
      `total: ${total}`,
      hasPrev ? `prev: /thread search ${query} ${Math.max(1, page - 1)} ${pageSize} --sort ${sort}` : undefined,
      hasNext ? `next: /thread search ${query} ${page + 1} ${pageSize} --sort ${sort}` : undefined,
      ...threads.map((thread, index) =>
        `${state.currentThread?.id === thread.id ? '* ' : ''}${originatorBadge(thread.originator)} ${start + index + 1}. [${thread.sourceId}] ${highlightSearchText(thread.title, query)}${thread.archivedAt ? ' [archived]' : ''}\n${highlightSearchText(thread.codexThreadId ?? thread.id, query)}`,
      ),
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

async function handleWhere(
  ctx: Context,
  sm: SessionManager,
  userId: string,
  chatId: string,
  args: string[],
) {
  const state = await sm.getThreadState(userId, chatId)
  const pageSize = parsePositiveInt(args[1]) ?? LIST_PAGE_SIZE
  if (!state.currentProject) {
    await ctx.reply(THREAD.NO_ACTIVE_PROJECT)
    return
  }
  if (!state.currentThread) {
    await ctx.reply(THREAD.NO_ACTIVE)
    return
  }

  const index = state.threads.findIndex((thread) => thread.id === state.currentThread?.id)
  if (index < 0) {
    await ctx.reply(THREAD.NOT_IN_LIST(state.currentThread.title))
    return
  }

  const page = Math.floor(index / pageSize) + 1
  await ctx.reply(
    [
      `current thread: ${state.currentThread.title}`,
      `project: ${state.currentProject.name}`,
      `index: #${index + 1}/${state.threads.length}`,
      `page: ${page}`,
      `pageSize: ${pageSize}`,
      `jump: /thread list ${page} ${pageSize}`,
    ].join('\n'),
  )
}

async function handleHistory(
  ctx: Context,
  sm: SessionManager,
  userId: string,
  chatId: string,
  args: string[],
) {
  const historyOptions = parseThreadHistoryArgs(args.slice(1))
  const { project, thread, page } = await sm.getThreadHistoryPage(
    userId,
    chatId,
    historyOptions,
  )

  if (!thread) {
    await ctx.reply(THREAD.NO_ACTIVE)
    return
  }

  if (page.entries.length === 0) {
    await ctx.reply(
      [
        `thread: ${thread.title}`,
        project ? `project: ${project.name}` : undefined,
        THREAD.NO_HISTORY,
      ]
        .filter(Boolean)
        .join('\n'),
      { reply_markup: buildBackKeyboard('t:show') },
    )
    return
  }

  await ctx.reply(
    [
      `thread: ${thread.title}`,
      project ? `project: ${project.name}` : undefined,
      historyOptions.cursor ? `cursor: ${historyOptions.cursor}` : undefined,
      `total: ${page.total}`,
      page.prevCursor ? `prev: ${page.prevCursor}` : undefined,
      page.nextCursor ? `next: ${page.nextCursor}` : undefined,
      ...page.entries.map((entry) => {
        const prefix =
          entry.view === 'tool'
            ? `T(${entry.toolPhase ?? 'tool'})`
            : entry.view === 'agent'
              ? 'G'
              : entry.role === 'user'
                ? 'U'
                : 'A'
        return `${prefix}: ${entry.text}`
      }),
    ]
      .filter(Boolean)
      .join('\n\n'),
    { reply_markup: historyNavKeyboard(page.prevCursor, page.nextCursor, 'hist') },
  )
}

async function handleTurns(
  ctx: Context,
  sm: SessionManager,
  userId: string,
  chatId: string,
  args: string[],
) {
  const historyOptions = parseThreadHistoryArgs(args.slice(1))
  const { project, thread, page } = await sm.getThreadTurnHistoryPage(
    userId,
    chatId,
    historyOptions,
  )

  if (!thread) {
    await ctx.reply(THREAD.NO_ACTIVE)
    return
  }

  if (page.turns.length === 0) {
    await ctx.reply(
      [
        `thread: ${thread.title}`,
        project ? `project: ${project.name}` : undefined,
        THREAD.NO_TURNS,
      ]
        .filter(Boolean)
        .join('\n'),
      { reply_markup: buildBackKeyboard('t:show') },
    )
    return
  }

  await ctx.reply(
    [
      `thread: ${thread.title}`,
      project ? `project: ${project.name}` : undefined,
      historyOptions.cursor ? `cursor: ${historyOptions.cursor}` : undefined,
      `total turns: ${page.total}`,
      page.prevCursor ? `prev: ${page.prevCursor}` : undefined,
      page.nextCursor ? `next: ${page.nextCursor}` : undefined,
      ...page.turns.map((turn) =>
        [
          `#${turn.index} ${turn.startedAt ? formatTimestamp(turn.startedAt) : ''}`.trim(),
          turn.userEntry ? `U: ${turn.userEntry.text}` : 'U: -',
          `assistant: ${turn.assistantMessageCount}, agents: ${turn.agentMessageCount}, tool calls: ${turn.toolCallCount}, tool outputs: ${turn.toolOutputCount}`,
        ].join('\n'),
      ),
    ]
      .filter(Boolean)
      .join('\n\n'),
    { reply_markup: historyNavKeyboard(page.prevCursor, page.nextCursor, 'turns') },
  )
}

async function handleSummary(
  ctx: Context,
  sm: SessionManager,
  userId: string,
  chatId: string,
  args: string[],
) {
  const historyOptions = parseThreadHistoryArgs(args.slice(1))
  const { project, thread, turns, summaries } = await sm.getThreadTurnSummaries(
    userId,
    chatId,
    historyOptions,
  )

  if (!thread) {
    await ctx.reply(THREAD.NO_ACTIVE)
    return
  }

  if (turns.length === 0) {
    await ctx.reply(
      [
        `thread: ${thread.title}`,
        project ? `project: ${project.name}` : undefined,
        THREAD.NO_SUMMARIZABLE_TURNS,
      ]
        .filter(Boolean)
        .join('\n'),
      { reply_markup: buildBackKeyboard('t:show') },
    )
    return
  }

  await ctx.reply(
    [
      `thread: ${thread.title}`,
      project ? `project: ${project.name}` : undefined,
      `total turns: ${turns.length}`,
      ...summaries.map((summary, index) => `${turns[index]?.index ?? index + 1}. ${summary}`),
    ]
      .filter(Boolean)
      .join('\n'),
    { reply_markup: buildBackKeyboard('t:show') },
  )
}

async function handleShow(
  ctx: Context,
  sm: SessionManager,
  userId: string,
  chatId: string,
) {
  const { project, thread, source } = await sm.getCurrentThreadDetails(
    userId,
    chatId,
  )

  if (!thread) {
    await ctx.reply(THREAD.NO_ACTIVE)
    return
  }

  await ctx.reply(renderSections([
    {
      title: 'Identity',
      lines: [
        `thread: ${thread.title}`,
        `local id: ${thread.id}`,
        `codex thread: ${thread.codexThreadId ?? '-'}`,
        `cwd: ${thread.cwd}`,
      ],
    },
    {
      title: 'Status',
      lines: [
        `project: ${project?.name ?? '-'}`,
        `source: ${source?.id ?? thread.sourceId}`,
        `来源: ${originatorLabel(thread.originator)}`,
        `status: ${thread.status}`,
        `updated: ${formatTimestamp(thread.updatedAt)}`,
      ],
    },
    {
      title: 'Links',
      lines: [
        project ? `project show: /project show` : undefined,
        source ? `source show: /source show ${source.id}` : undefined,
      ],
    },
    {
      title: 'Actions',
      lines: [
        'jump: /thread where',
        project ? 'next: /project show' : undefined,
        source ? `next: /source show ${source.id}` : undefined,
      ],
    },
  ]), { reply_markup: threadDetailKeyboard(thread) })
}

async function handleMove(
  ctx: Context,
  sm: SessionManager,
  userId: string,
  chatId: string,
  args: string[],
) {
  const projectReference = args.slice(1).join(' ').trim()

  if (!projectReference) {
    await ctx.reply(THREAD.MOVE_USAGE)
    return
  }

  try {
    const { thread, project } = await sm.moveCurrentThread(
      userId,
      chatId,
      projectReference,
    )
    await ctx.reply(
      [
        THREAD.MOVED(project.name),
        `${thread.title}`,
        `${thread.codexThreadId ?? thread.id}`,
        THREAD.CWD_UNCHANGED(thread.cwd),
      ].join('\n'),
    )
  } catch (error) {
    await ctx.reply(THREAD.MOVE_FAIL((error as Error).message))
  }
}

async function handleArchive(ctx: Context, sm: SessionManager, userId: string, chatId: string) {
  try {
    const thread = await sm.archiveCurrentThread(userId, chatId)
    await ctx.reply(THREAD.ARCHIVED(thread.title, thread.codexThreadId ?? thread.id))
  } catch (error) {
    await ctx.reply(THREAD.ARCHIVE_FAIL((error as Error).message))
  }
}

async function handleDelete(ctx: Context, sm: SessionManager, userId: string, chatId: string) {
  try {
    const thread = await sm.deleteCurrentThread(userId, chatId)
    await ctx.reply(THREAD.DELETED(thread.title, thread.codexThreadId ?? thread.id))
  } catch (error) {
    await ctx.reply(THREAD.DELETE_FAIL((error as Error).message))
  }
}

async function handlePin(ctx: Context, sm: SessionManager, userId: string, chatId: string) {
  try {
    const thread = await sm.pinCurrentThread(userId, chatId)
    await ctx.reply(THREAD.PINNED(thread.title, thread.codexThreadId ?? thread.id))
  } catch (error) {
    await ctx.reply(THREAD.PIN_FAIL((error as Error).message))
  }
}

async function handleUnpin(ctx: Context, sm: SessionManager, userId: string, chatId: string) {
  try {
    const thread = await sm.unpinCurrentThread(userId, chatId)
    await ctx.reply(THREAD.UNPINNED(thread.title, thread.codexThreadId ?? thread.id))
  } catch (error) {
    await ctx.reply(THREAD.UNPIN_FAIL((error as Error).message))
  }
}

async function handleUndo(ctx: Context, sm: SessionManager, userId: string, chatId: string) {
  try {
    const result = await sm.undoLastTurn(userId, chatId)
    await ctx.reply(
      [
        `${result.mode === 'rewritten' ? UNDO.MODE_REWRITTEN : UNDO.MODE_HIDDEN}: ${result.thread.title}`,
        `turn: #${result.turn.index}`,
        `entries hidden: ${result.hiddenEntryCount}`,
        `user: ${result.turn.userEntry?.text ?? '-'}`,
        `running killed: ${result.cancel.killedRunning}`,
        `queued cleared: ${result.cancel.clearedQueued}`,
        result.mode === 'rewritten'
          ? `rewritten files: ${result.rewrittenFiles ?? 0}`
          : UNDO.NOTE_LOCAL_ONLY,
      ].join('\n'),
    )
  } catch (error) {
    await ctx.reply(UNDO.FAIL((error as Error).message))
  }
}

async function handleRename(
  ctx: Context,
  sm: SessionManager,
  userId: string,
  chatId: string,
  args: string[],
) {
  const newName = args.slice(1).join(' ').trim()

  if (!newName) {
    await ctx.reply(THREAD.RENAME_USAGE)
    return
  }

  try {
    const thread = await sm.renameCurrentThread(
      userId,
      chatId,
      newName,
    )
    await ctx.reply(
      THREAD.RENAMED(thread.title, thread.codexThreadId ?? thread.id),
    )
  } catch (error) {
    await ctx.reply(THREAD.RENAME_FAIL((error as Error).message))
  }
}

async function handleUse(
  ctx: Context,
  sm: SessionManager,
  userId: string,
  chatId: string,
  args: string[],
) {
  const reference = args[1]

  if (!reference) {
    await ctx.reply(THREAD.USE_USAGE)
    return
  }

  try {
    const { thread, added, projectChanged } = await sm.switchThread(
      userId,
      chatId,
      reference,
    )
    await ctx.reply(
      added
        ? THREAD.IMPORTED_AND_SWITCHED(thread.title, thread.codexThreadId ?? thread.id)
        : THREAD.SWITCHED(thread.title, thread.codexThreadId ?? thread.id) + (projectChanged ? THREAD.ALSO_SWITCHED_PROJECT : ''),
    )
  } catch (error) {
    await ctx.reply(THREAD.SWITCH_FAIL((error as Error).message))
  }
}

async function handleCurrent(ctx: Context, sm: SessionManager, userId: string, chatId: string) {
  const state = await sm.getThreadState(userId, chatId)
  await ctx.reply(
    state.currentThread
      ? THREAD.CURRENT_INFO(state.currentThread.title, state.currentThread.codexThreadId ?? state.currentThread.id, state.currentProject?.name ?? '-', state.currentProject ? formatThreadCwdSummary(state.currentProject.cwd, state.currentThread.cwd) : state.currentThread.cwd, state.threads.length)
      : THREAD.CURRENT_NONE(state.currentProject?.name ?? '-', state.threads.length),
    { reply_markup: threadMenuKeyboard() },
  )
}

// ─── Callback render functions ───────────────────────────────────────────────

async function renderMenuForCallback(
  sm: SessionManager,
  userId: string,
  chatId: string,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const state = await sm.getThreadState(userId, chatId)
  const text = state.currentThread
    ? `当前 thread: ${state.currentThread.title}\n状态: ${state.currentThread.status} | 项目: ${state.currentProject?.name ?? '-'}`
    : THREAD.CURRENT_NONE(state.currentProject?.name ?? '-', state.threads.length)
  return { text, keyboard: threadMenuKeyboard() }
}

async function renderListForCallback(
  sm: SessionManager,
  userId: string,
  chatId: string,
  page: number,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const state = await sm.getThreadState(userId, chatId)
  if (!state.currentProject) {
    return { text: THREAD.NO_ACTIVE_PROJECT, keyboard: buildBackKeyboard('t:menu') }
  }
  if (state.threads.length === 0) {
    return { text: THREAD.NO_SAVED_THREADS, keyboard: buildBackKeyboard('t:menu') }
  }
  const orderedThreads = sortThreadsForView(state.threads, 'recent')
  const total = orderedThreads.length
  const pageSize = LIST_PAGE_SIZE
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.max(1, Math.min(page, totalPages))
  const start = (safePage - 1) * pageSize
  const end = Math.min(start + pageSize, total)
  const threads = orderedThreads.slice(start, end)
  const text = `📋 Threads (page ${safePage}/${totalPages}, total ${total})`
  return { text, keyboard: threadListKeyboard(threads, safePage, totalPages, start) }
}

async function renderShowForCallback(
  sm: SessionManager,
  userId: string,
  chatId: string,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const { project, thread, source } = await sm.getCurrentThreadDetails(userId, chatId)
  if (!thread) {
    return { text: THREAD.NO_ACTIVE, keyboard: buildBackKeyboard('t:menu') }
  }
  const sections = [
    {
      title: 'Identity',
      lines: [
        `title: ${thread.title}`,
        `project: ${project?.name ?? '-'}`,
        `source: ${source?.id ?? thread.sourceId}`,
      ],
    },
    {
      title: 'Status',
      lines: [
        `status: ${thread.status}`,
        `origin: ${thread.origin}`,
        `来源: ${originatorLabel(thread.originator)}`,
      ],
    },
  ]
  if (thread.codexThreadId) {
    sections.push({
      title: 'Channel',
      lines: [
        `codex ID: ${thread.codexThreadId}`,
        `本地同步: npx tsx connect.ts ${thread.codexThreadId}`,
      ],
    })
  }
  const text = renderSections(sections)
  return { text, keyboard: threadDetailKeyboard(thread) }
}

async function renderHistoryForCallback(
  sm: SessionManager,
  userId: string,
  chatId: string,
  cursor?: string,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const { project, thread, page } = await sm.getThreadHistoryPage(
    userId, chatId, cursor ? { cursor } : {},
  )
  if (!thread) {
    return { text: THREAD.NO_ACTIVE, keyboard: buildBackKeyboard('t:menu') }
  }
  if (page.entries.length === 0) {
    return {
      text: [`thread: ${thread.title}`, project ? `project: ${project.name}` : undefined, THREAD.NO_HISTORY].filter(Boolean).join('\n'),
      keyboard: buildBackKeyboard('t:show'),
    }
  }
  let text = [
    `thread: ${thread.title}`,
    project ? `project: ${project.name}` : undefined,
    `total: ${page.total}`,
    ...page.entries.map((entry) => {
      const prefix = entry.view === 'tool' ? `T(${entry.toolPhase ?? 'tool'})` : entry.view === 'agent' ? 'G' : entry.role === 'user' ? 'U' : 'A'
      return `${prefix}: ${entry.text}`
    }),
  ].filter(Boolean).join('\n\n')
  if (text.length > HISTORY_TEXT_LIMIT) {
    text = text.slice(0, HISTORY_TEXT_LIMIT) + '\n\n…（使用 /thread history 查看完整内容）'
  }
  return { text, keyboard: historyNavKeyboard(page.prevCursor, page.nextCursor, 'hist') }
}

async function renderTurnsForCallback(
  sm: SessionManager,
  userId: string,
  chatId: string,
  cursor?: string,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const { project, thread, page } = await sm.getThreadTurnHistoryPage(
    userId, chatId, cursor ? { cursor } : {},
  )
  if (!thread) {
    return { text: THREAD.NO_ACTIVE, keyboard: buildBackKeyboard('t:menu') }
  }
  if (page.turns.length === 0) {
    return {
      text: [`thread: ${thread.title}`, project ? `project: ${project.name}` : undefined, THREAD.NO_TURNS].filter(Boolean).join('\n'),
      keyboard: buildBackKeyboard('t:show'),
    }
  }
  let text = [
    `thread: ${thread.title}`,
    project ? `project: ${project.name}` : undefined,
    `total turns: ${page.total}`,
    ...page.turns.map((turn) =>
      [`#${turn.index} ${turn.startedAt ? formatTimestamp(turn.startedAt) : ''}`.trim(), turn.userEntry ? `U: ${turn.userEntry.text}` : 'U: -', `assistant: ${turn.assistantMessageCount}, agents: ${turn.agentMessageCount}, tool calls: ${turn.toolCallCount}, tool outputs: ${turn.toolOutputCount}`].join('\n'),
    ),
  ].filter(Boolean).join('\n\n')
  if (text.length > HISTORY_TEXT_LIMIT) {
    text = text.slice(0, HISTORY_TEXT_LIMIT) + '\n\n…（使用 /thread turns 查看完整内容）'
  }
  return { text, keyboard: historyNavKeyboard(page.prevCursor, page.nextCursor, 'turns') }
}

async function renderSummaryForCallback(
  sm: SessionManager,
  userId: string,
  chatId: string,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const { project, thread, turns, summaries } = await sm.getThreadTurnSummaries(userId, chatId)
  if (!thread) {
    return { text: THREAD.NO_ACTIVE, keyboard: buildBackKeyboard('t:menu') }
  }
  if (turns.length === 0) {
    return {
      text: [`thread: ${thread.title}`, project ? `project: ${project.name}` : undefined, THREAD.NO_SUMMARIZABLE_TURNS].filter(Boolean).join('\n'),
      keyboard: buildBackKeyboard('t:show'),
    }
  }
  let text = [
    `thread: ${thread.title}`,
    project ? `project: ${project.name}` : undefined,
    `total turns: ${turns.length}`,
    ...summaries.map((summary, index) => `${turns[index]?.index ?? index + 1}. ${summary}`),
  ].filter(Boolean).join('\n')
  if (text.length > HISTORY_TEXT_LIMIT) {
    text = text.slice(0, HISTORY_TEXT_LIMIT) + '\n\n…（使用 /thread summary 查看完整内容）'
  }
  const kb = new InlineKeyboard()
  kb.text('🔙 返回详情', 't:show').row()
  return { text, keyboard: kb }
}

// ─── Composer factory ───────────────────────────────────────────────────────

export function createThreadCommands(
  sessionManager: SessionManager,
  router?: import('../callbacks/router.js').CallbackRouter,
): Composer<Context> {
  const composer = new Composer<Context>()

  composer.command('thread', async (ctx) => {
    if (!(await ensureAuthorized(ctx))) {
      return
    }

    const args = ctx.message?.text?.trim().split(/\s+/).slice(1) ?? []
    const action = args[0]?.toLowerCase() ?? 'current'
    const userId = getUserId(ctx)
    const chatId = getChatId(ctx)

    if (action === 'new') { await handleNew(ctx, sessionManager, userId, chatId); return }
    if (action === 'list') { await handleList(ctx, sessionManager, userId, chatId, args); return }
    if (action === 'search') { await handleSearch(ctx, sessionManager, userId, chatId, args); return }
    if (action === 'where') { await handleWhere(ctx, sessionManager, userId, chatId, args); return }
    if (action === 'history') { await handleHistory(ctx, sessionManager, userId, chatId, args); return }
    if (action === 'turns') { await handleTurns(ctx, sessionManager, userId, chatId, args); return }
    if (action === 'summary') { await handleSummary(ctx, sessionManager, userId, chatId, args); return }
    if (action === 'show') { await handleShow(ctx, sessionManager, userId, chatId); return }
    if (action === 'move') { await handleMove(ctx, sessionManager, userId, chatId, args); return }
    if (action === 'archive') { await handleArchive(ctx, sessionManager, userId, chatId); return }
    if (action === 'delete') { await handleDelete(ctx, sessionManager, userId, chatId); return }
    if (action === 'pin') { await handlePin(ctx, sessionManager, userId, chatId); return }
    if (action === 'unpin') { await handleUnpin(ctx, sessionManager, userId, chatId); return }
    if (action === 'undo') { await handleUndo(ctx, sessionManager, userId, chatId); return }
    if (action === 'rename') { await handleRename(ctx, sessionManager, userId, chatId, args); return }
    if (action === 'use') { await handleUse(ctx, sessionManager, userId, chatId, args); return }
    if (action === 'current') { await handleCurrent(ctx, sessionManager, userId, chatId); return }

    await ctx.reply(THREAD.USAGE_HELP)
  })

  // Register callback handlers for inline keyboard interactions
  router?.register('t', async (ctx, parts) => {
    const action = parts[0]
    if (!action) return

    const userId = getUserId(ctx)
    const chatId = getChatId(ctx)

    try {
      switch (action) {
        case 'menu': {
          const v = await renderMenuForCallback(sessionManager, userId, chatId)
          await safeEdit(ctx, v.text, v.keyboard)
          break
        }
        case 'list': {
          const page = parsePositiveInt(parts[1]) ?? 1
          const v = await renderListForCallback(sessionManager, userId, chatId, page)
          await safeEdit(ctx, v.text, v.keyboard)
          break
        }
        case 'show': {
          const v = await renderShowForCallback(sessionManager, userId, chatId)
          await safeEdit(ctx, v.text, v.keyboard)
          break
        }
        case 'use': {
          const index = parts[1]
          if (!index) break
          await sessionManager.switchThread(userId, chatId, index)
          const v = await renderShowForCallback(sessionManager, userId, chatId)
          await safeEdit(ctx, v.text, v.keyboard)
          break
        }
        case 'new': {
          const [{ session, codexThreadId }, v] = await Promise.all([
            sessionManager.createThread(userId, chatId),
            renderMenuForCallback(sessionManager, userId, chatId),
          ])
          await safeEdit(ctx, `${THREAD.NEW_THREAD(session.cwd, codexThreadId)}\n\n${v.text}`, v.keyboard)
          break
        }
        case 'hist': {
          // Cursor may contain ':' so rejoin remaining parts
          const cursor = parts.slice(1).join(':') || undefined
          const v = await renderHistoryForCallback(sessionManager, userId, chatId, cursor)
          await safeEdit(ctx, v.text, v.keyboard)
          break
        }
        case 'turns': {
          const cursor = parts.slice(1).join(':') || undefined
          const v = await renderTurnsForCallback(sessionManager, userId, chatId, cursor)
          await safeEdit(ctx, v.text, v.keyboard)
          break
        }
        case 'summary': {
          const v = await renderSummaryForCallback(sessionManager, userId, chatId)
          await safeEdit(ctx, v.text, v.keyboard)
          break
        }
        case 'rename': {
          await safeEdit(
            ctx,
            '请发送: /thread rename <新名称>',
            buildBackKeyboard('t:show'),
          )
          break
        }
        case 'pin': {
          await sessionManager.pinCurrentThread(userId, chatId)
          const v = await renderShowForCallback(sessionManager, userId, chatId)
          await safeEdit(ctx, v.text, v.keyboard)
          break
        }
        case 'unpin': {
          await sessionManager.unpinCurrentThread(userId, chatId)
          const v = await renderShowForCallback(sessionManager, userId, chatId)
          await safeEdit(ctx, v.text, v.keyboard)
          break
        }
        case 'archive': {
          const state = await sessionManager.getThreadState(userId, chatId)
          const title = state.currentThread?.title ?? 'this thread'
          const tid = parts[1] ?? ''
          await safeEdit(
            ctx,
            `确定要归档 thread "${title}" 吗？`,
            buildConfirmKeyboard(`t:archive_y:${tid}`, `t:archive_n:${tid}`),
          )
          break
        }
        case 'archive_y': {
          const thread = await sessionManager.archiveCurrentThread(userId, chatId)
          const v = await renderListForCallback(sessionManager, userId, chatId, 1)
          await safeEdit(ctx, `${THREAD.ARCHIVED(thread.title, thread.codexThreadId ?? thread.id)}\n\n${v.text}`, v.keyboard)
          break
        }
        case 'archive_n': {
          const v = await renderShowForCallback(sessionManager, userId, chatId)
          await safeEdit(ctx, v.text, v.keyboard)
          break
        }
        case 'del': {
          const state = await sessionManager.getThreadState(userId, chatId)
          const title = state.currentThread?.title ?? 'this thread'
          const tid = parts[1] ?? ''
          await safeEdit(
            ctx,
            `确定要删除 thread "${title}" 吗？`,
            buildConfirmKeyboard(`t:del_y:${tid}`, `t:del_n:${tid}`),
          )
          break
        }
        case 'del_y': {
          const thread = await sessionManager.deleteCurrentThread(userId, chatId)
          const v = await renderListForCallback(sessionManager, userId, chatId, 1)
          await safeEdit(ctx, `${THREAD.DELETED(thread.title, thread.codexThreadId ?? thread.id)}\n\n${v.text}`, v.keyboard)
          break
        }
        case 'del_n': {
          const v = await renderShowForCallback(sessionManager, userId, chatId)
          await safeEdit(ctx, v.text, v.keyboard)
          break
        }
        case 'undo': {
          const result = await sessionManager.undoLastTurn(userId, chatId)
          const msg = result.mode === 'rewritten' ? UNDO.MODE_REWRITTEN : UNDO.MODE_HIDDEN
          const v = await renderShowForCallback(sessionManager, userId, chatId)
          await safeEdit(ctx, `${msg}: ${result.thread.title}\n\n${v.text}`, v.keyboard)
          break
        }
        case 'move': {
          await safeEdit(
            ctx,
            '请发送: /thread move <project>',
            buildBackKeyboard('t:show'),
          )
          break
        }
        case 'sync': {
          try {
            const count = await sessionManager.syncThreadsFromServer(userId, chatId)
            const v = await renderListForCallback(sessionManager, userId, chatId, 1)
            await safeEdit(ctx, `同步完成: 发现 ${count} 个新 thread\n\n${v.text}`, v.keyboard)
          } catch (syncError) {
            await safeEdit(
              ctx,
              `❌ 同步失败: ${(syncError as Error).message}`,
              buildBackKeyboard('t:menu'),
            )
          }
          break
        }
        default:
          break
      }
    } catch (error) {
      try {
        await safeEdit(ctx, `❌ ${(error as Error).message}`, buildBackKeyboard('t:menu'))
      } catch {
        // ignore nested errors
      }
    }
  })

  return composer
}
