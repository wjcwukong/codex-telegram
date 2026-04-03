import { Composer, type Context } from 'grammy'
import { InlineKeyboard } from 'grammy'

import type { SessionManager } from '../../../session-manager.js'
import type { AgentStatus } from '../../../models.js'
import {
  LIST_PAGE_SIZE,
  parsePositiveInt,
  parsePaginationArgs,
  parseSearchPaginationArgs,
  resolveIndexedItemIndex,
} from '../views/pagination.js'
import { renderSections } from '../views/sections.js'
import {
  highlightSearchText,
  formatStatusCounts,
  countItemsByKey,
  buildAgentIssueLines,
  buildAgentActionHints,
  buildAgentListIssueSummary,
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
import { AGENT } from '../i18n/zh.js'

const AGENT_ROLES = ['worker', 'explorer', 'reviewer', 'summarizer', 'general'] as const

function isAgentRole(value: string): value is (typeof AGENT_ROLES)[number] {
  return (AGENT_ROLES as readonly string[]).includes(value)
}

export function createAgentCommands(
  sessionManager: SessionManager,
  getRunDisplayStatus: GetRunDisplayStatus,
  router?: import('../callbacks/router.js').CallbackRouter,
): Composer<Context> {
  const composer = new Composer<Context>()

  composer.command('agent', async (ctx) => {
    if (!(await ensureAuthorized(ctx))) {
      return
    }

    const args = ctx.message?.text?.trim().split(/\s+/).slice(1) ?? []
    const action = args[0]?.toLowerCase()
    const userId = getUserId(ctx)
    const chatId = getChatId(ctx)

    if (!action) {
      await ctx.reply('🤖 Agent 管理', {
        reply_markup: buildMenuKeyboard([
          { label: '📋 列表', data: 'a:list:1' },
          { label: '🚀 Spawn', data: 'a:spawn' },
          { label: '🔙 主菜单', data: 'g:menu' },
        ]),
      })
      return
    }

    if (action === 'spawn') {
      if (args.length === 1) {
        await ctx.reply(
          '选择 Agent 角色:',
          { reply_markup: buildSpawnRoleKeyboard() },
        )
        return
      }
      await handleSpawn(ctx, args, userId, chatId, sessionManager)
      return
    }

    if (action === 'cancel') {
      await handleCancel(ctx, args, userId, chatId, sessionManager)
      return
    }

    if (action === 'show') {
      await handleShow(ctx, args, userId, chatId, sessionManager, getRunDisplayStatus)
      return
    }

    if (action === 'apply') {
      await handleApply(ctx, args, userId, chatId, sessionManager, getRunDisplayStatus)
      return
    }

    if (action === 'where') {
      await handleWhere(ctx, args, userId, chatId, sessionManager)
      return
    }

    if (action === 'search') {
      await handleSearch(ctx, args, userId, chatId, sessionManager)
      return
    }

    await handleList(ctx, args, action, userId, chatId, sessionManager)
  })

  router?.register('a', async (ctx, parts) => {
    await handleAgentCallback(ctx, parts, sessionManager, getRunDisplayStatus)
  })

  return composer
}
async function handleSpawn(
  ctx: Context,
  args: string[],
  userId: string,
  chatId: string,
  sessionManager: SessionManager,
): Promise<void> {
  const role = args[1]?.toLowerCase()
  const task = args.slice(2).join(' ').trim()

  if (!role || !isAgentRole(role)) {
    await ctx.reply(AGENT.SPAWN_USAGE_ROLES(AGENT_ROLES.join('|')))
    return
  }

  if (!task) {
    await ctx.reply(AGENT.SPAWN_USAGE)
    return
  }

  try {
    const agent = await sessionManager.spawnAgent(userId, chatId, role, task)
    await ctx.reply(
      [
        AGENT.CREATED(agent.id),
        `role: ${agent.role}`,
        `thread: ${agent.threadId}`,
        `task: ${agent.task}`,
        AGENT.TASK_STARTED,
      ].join('\n'),
    )
  } catch (error) {
    await ctx.reply(AGENT.CREATE_FAIL((error as Error).message))
  }
}

async function handleCancel(
  ctx: Context,
  args: string[],
  userId: string,
  chatId: string,
  sessionManager: SessionManager,
): Promise<void> {
  const reference = args[1]?.trim()

  if (!reference) {
    await ctx.reply(AGENT.CANCEL_USAGE)
    return
  }

  try {
    const { agent, cancel } = await sessionManager.cancelAgent(userId, chatId, reference)
    await ctx.reply(
      [
        AGENT.CANCELLED(agent.id),
        `role: ${agent.role}`,
        `thread: ${agent.threadId}`,
        `running killed: ${cancel.killedRunning}`,
        `queued cleared: ${cancel.clearedQueued}`,
      ].join('\n'),
    )
  } catch (error) {
    await ctx.reply(AGENT.CANCEL_FAIL((error as Error).message))
  }
}

async function handleShow(
  ctx: Context,
  args: string[],
  userId: string,
  chatId: string,
  sessionManager: SessionManager,
  getRunDisplayStatus: GetRunDisplayStatus,
): Promise<void> {
  const reference = args[1]?.trim()

  if (!reference) {
    await ctx.reply(AGENT.SHOW_USAGE)
    return
  }

  const details = await sessionManager.getAgentDetails(userId, chatId, reference)
  if (!details) {
    await ctx.reply(AGENT.NOT_FOUND(reference))
    return
  }

  await ctx.reply(renderSections([
    {
      title: 'Identity',
      lines: [
        `agent: ${details.agent.agent.id}`,
        `role: ${details.agent.agent.role}`,
        `task: ${details.agent.agent.task}`,
      ],
    },
    {
      title: 'Status',
      lines: [
        `status: ${details.agent.status.effective}`,
        `phase: ${details.agent.status.phase}`,
        `writeback: ${details.agent.writeback.mode}`,
        `writeback summary: ${details.agent.writeback.summary}`,
        details.agent.agent.writebackRunId
          ? `writeback run: ${details.agent.agent.writebackRunId} (${details.writebackRun?.status ?? 'missing'})`
          : undefined,
        details.agent.status.lastError ? `lastError: ${details.agent.status.lastError}` : undefined,
      ],
    },
    {
      title: 'Top Issues',
      lines: buildAgentIssueLines(details, getRunDisplayStatus),
    },
    {
      title: 'Links',
      lines: [
        `project: ${details.project?.name ?? details.agent.agent.projectId}`,
        `parent thread: ${details.parentThread?.title ?? details.agent.relation.parentThreadId}`,
        `child thread: ${details.childThread?.title ?? details.agent.relation.childThreadId}`,
        details.agent.resultPreview.text ? `preview: ${details.agent.resultPreview.text}` : undefined,
      ],
    },
    {
      title: 'Actions',
      lines: [
        `jump: /agent where ${details.agent.agent.id}`,
        ...buildAgentActionHints({
          id: details.agent.agent.id,
          parentThreadId: details.agent.relation.parentThreadId,
          role: details.agent.agent.role,
          task: details.agent.agent.task,
          status: details.agent.status.effective,
          lastError: details.agent.status.lastError,
          writebackMode: details.agent.writeback.mode,
          writebackRunId: details.agent.agent.writebackRunId,
        }),
        details.project ? `next: /project show` : undefined,
        details.parentThread ? `next: /thread use ${details.parentThread.id}` : undefined,
        details.agent.agent.writebackRunId ? `next: /run show ${details.agent.agent.writebackRunId}` : undefined,
      ],
    },
  ]))
}

async function handleApply(
  ctx: Context,
  args: string[],
  userId: string,
  chatId: string,
  sessionManager: SessionManager,
  getRunDisplayStatus: GetRunDisplayStatus,
): Promise<void> {
  const reference = args[1]?.trim()

  if (!reference) {
    await ctx.reply(AGENT.APPLY_USAGE)
    return
  }

  try {
    const result = await sessionManager.applyAgentWriteback(userId, chatId, reference)
    await ctx.reply(
      [
        AGENT.APPLY_OK(result.agent.agent.id),
        `parent thread: ${result.parentThread.title}`,
        `run: ${result.run.context.runId}`,
        `status: ${getRunDisplayStatus(result.run)}`,
      ].join('\n'),
    )
  } catch (error) {
    await ctx.reply(AGENT.APPLY_FAIL((error as Error).message))
  }
}

async function handleWhere(
  ctx: Context,
  args: string[],
  userId: string,
  chatId: string,
  sessionManager: SessionManager,
): Promise<void> {
  const reference = args[1]?.trim()
  const pageSize = parsePositiveInt(args[2]) ?? LIST_PAGE_SIZE

  if (!reference) {
    await ctx.reply(AGENT.WHERE_USAGE)
    return
  }

  const state = await sessionManager.getAgentState(userId, chatId)
  if (!state.parentThread) {
    await ctx.reply(AGENT.NO_ACTIVE_THREAD)
    return
  }

  const agentIndex = resolveIndexedItemIndex(
    state.agents,
    reference,
    (agent) => [agent.id, agent.threadId],
  )
  if (agentIndex < 0) {
    await ctx.reply(AGENT.NOT_FOUND(reference))
    return
  }

  const page = Math.floor(agentIndex / pageSize) + 1
  const agent = state.agents[agentIndex]
  await ctx.reply(
    [
      `agent: ${agent.id}`,
      `parent thread: ${state.parentThread.title}`,
      `index: #${agentIndex + 1}/${state.agents.length}`,
      `page: ${page}`,
      `pageSize: ${pageSize}`,
      `jump: /agent list ${page} ${pageSize}`,
    ].join('\n'),
  )
}

async function handleSearch(
  ctx: Context,
  args: string[],
  userId: string,
  chatId: string,
  sessionManager: SessionManager,
): Promise<void> {
  const { query, page, pageSize, start, end } = parseSearchPaginationArgs(args.slice(1))
  if (!query) {
    await ctx.reply(AGENT.SEARCH_USAGE)
    return
  }

  const state = await sessionManager.searchAgents(userId, chatId, query)
  if (!state.parentThread) {
    await ctx.reply(AGENT.NO_ACTIVE_THREAD)
    return
  }

  const agents = state.agents.slice(start, end)
  const total = state.agents.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const hasPrev = start > 0
  const hasNext = end < total

  if (total === 0) {
    await ctx.reply(AGENT.NO_MATCH(query))
    return
  }

  await ctx.reply(renderSections([
    {
      title: 'Scope',
      lines: [
        `agent search: ${query}`,
        `parent thread: ${state.parentThread.title}`,
        `page ${page}/${totalPages}, pageSize ${pageSize}`,
        `total: ${total}`,
        `status counts: ${formatStatusCounts(countItemsByKey(state.agents, (agent) => agent.status))}`,
      ],
    },
    {
      title: 'Top Issues',
      lines: buildAgentListIssueSummary(state.agents),
    },
    {
      title: 'Actions',
      lines: [
        hasPrev ? `prev: /agent search ${query} ${Math.max(1, page - 1)} ${pageSize}` : undefined,
        hasNext ? `next: /agent search ${query} ${page + 1} ${pageSize}` : undefined,
      ],
    },
    {
      title: 'Results',
      lines: agents.map(
        (agent, index) =>
          `${start + index + 1}. [${agent.status}] ${highlightSearchText(agent.id, query)} (${highlightSearchText(agent.role, query)})\nthread: ${highlightSearchText(agent.threadId, query)}\ntask: ${highlightSearchText(agent.task, query)}`,
      ),
    },
  ]))
}

async function handleList(
  ctx: Context,
  args: string[],
  action: string,
  userId: string,
  chatId: string,
  sessionManager: SessionManager,
): Promise<void> {
  const state = await sessionManager.getAgentState(userId, chatId)
  const { page, pageSize, start, end } = parsePaginationArgs(
    action === 'list' ? args.slice(1) : args,
  )
  const agents = state.agents.slice(start, end)
  const total = state.agents.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const hasPrev = start > 0
  const hasNext = end < total

  if (!state.parentThread) {
    await ctx.reply(AGENT.NO_ACTIVE_THREAD)
    return
  }

  if (state.agents.length === 0) {
    await ctx.reply(
      [
        `parent thread: ${state.parentThread.title}`,
        AGENT.NO_AGENTS,
      ].join('\n'),
    )
    return
  }

  await ctx.reply(renderSections([
    {
      title: 'Scope',
      lines: [
        `parent thread: ${state.parentThread.title}`,
        `page ${page}/${totalPages}, pageSize ${pageSize}`,
        `total: ${total}`,
        `status counts: ${formatStatusCounts(countItemsByKey(state.agents, (agent) => agent.status))}`,
      ],
    },
    {
      title: 'Top Issues',
      lines: buildAgentListIssueSummary(state.agents),
    },
    {
      title: 'Actions',
      lines: [
        hasPrev ? `prev: /agent list ${Math.max(1, page - 1)} ${pageSize}` : undefined,
        hasNext ? `next: /agent list ${page + 1} ${pageSize}` : undefined,
      ],
    },
    {
      title: 'Results',
      lines: agents.map(
        (agent, index) =>
          `${start + index + 1}. [${agent.status}] ${agent.id} (${agent.role})\nthread: ${agent.threadId}\ntask: ${agent.task}`,
      ),
    },
  ]))
}

// ---------------------------------------------------------------------------
// Inline keyboard helpers
// ---------------------------------------------------------------------------

const AGENT_STATUS_EMOJI: Record<AgentStatus, string> = {
  completed: '🟢',
  running: '🔵',
  queued: '🟡',
  failed: '🔴',
  cancelled: '⚪',
}

function agentStatusEmoji(status: string): string {
  return AGENT_STATUS_EMOJI[status as AgentStatus] ?? '⚪'
}

/** First 16 chars of an ID — used in callback_data to stay under 64 bytes. */
function shortId(id: string): string {
  return id.slice(0, 16)
}

function buildSpawnRoleKeyboard(): InlineKeyboard {
  return buildMenuKeyboard([
    { label: '👷 Worker', data: 'a:role:worker' },
    { label: '🔍 Explorer', data: 'a:role:explorer' },
    { label: '📝 Reviewer', data: 'a:role:reviewer' },
    { label: '📊 Summarizer', data: 'a:role:summarizer' },
    { label: '🎯 General', data: 'a:role:general' },
  ])
}

function buildAgentListKeyboard(
  agents: Array<{ id: string; role: string; task: string; status: string }>,
  page: number,
  totalPages: number,
): InlineKeyboard {
  const items = agents.map((agent) => ({
    label: `${agentStatusEmoji(agent.status)} ${agent.role}: ${agent.task}`,
    data: `a:show:${shortId(agent.id)}`,
  }))
  const kb = buildListKeyboard(items, page, totalPages, 'a:list')
  kb.text('🔙 返回', 'a:menu').row()
  return kb
}

function buildAgentDetailKeyboard(
  agentId: string,
  status: string,
): InlineKeyboard {
  const actions: Array<{ label: string; data: string }> = []
  const sid = shortId(agentId)
  if (status === 'completed') {
    actions.push({ label: '✅ Apply', data: `a:apply:${sid}` })
  }
  if (status === 'queued' || status === 'running') {
    actions.push({ label: '❌ Cancel', data: `a:cancel:${sid}` })
  }
  actions.push({ label: '💬 View Thread', data: `a:thread:${sid}` })
  const kb = buildActionKeyboard(actions)
  kb.text('🔙 返回列表', 'a:list:1').row()
  return kb
}

function buildCancelConfirmKeyboard(
  agentId: string,
): InlineKeyboard {
  return buildConfirmKeyboard(
    `a:cancel_y:${shortId(agentId)}`,
    `a:cancel_n:${shortId(agentId)}`,
  )
}

function renderAgentDetailText(
  details: NonNullable<Awaited<ReturnType<SessionManager['getAgentDetails']>>>,
): string {
  return renderSections([
    {
      title: 'Identity',
      lines: [
        `role: ${details.agent.agent.role}`,
        `task: ${details.agent.agent.task}`,
        details.agent.relation.parentThread
          ? `parent: ${details.agent.relation.parentThread.title}`
          : undefined,
      ],
    },
    {
      title: 'Status',
      lines: [
        `status: ${details.agent.status.effective}`,
        details.agent.resultPreview.text
          ? `preview: ${details.agent.resultPreview.text}`
          : undefined,
      ],
    },
  ])
}

// ---------------------------------------------------------------------------
// Callback handler
// ---------------------------------------------------------------------------

async function safeEditAgent(
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

async function handleAgentCallback(
  ctx: Context,
  parts: string[],
  sessionManager: SessionManager,
  getRunDisplayStatus: GetRunDisplayStatus,
): Promise<void> {
  const action = parts[0]
  const userId = getUserId(ctx)
  const chatId = getChatId(ctx)

  // a:menu — show agent management menu
  if (action === 'menu') {
    await safeEditAgent(ctx, '🤖 Agent 管理', buildMenuKeyboard([
      { label: '📋 列表', data: 'a:list:1' },
      { label: '🚀 Spawn', data: 'a:spawn' },
      { label: '🔙 主菜单', data: 'g:menu' },
    ]))
    return
  }

  // a:spawn — show role selection
  if (action === 'spawn') {
    await safeEditAgent(ctx, '选择 Agent 角色:', buildSpawnRoleKeyboard())
    return
  }

  // a:role:ROLE — prompt user to type task
  if (action === 'role') {
    const role = parts[1]
    await safeEditAgent(
      ctx,
      `已选择角色: ${role}\n\n请发送任务描述:\n/agent spawn ${role} <你的任务>`,
    )
    return
  }

  // a:list:PAGE — paginated agent list
  if (action === 'list') {
    const page = parsePositiveInt(parts[1]) ?? 1
    const state = await sessionManager.getAgentState(userId, chatId)

    if (!state.parentThread) {
      await safeEditAgent(ctx, AGENT.NO_ACTIVE_THREAD)
      return
    }

    if (state.agents.length === 0) {
      await safeEditAgent(
        ctx,
        `parent thread: ${state.parentThread.title}\n${AGENT.NO_AGENTS}`,
        buildMenuKeyboard([{ label: '🔙 返回', data: 'a:menu' }]),
      )
      return
    }

    const total = state.agents.length
    const pageSize = LIST_PAGE_SIZE
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const safePage = Math.min(page, totalPages)
    const start = (safePage - 1) * pageSize
    const pageAgents = state.agents.slice(start, start + pageSize)

    const text = `🤖 Agents (page ${safePage}/${totalPages})`
    const kb = buildAgentListKeyboard(pageAgents, safePage, totalPages)
    await safeEditAgent(ctx, text, kb)
    return
  }

  // a:show:ID — agent detail view
  if (action === 'show') {
    const ref = parts[1]
    if (!ref) return
    const details = await sessionManager.getAgentDetails(userId, chatId, ref)
    if (!details) {
      await safeEditAgent(ctx, AGENT.NOT_FOUND(ref))
      return
    }
    const text = renderAgentDetailText(details)
    const kb = buildAgentDetailKeyboard(
      details.agent.agent.id,
      details.agent.status.effective,
    )
    await safeEditAgent(ctx, text, kb)
    return
  }

  // a:apply:ID — apply writeback
  if (action === 'apply') {
    const ref = parts[1]
    if (!ref) return
    try {
      const result = await sessionManager.applyAgentWriteback(userId, chatId, ref)
      await safeEditAgent(
        ctx,
        [
          AGENT.APPLY_OK(result.agent.agent.id),
          `parent thread: ${result.parentThread.title}`,
          `run: ${result.run.context.runId}`,
          `status: ${getRunDisplayStatus(result.run)}`,
        ].join('\n'),
        buildMenuKeyboard([{ label: '🔙 返回列表', data: 'a:list:1' }]),
      )
    } catch (error) {
      await safeEditAgent(
        ctx,
        AGENT.APPLY_FAIL((error as Error).message),
        buildMenuKeyboard([{ label: '🔙 返回', data: `a:show:${ref}` }]),
      )
    }
    return
  }

  // a:cancel:ID — show confirmation
  if (action === 'cancel') {
    const ref = parts[1]
    if (!ref) return
    const details = await sessionManager.getAgentDetails(userId, chatId, ref)
    if (!details) {
      await safeEditAgent(ctx, AGENT.NOT_FOUND(ref))
      return
    }
    const label = `${details.agent.agent.role}: ${truncateLabel(details.agent.agent.task, 30)}`
    await safeEditAgent(
      ctx,
      `确定要取消 agent "${label}" 吗？`,
      buildCancelConfirmKeyboard(details.agent.agent.id),
    )
    return
  }

  // a:cancel_y:ID — confirmed cancel
  if (action === 'cancel_y') {
    const ref = parts[1]
    if (!ref) return
    try {
      const { agent, cancel } = await sessionManager.cancelAgent(userId, chatId, ref)
      await safeEditAgent(
        ctx,
        [
          AGENT.CANCELLED(agent.id),
          `role: ${agent.role}`,
          `running killed: ${cancel.killedRunning}`,
          `queued cleared: ${cancel.clearedQueued}`,
        ].join('\n'),
        buildMenuKeyboard([{ label: '🔙 返回列表', data: 'a:list:1' }]),
      )
    } catch (error) {
      await safeEditAgent(
        ctx,
        AGENT.CANCEL_FAIL((error as Error).message),
        buildMenuKeyboard([{ label: '🔙 返回', data: `a:show:${ref}` }]),
      )
    }
    return
  }

  // a:cancel_n:ID — cancel aborted, back to detail
  if (action === 'cancel_n') {
    const ref = parts[1]
    if (!ref) return
    const details = await sessionManager.getAgentDetails(userId, chatId, ref)
    if (!details) {
      await safeEditAgent(ctx, AGENT.NOT_FOUND(ref))
      return
    }
    const text = renderAgentDetailText(details)
    const kb = buildAgentDetailKeyboard(
      details.agent.agent.id,
      details.agent.status.effective,
    )
    await safeEditAgent(ctx, text, kb)
    return
  }

  // a:thread:ID — show thread link (jump to child thread)
  if (action === 'thread') {
    const ref = parts[1]
    if (!ref) return
    const details = await sessionManager.getAgentDetails(userId, chatId, ref)
    if (!details) {
      await safeEditAgent(ctx, AGENT.NOT_FOUND(ref))
      return
    }
    const threadId = details.agent.relation.childThreadId
    await safeEditAgent(
      ctx,
      `Agent 子线程:\n/thread use ${threadId}`,
      buildMenuKeyboard([{ label: '🔙 返回', data: `a:show:${ref}` }]),
    )
    return
  }
}
