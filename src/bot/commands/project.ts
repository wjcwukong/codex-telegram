import { Composer, type Context } from 'grammy'
import type { SessionManager } from '../../../session-manager.js'
import type { ProjectSourceMode, AgentParentSourceOverrideMode, ProjectRecord } from '../../../models.js'
import {
  LIST_PAGE_SIZE,
  parsePositiveInt,
  parseListControls,
  parseSearchPaginationArgs,
  sortProjectsForView,
} from '../views/pagination.js'
import { renderSections } from '../views/sections.js'
import {
  replyInChunks,
  highlightSearchText,
  renderProjectSyncStatus,
  renderProjectSyncRun,
  buildProjectIssueLines,
  originatorBadge,
} from '../views/formatting.js'
import {
  buildMenuKeyboard,
  buildListKeyboard,
  buildActionKeyboard,
  buildConfirmKeyboard,
} from '../views/keyboards.js'
import { PROJECT } from '../i18n/zh.js'
import { ensureAuthorized, getUserId, getChatId } from '../middleware/auth.js'

function isProjectSourceMode(
  value: string | undefined,
): value is ProjectSourceMode {
  return value === 'prefer' || value === 'force' || value === 'policy-default'
}

function isAgentParentSourceOverrideMode(
  value: string | undefined,
): value is AgentParentSourceOverrideMode {
  return value === 'allow' || value === 'deny' || value === 'policy-default'
}

/** Truncate a project ID to fit inside 64-byte callback data. */
function shortId(id: string): string {
  return id.slice(0, 20)
}

/** Safely edit a callback message; swallow "message is not modified" errors. */
async function safeEdit(
  ctx: Context,
  text: string,
  extra?: { reply_markup?: import('grammy').InlineKeyboard },
): Promise<void> {
  try {
    await ctx.editMessageText(text, extra)
  } catch (err: unknown) {
    const msg = (err as { description?: string }).description ?? ''
    if (!msg.includes('not modified')) throw err
  }
}

// ── Keyboard builders for project views ──────────────────────────────────────

function buildProjectMenuKeyboard() {
  return buildMenuKeyboard([
    { label: '📋 列表', data: 'p:list:1' },
    { label: '➕ 新建', data: 'p:new' },
    { label: '📊 详情', data: 'p:show' },
    { label: '🔄 同步', data: 'p:sync' },
    { label: '⚙️ 设置', data: 'p:settings' },
  ])
}

function buildProjectListKeyboard(
  projects: ProjectRecord[],
  page: number,
  totalPages: number,
  start: number,
  currentId?: string,
  desktopProjectIds?: Set<string>,
) {
  const items = projects.map((p, i) => {
    const idx = start + i + 1
    const status = currentId === p.id ? ' ✅' : p.archivedAt ? ' 📦' : ''
    const desktop = desktopProjectIds?.has(p.id) ? ' 📱' : ''
    return { label: `📁 ${idx}. ${p.name}${status}${desktop}`, data: `p:use:${shortId(p.id)}` }
  })
  const kb = buildListKeyboard(items, page, totalPages, 'p:list')
  kb.text('🔙 返回主菜单', 'p:menu').row()
  return kb
}

function buildProjectDetailKeyboard(project: ProjectRecord) {
  const sid = shortId(project.id)
  return buildActionKeyboard([
    { label: '📝 重命名', data: 'p:rename' },
    { label: '📦 归档', data: `p:archive:${sid}` },
    { label: '🗑 删除', data: `p:del:${sid}` },
    { label: '🔧 设置源', data: `p:setsrc:${sid}` },
    { label: '🔄 同步', data: 'p:sync' },
    { label: '➕ 新线程', data: 't:new' },
    { label: '📋 线程列表', data: 't:list:1' },
    { label: '🔙 返回列表', data: 'p:list:1' },
  ])
}

function buildSettingsKeyboard(project: ProjectRecord) {
  const awb = project.agentAutoWritebackEnabled ? 'on' : 'off'
  return buildActionKeyboard([
    { label: `源: ${project.defaultSourceId} ▸`, data: `p:setsrc:${shortId(project.id)}` },
    { label: `模式: ${project.sourceMode} ▸`, data: 'p:setmode' },
    { label: `Agent覆盖: ${project.agentSourceOverrideMode} ▸`, data: 'p:setoverride' },
    { label: `自动回写: ${awb} ▸`, data: 'p:setawb' },
    { label: '🔙 返回', data: 'p:show' },
  ])
}

function renderProjectDetailText(
  details: {
    project: ProjectRecord
    defaultSource?: { id: string }
    threadCount: number
    originatorCounts?: Map<string, number>
    currentThread?: { title: string }
    sources: Array<{ id: string }>
  },
): string {
  let threadLine = `threads: ${details.threadCount}`
  if (details.originatorCounts && details.originatorCounts.size > 0) {
    const parts: string[] = []
    for (const [orig, count] of details.originatorCounts) {
      parts.push(`${originatorBadge(orig)}${count}`)
    }
    threadLine += ` (${parts.join(' ')})`
  }

  return renderSections([
    {
      title: 'Identity',
      lines: [
        `name: ${details.project.name}`,
        `cwd: ${details.project.cwd}`,
      ],
    },
    {
      title: 'Status',
      lines: [
        `source: ${details.defaultSource?.id ?? details.project.defaultSourceId}`,
        threadLine,
        details.currentThread
          ? `current thread: ${details.currentThread.title}`
          : undefined,
      ],
    },
  ])
}

async function handleSearch(
  ctx: Context,
  args: string[],
  sessionManager: SessionManager,
  userId: string,
  chatId: string,
): Promise<void> {
  const { query, page, pageSize, start, end, sort } = parseSearchPaginationArgs(args)

  if (!query) {
    await ctx.reply(PROJECT.SEARCH_USAGE)
    return
  }

  const state = await sessionManager.searchProjects(userId, chatId, query)
  const orderedProjects = sortProjectsForView(state.projects, sort)
  const projects = orderedProjects.slice(start, end)
  const total = orderedProjects.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const hasPrev = start > 0
  const hasNext = end < total
  const currentProjectIndex = state.currentProject
    ? orderedProjects.findIndex((project) => project.id === state.currentProject?.id)
    : -1
  const currentProjectOnPage =
    currentProjectIndex >= start && currentProjectIndex < end
  if (state.projects.length === 0) {
    await ctx.reply(PROJECT.NO_MATCH(query))
    return
  }

  await ctx.reply(
    [
      `project search: ${query}`,
      `sort: ${sort}`,
      `page ${page}/${totalPages}, pageSize ${pageSize}`,
      state.currentProject
        ? `current: ${state.currentProject.name} (${currentProjectIndex >= 0 ? `#${currentProjectIndex + 1}${currentProjectOnPage ? ', on this page' : ', not on this page'}` : 'not in results'})`
        : 'current: -',
      `total: ${total}`,
      hasPrev ? `prev: /project search ${query} ${Math.max(1, page - 1)} ${pageSize} --sort ${sort}` : undefined,
      hasNext ? `next: /project search ${query} ${page + 1} ${pageSize} --sort ${sort}` : undefined,
      ...projects.map(
        (project, index) =>
          `${state.currentProject?.id === project.id ? '* ' : ''}${start + index + 1}. [${project.defaultSourceId}] ${highlightSearchText(project.name, query)}${project.archivedAt ? ' [archived]' : ''}\n${highlightSearchText(project.cwd, query)}`,
      ),
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

async function handleSync(
  ctx: Context,
  args: string[],
  sessionManager: SessionManager,
  userId: string,
  chatId: string,
): Promise<void> {
  if (args[0]?.toLowerCase() === 'status') {
    const status = await sessionManager.getImportStatus()
    if (status.sources.length === 0) {
      await ctx.reply(PROJECT.NO_IMPORT_SOURCE)
      return
    }

    await replyInChunks(ctx, renderProjectSyncStatus(status))
    return
  }

  const before = await sessionManager.getProjectState(userId, chatId)
  const details = await sessionManager.syncProjectsDetailed()
  const after = await sessionManager.getProjectState(userId, chatId)

  await replyInChunks(
    ctx,
    renderProjectSyncRun(details, {
      projectsBefore: before.projects.length,
      projectsAfter: after.projects.length,
      currentProjectName: after.currentProject?.name,
      currentProjectLocation: after.currentProjectLocation,
    }),
  )
}

async function handleWhere(
  ctx: Context,
  args: string[],
  sessionManager: SessionManager,
  userId: string,
  chatId: string,
): Promise<void> {
  const state = await sessionManager.getProjectState(userId, chatId)
  const pageSize = parsePositiveInt(args[0]) ?? LIST_PAGE_SIZE
  if (!state.currentProject) {
    await ctx.reply(PROJECT.NO_ACTIVE)
    return
  }

  const index = state.projects.findIndex((project) => project.id === state.currentProject?.id)
  if (index < 0) {
    await ctx.reply(PROJECT.NOT_IN_LIST(state.currentProject.name))
    return
  }

  const page = Math.floor(index / pageSize) + 1
  await ctx.reply(
    [
      `current project: ${state.currentProject.name}`,
      `index: #${index + 1}/${state.projects.length}`,
      `page: ${page}`,
      `pageSize: ${pageSize}`,
      `jump: /project list ${page} ${pageSize}`,
    ].join('\n'),
  )
}

async function handleShow(
  ctx: Context,
  sessionManager: SessionManager,
  userId: string,
  chatId: string,
): Promise<void> {
  const details = await sessionManager.getProjectDetails(userId, chatId)

  if (!details.project) {
    await ctx.reply(PROJECT.NO_ACTIVE)
    return
  }

  const text = renderSections([
    {
      title: 'Identity',
      lines: [
        `project: ${details.project.name}`,
        `id: ${details.project.id}`,
        `cwd: ${details.project.cwd}`,
      ],
    },
    {
      title: 'Status',
      lines: [
        `default source: ${details.defaultSource?.id ?? details.project.defaultSourceId}`,
        `source mode: ${details.project.sourceMode}`,
        `agent source override: ${details.project.agentSourceOverrideMode}`,
        `agent auto writeback: ${details.project.agentAutoWritebackEnabled}`,
        `threads: ${details.threadCount}`,
        details.currentThread
          ? `current thread: ${details.currentThread.title}`
          : 'current thread: -',
      ],
    },
    {
      title: 'Top Issues',
      lines: buildProjectIssueLines(details),
    },
    {
      title: 'Links',
      lines: [
        `available sources: ${details.sources.map((source) => source.id).join(', ')}`,
      ],
    },
  ])

  await ctx.reply(text, { reply_markup: buildProjectDetailKeyboard(details.project) })
}

async function handleList(
  ctx: Context,
  args: string[],
  sessionManager: SessionManager,
  userId: string,
  chatId: string,
): Promise<void> {
  const state = await sessionManager.getProjectState(userId, chatId)
  const { page, pageSize, start, end, sort } = parseListControls(args)
  const orderedProjects = sortProjectsForView(state.projects, sort)
  const projects = orderedProjects.slice(start, end)
  const total = orderedProjects.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  if (state.projects.length === 0) {
    await ctx.reply(PROJECT.NO_AVAILABLE)
    return
  }

  const desktopProjectIds = sessionManager.getDesktopProjectIds()
  const text = `📋 Projects (page ${page}/${totalPages}, total ${total})`
  const keyboard = buildProjectListKeyboard(
    projects,
    page,
    totalPages,
    start,
    state.currentProject?.id,
    desktopProjectIds,
  )
  await ctx.reply(text, { reply_markup: keyboard })
}

async function handleNew(
  ctx: Context,
  args: string[],
  sessionManager: SessionManager,
  userId: string,
  chatId: string,
): Promise<void> {
  const name = args[0]?.trim()
  const cwd = args[1]?.trim()

  if (!name) {
    await ctx.reply(PROJECT.NEW_USAGE)
    return
  }

  try {
    const project = await sessionManager.createProject(userId, chatId, name, cwd)
    await ctx.reply(PROJECT.CREATED(project.name, project.cwd))
  } catch (error) {
    await ctx.reply(PROJECT.CREATE_FAIL((error as Error).message))
  }
}

async function handleRename(
  ctx: Context,
  args: string[],
  sessionManager: SessionManager,
  userId: string,
  chatId: string,
): Promise<void> {
  const newName = args.join(' ').trim()

  if (!newName) {
    await ctx.reply(PROJECT.RENAME_USAGE)
    return
  }

  try {
    const project = await sessionManager.renameCurrentProject(
      userId,
      chatId,
      newName,
    )
    await ctx.reply(PROJECT.RENAMED(project.name, project.cwd))
  } catch (error) {
    await ctx.reply(PROJECT.RENAME_FAIL((error as Error).message))
  }
}

async function handleArchive(
  ctx: Context,
  sessionManager: SessionManager,
  userId: string,
  chatId: string,
): Promise<void> {
  try {
    const project = await sessionManager.archiveCurrentProject(userId, chatId)
    await ctx.reply(PROJECT.ARCHIVED(project.name, project.cwd))
  } catch (error) {
    await ctx.reply(PROJECT.ARCHIVE_FAIL((error as Error).message))
  }
}

async function handleDelete(
  ctx: Context,
  sessionManager: SessionManager,
  userId: string,
  chatId: string,
): Promise<void> {
  try {
    const project = await sessionManager.deleteCurrentProject(userId, chatId)
    await ctx.reply(PROJECT.DELETED(project.name, project.cwd))
  } catch (error) {
    await ctx.reply(PROJECT.DELETE_FAIL((error as Error).message))
  }
}

async function handleSetSource(
  ctx: Context,
  args: string[],
  sessionManager: SessionManager,
  userId: string,
  chatId: string,
): Promise<void> {
  const sourceId = args[0]?.trim()

  if (!sourceId) {
    await ctx.reply(PROJECT.SET_SOURCE_USAGE)
    return
  }

  try {
    const { project, source } = await sessionManager.setCurrentProjectSource(
      userId,
      chatId,
      sourceId,
    )
    await ctx.reply(
      PROJECT.SET_SOURCE_OK(project.name, source.id, source.codexHome),
    )
  } catch (error) {
    await ctx.reply(PROJECT.SET_SOURCE_FAIL((error as Error).message))
  }
}

async function handleSetSourceMode(
  ctx: Context,
  args: string[],
  sessionManager: SessionManager,
  userId: string,
  chatId: string,
): Promise<void> {
  const sourceMode = args[0]?.trim()

  if (!isProjectSourceMode(sourceMode)) {
    await ctx.reply(PROJECT.SET_SOURCE_MODE_USAGE)
    return
  }

  try {
    const project = await sessionManager.setCurrentProjectSourceMode(
      userId,
      chatId,
      sourceMode,
    )
    await ctx.reply(PROJECT.SET_SOURCE_MODE_OK(project.name, project.sourceMode))
  } catch (error) {
    await ctx.reply(PROJECT.SET_SOURCE_MODE_FAIL((error as Error).message))
  }
}

async function handleSetAgentSourceOverride(
  ctx: Context,
  args: string[],
  sessionManager: SessionManager,
  userId: string,
  chatId: string,
): Promise<void> {
  const overrideMode = args[0]?.trim()

  if (!isAgentParentSourceOverrideMode(overrideMode)) {
    await ctx.reply(PROJECT.SET_AGENT_SOURCE_OVERRIDE_USAGE)
    return
  }

  try {
    const project = await sessionManager.setCurrentProjectAgentSourceOverrideMode(
      userId,
      chatId,
      overrideMode,
    )
    await ctx.reply(
      PROJECT.SET_AGENT_SOURCE_OVERRIDE_OK(project.name, project.agentSourceOverrideMode),
    )
  } catch (error) {
    await ctx.reply(PROJECT.SET_AGENT_SOURCE_OVERRIDE_FAIL((error as Error).message))
  }
}

async function handleSetAgentAutoWriteback(
  ctx: Context,
  args: string[],
  sessionManager: SessionManager,
  userId: string,
  chatId: string,
): Promise<void> {
  const value = args[0]?.trim().toLowerCase()

  if (value !== 'on' && value !== 'off') {
    await ctx.reply(PROJECT.SET_AGENT_AUTO_WRITEBACK_USAGE)
    return
  }

  try {
    const project = await sessionManager.setCurrentProjectAgentAutoWriteback(
      userId,
      chatId,
      value === 'on',
    )
    await ctx.reply(
      PROJECT.SET_AGENT_AUTO_WRITEBACK_OK(project.name, project.agentAutoWritebackEnabled),
    )
  } catch (error) {
    await ctx.reply(PROJECT.SET_AGENT_AUTO_WRITEBACK_FAIL((error as Error).message))
  }
}

async function handleUse(
  ctx: Context,
  args: string[],
  sessionManager: SessionManager,
  userId: string,
  chatId: string,
): Promise<void> {
  const reference = args.join(' ').trim()

  if (!reference) {
    await ctx.reply(PROJECT.USE_USAGE)
    return
  }

  try {
    const project = await sessionManager.switchProject(userId, chatId, reference)
    await ctx.reply(PROJECT.SWITCHED(project.name, project.cwd))
  } catch (error) {
    await ctx.reply(PROJECT.SWITCH_FAIL((error as Error).message))
  }
}

async function handleCurrent(
  ctx: Context,
  sessionManager: SessionManager,
  userId: string,
  chatId: string,
): Promise<void> {
  const state = await sessionManager.getProjectState(userId, chatId)
  const text = state.currentProject
    ? `当前 project: ${state.currentProject.name}\n路径: ${state.currentProject.cwd}`
    : PROJECT.CURRENT_NONE(state.projects.length)
  await ctx.reply(text, { reply_markup: buildProjectMenuKeyboard() })
}

export function createProjectCommands(
  sessionManager: SessionManager,
  router?: import('../callbacks/router.js').CallbackRouter,
): Composer<Context> {
  const composer = new Composer<Context>()

  composer.command('project', async (ctx) => {
    if (!(await ensureAuthorized(ctx))) {
      return
    }

    const args = ctx.message?.text?.trim().split(/\s+/).slice(1) ?? []
    const action = args[0]?.toLowerCase() ?? 'current'
    const userId = getUserId(ctx)
    const chatId = getChatId(ctx)

    if (action === 'search') {
      await handleSearch(ctx, args.slice(1), sessionManager, userId, chatId)
      return
    }

    if (action === 'sync') {
      await handleSync(ctx, args.slice(1), sessionManager, userId, chatId)
      return
    }

    if (action === 'where') {
      await handleWhere(ctx, args.slice(1), sessionManager, userId, chatId)
      return
    }

    if (action === 'show') {
      await handleShow(ctx, sessionManager, userId, chatId)
      return
    }

    if (action === 'list') {
      await handleList(ctx, args.slice(1), sessionManager, userId, chatId)
      return
    }

    if (action === 'new') {
      await handleNew(ctx, args.slice(1), sessionManager, userId, chatId)
      return
    }

    if (action === 'rename') {
      await handleRename(ctx, args.slice(1), sessionManager, userId, chatId)
      return
    }

    if (action === 'archive') {
      await handleArchive(ctx, sessionManager, userId, chatId)
      return
    }

    if (action === 'delete') {
      await handleDelete(ctx, sessionManager, userId, chatId)
      return
    }

    if (action === 'set-source') {
      await handleSetSource(ctx, args.slice(1), sessionManager, userId, chatId)
      return
    }

    if (action === 'set-source-mode') {
      await handleSetSourceMode(ctx, args.slice(1), sessionManager, userId, chatId)
      return
    }

    if (action === 'set-agent-source-override') {
      await handleSetAgentSourceOverride(ctx, args.slice(1), sessionManager, userId, chatId)
      return
    }

    if (action === 'set-agent-auto-writeback') {
      await handleSetAgentAutoWriteback(ctx, args.slice(1), sessionManager, userId, chatId)
      return
    }

    if (action === 'use') {
      await handleUse(ctx, args.slice(1), sessionManager, userId, chatId)
      return
    }

    if (action === 'current') {
      await handleCurrent(ctx, sessionManager, userId, chatId)
      return
    }

    await ctx.reply(PROJECT.USAGE_HELP)
  })

  // ── Callback handlers for inline keyboard interactions ─────────────────────
  router?.register('p', async (ctx, parts) => {
    const action = parts[0]
    const userId = getUserId(ctx)
    const chatId = getChatId(ctx)

    // ── Main menu ──────────────────────────────────────────────────────────
    if (action === 'menu') {
      const state = await sessionManager.getProjectState(userId, chatId)
      const text = state.currentProject
        ? `当前 project: ${state.currentProject.name}\n路径: ${state.currentProject.cwd}`
        : PROJECT.CURRENT_NONE(state.projects.length)
      await safeEdit(ctx, text, { reply_markup: buildProjectMenuKeyboard() })
      return
    }

    // ── List view with pagination ──────────────────────────────────────────
    if (action === 'list') {
      const page = parsePositiveInt(parts[1]) ?? 1
      const state = await sessionManager.getProjectState(userId, chatId)
      const orderedProjects = sortProjectsForView(state.projects, 'recent')
      const total = orderedProjects.length

      if (total === 0) {
        await safeEdit(ctx, PROJECT.NO_AVAILABLE)
        return
      }

      const pageSize = LIST_PAGE_SIZE
      const totalPages = Math.max(1, Math.ceil(total / pageSize))
      const safePage = Math.min(page, totalPages)
      const start = (safePage - 1) * pageSize
      const end = start + pageSize
      const projects = orderedProjects.slice(start, end)

      const text = `📋 Projects (page ${safePage}/${totalPages}, total ${total})`
      const desktopIds = sessionManager.getDesktopProjectIds()
      const keyboard = buildProjectListKeyboard(
        projects,
        safePage,
        totalPages,
        start,
        state.currentProject?.id,
        desktopIds,
      )
      await safeEdit(ctx, text, { reply_markup: keyboard })
      return
    }

    // ── Show / detail view ─────────────────────────────────────────────────
    if (action === 'show') {
      const details = await sessionManager.getProjectDetails(userId, chatId)
      if (!details.project) {
        await safeEdit(ctx, PROJECT.NO_ACTIVE)
        return
      }
      const text = renderProjectDetailText(details as Parameters<typeof renderProjectDetailText>[0])
      await safeEdit(ctx, text, { reply_markup: buildProjectDetailKeyboard(details.project) })
      return
    }

    // ── Switch project (use) ───────────────────────────────────────────────
    if (action === 'use') {
      const reference = parts[1]
      if (!reference) return
      try {
        const project = await sessionManager.switchProject(userId, chatId, reference)
        const details = await sessionManager.getProjectDetails(userId, chatId)
        const text = renderProjectDetailText(details as Parameters<typeof renderProjectDetailText>[0])
        await safeEdit(ctx, text, { reply_markup: buildProjectDetailKeyboard(project) })
      } catch (err) {
        await safeEdit(ctx, PROJECT.SWITCH_FAIL((err as Error).message))
      }
      return
    }

    // ── New project prompt ─────────────────────────────────────────────────
    if (action === 'new') {
      await safeEdit(ctx, PROJECT.NEW_USAGE)
      return
    }

    // ── Rename prompt ──────────────────────────────────────────────────────
    if (action === 'rename') {
      await safeEdit(ctx, PROJECT.RENAME_USAGE)
      return
    }

    // ── Sync trigger ───────────────────────────────────────────────────────
    if (action === 'sync') {
      try {
        const before = await sessionManager.getProjectState(userId, chatId)
        const details = await sessionManager.syncProjectsDetailed()
        const after = await sessionManager.getProjectState(userId, chatId)
        const text = renderProjectSyncRun(details, {
          projectsBefore: before.projects.length,
          projectsAfter: after.projects.length,
          currentProjectName: after.currentProject?.name,
          currentProjectLocation: after.currentProjectLocation,
        })
        await safeEdit(ctx, text, { reply_markup: buildMenuKeyboard([
          { label: '🔙 返回主菜单', data: 'p:menu' },
        ]) })
      } catch (err) {
        await safeEdit(ctx, `同步失败: ${(err as Error).message}`)
      }
      return
    }

    // ── Delete confirmation ────────────────────────────────────────────────
    if (action === 'del') {
      const state = await sessionManager.getProjectState(userId, chatId)
      const name = state.currentProject?.name ?? '?'
      const sid = parts[1] ?? ''
      const text = `确定要删除 project "${name}" 吗？此操作不可撤销。`
      await safeEdit(ctx, text, {
        reply_markup: buildConfirmKeyboard(`p:del_y:${sid}`, `p:del_n:${sid}`),
      })
      return
    }

    // ── Delete confirmed ───────────────────────────────────────────────────
    if (action === 'del_y') {
      try {
        const project = await sessionManager.deleteCurrentProject(userId, chatId)
        const text = PROJECT.DELETED(project.name, project.cwd)
        await safeEdit(ctx, text, { reply_markup: buildMenuKeyboard([
          { label: '🔙 返回列表', data: 'p:list:1' },
        ]) })
      } catch (err) {
        await safeEdit(ctx, PROJECT.DELETE_FAIL((err as Error).message))
      }
      return
    }

    // ── Delete cancelled ───────────────────────────────────────────────────
    if (action === 'del_n') {
      const details = await sessionManager.getProjectDetails(userId, chatId)
      if (!details.project) {
        await safeEdit(ctx, PROJECT.NO_ACTIVE, { reply_markup: buildMenuKeyboard([
          { label: '🔙 返回主菜单', data: 'p:menu' },
        ]) })
        return
      }
      const text = renderProjectDetailText(details as Parameters<typeof renderProjectDetailText>[0])
      await safeEdit(ctx, text, { reply_markup: buildProjectDetailKeyboard(details.project) })
      return
    }

    // ── Archive confirmation ───────────────────────────────────────────────
    if (action === 'archive') {
      const state = await sessionManager.getProjectState(userId, chatId)
      const name = state.currentProject?.name ?? '?'
      const sid = parts[1] ?? ''
      const text = `确定要归档 project "${name}" 吗？`
      await safeEdit(ctx, text, {
        reply_markup: buildConfirmKeyboard(`p:archive_y:${sid}`, `p:archive_n:${sid}`),
      })
      return
    }

    // ── Archive confirmed ──────────────────────────────────────────────────
    if (action === 'archive_y') {
      try {
        const project = await sessionManager.archiveCurrentProject(userId, chatId)
        const text = PROJECT.ARCHIVED(project.name, project.cwd)
        await safeEdit(ctx, text, { reply_markup: buildMenuKeyboard([
          { label: '🔙 返回列表', data: 'p:list:1' },
        ]) })
      } catch (err) {
        await safeEdit(ctx, PROJECT.ARCHIVE_FAIL((err as Error).message))
      }
      return
    }

    // ── Archive cancelled ──────────────────────────────────────────────────
    if (action === 'archive_n') {
      const details = await sessionManager.getProjectDetails(userId, chatId)
      if (!details.project) {
        await safeEdit(ctx, PROJECT.NO_ACTIVE, { reply_markup: buildMenuKeyboard([
          { label: '🔙 返回主菜单', data: 'p:menu' },
        ]) })
        return
      }
      const text = renderProjectDetailText(details as Parameters<typeof renderProjectDetailText>[0])
      await safeEdit(ctx, text, { reply_markup: buildProjectDetailKeyboard(details.project) })
      return
    }

    // ── Set source: show source selection ──────────────────────────────────
    if (action === 'setsrc') {
      const details = await sessionManager.getProjectDetails(userId, chatId)
      if (!details.project) {
        await safeEdit(ctx, PROJECT.NO_ACTIVE)
        return
      }
      const sources = details.sources.map((s) => ({
        label: `${details.project!.defaultSourceId === s.id ? '✅ ' : ''}${s.id}`,
        data: `p:src:${s.id.slice(0, 20)}`,
      }))
      sources.push({ label: '🔙 返回', data: 'p:show' })
      await safeEdit(ctx, `🔧 选择 source (当前: ${details.project.defaultSourceId})`, {
        reply_markup: buildActionKeyboard(sources),
      })
      return
    }

    // ── Set source: execute ────────────────────────────────────────────────
    if (action === 'src') {
      const sourceId = parts[1]
      if (!sourceId) return
      try {
        const { project, source } = await sessionManager.setCurrentProjectSource(
          userId, chatId, sourceId,
        )
        await safeEdit(ctx, PROJECT.SET_SOURCE_OK(project.name, source.id, source.codexHome), {
          reply_markup: buildMenuKeyboard([{ label: '🔙 返回详情', data: 'p:show' }]),
        })
      } catch (err) {
        await safeEdit(ctx, PROJECT.SET_SOURCE_FAIL((err as Error).message))
      }
      return
    }

    // ── Settings menu ──────────────────────────────────────────────────────
    if (action === 'settings') {
      const details = await sessionManager.getProjectDetails(userId, chatId)
      if (!details.project) {
        await safeEdit(ctx, PROJECT.NO_ACTIVE)
        return
      }
      const p = details.project
      const awb = p.agentAutoWritebackEnabled ? 'on' : 'off'
      const text = [
        '⚙️ Project 设置',
        '',
        `当前源: ${p.defaultSourceId}`,
        `源模式: ${p.sourceMode}`,
        `Agent源覆盖: ${p.agentSourceOverrideMode}`,
        `自动回写: ${awb}`,
      ].join('\n')
      await safeEdit(ctx, text, { reply_markup: buildSettingsKeyboard(p) })
      return
    }

    // ── Set source mode: show options ──────────────────────────────────────
    if (action === 'setmode') {
      const state = await sessionManager.getProjectState(userId, chatId)
      const current = state.currentProject?.sourceMode ?? ''
      const modes: ProjectSourceMode[] = ['prefer', 'force', 'policy-default']
      const buttons = modes.map((m) => ({
        label: `${m === current ? '✅ ' : ''}${m}`,
        data: `p:setmode_v:${m}`,
      }))
      buttons.push({ label: '🔙 返回', data: 'p:settings' })
      await safeEdit(ctx, `源模式 (当前: ${current})`, {
        reply_markup: buildActionKeyboard(buttons),
      })
      return
    }

    if (action === 'setmode_v') {
      const mode = parts[1]
      if (!isProjectSourceMode(mode)) return
      try {
        const project = await sessionManager.setCurrentProjectSourceMode(userId, chatId, mode)
        await safeEdit(ctx, PROJECT.SET_SOURCE_MODE_OK(project.name, project.sourceMode), {
          reply_markup: buildMenuKeyboard([{ label: '🔙 返回设置', data: 'p:settings' }]),
        })
      } catch (err) {
        await safeEdit(ctx, PROJECT.SET_SOURCE_MODE_FAIL((err as Error).message))
      }
      return
    }

    // ── Set agent source override: show options ────────────────────────────
    if (action === 'setoverride') {
      const state = await sessionManager.getProjectState(userId, chatId)
      const current = state.currentProject?.agentSourceOverrideMode ?? ''
      const modes: AgentParentSourceOverrideMode[] = ['allow', 'deny', 'policy-default']
      const buttons = modes.map((m) => ({
        label: `${m === current ? '✅ ' : ''}${m}`,
        data: `p:setoverride_v:${m}`,
      }))
      buttons.push({ label: '🔙 返回', data: 'p:settings' })
      await safeEdit(ctx, `Agent源覆盖 (当前: ${current})`, {
        reply_markup: buildActionKeyboard(buttons),
      })
      return
    }

    if (action === 'setoverride_v') {
      const mode = parts[1]
      if (!isAgentParentSourceOverrideMode(mode)) return
      try {
        const project = await sessionManager.setCurrentProjectAgentSourceOverrideMode(
          userId, chatId, mode,
        )
        await safeEdit(ctx, PROJECT.SET_AGENT_SOURCE_OVERRIDE_OK(project.name, project.agentSourceOverrideMode), {
          reply_markup: buildMenuKeyboard([{ label: '🔙 返回设置', data: 'p:settings' }]),
        })
      } catch (err) {
        await safeEdit(ctx, PROJECT.SET_AGENT_SOURCE_OVERRIDE_FAIL((err as Error).message))
      }
      return
    }

    // ── Set agent auto writeback: toggle ───────────────────────────────────
    if (action === 'setawb') {
      const state = await sessionManager.getProjectState(userId, chatId)
      const current = state.currentProject?.agentAutoWritebackEnabled ?? false
      const buttons = [
        { label: `${current ? '✅ ' : ''}on`, data: 'p:setawb_v:on' },
        { label: `${!current ? '✅ ' : ''}off`, data: 'p:setawb_v:off' },
        { label: '🔙 返回', data: 'p:settings' },
      ]
      await safeEdit(ctx, `自动回写 (当前: ${current ? 'on' : 'off'})`, {
        reply_markup: buildActionKeyboard(buttons),
      })
      return
    }

    if (action === 'setawb_v') {
      const value = parts[1]
      if (value !== 'on' && value !== 'off') return
      try {
        const project = await sessionManager.setCurrentProjectAgentAutoWriteback(
          userId, chatId, value === 'on',
        )
        await safeEdit(ctx, PROJECT.SET_AGENT_AUTO_WRITEBACK_OK(project.name, project.agentAutoWritebackEnabled), {
          reply_markup: buildMenuKeyboard([{ label: '🔙 返回设置', data: 'p:settings' }]),
        })
      } catch (err) {
        await safeEdit(ctx, PROJECT.SET_AGENT_AUTO_WRITEBACK_FAIL((err as Error).message))
      }
      return
    }
  })

  return composer
}