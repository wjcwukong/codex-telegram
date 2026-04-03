import { Composer, InlineKeyboard, type Context } from 'grammy'
import type { SessionManager } from '../../../session-manager.js'
import { ensureAuthorized } from '../middleware/auth.js'
import { SOURCE } from '../i18n/zh.js'
import { renderSections } from '../views/sections.js'
import {
  LIST_PAGE_SIZE,
  parsePositiveInt,
  parsePaginationArgs,
  parseSearchPaginationArgs,
  resolveIndexedItemIndex,
} from '../views/pagination.js'
import {
  highlightSearchText,
  buildSourceIssueLines,
} from '../views/formatting.js'
import {
  buildMenuKeyboard,
  buildActionKeyboard,
  truncateLabel,
} from '../views/keyboards.js'
import { GENERAL } from '../i18n/zh.js'

export function createSourceCommands(
  sessionManager: SessionManager,
  router?: import('../callbacks/router.js').CallbackRouter,
): Composer<Context> {
  const composer = new Composer<Context>()

  composer.command('source', async (ctx) => {
    if (!(await ensureAuthorized(ctx))) {
      return
    }

    const args = ctx.message?.text?.trim().split(/\s+/).slice(1) ?? []
    const action = args[0]?.toLowerCase() ?? 'menu'

    if (action === 'menu') {
      const kb = buildMenuKeyboard([
        { label: '📋 列表', data: 's:list' },
      ])
      kb.text('🔙 主菜单', 'g:menu').row()
      await ctx.reply(GENERAL.SOURCE_MENU, { reply_markup: kb })
      return
    }

    if (action === 'enable' || action === 'disable') {
      const sourceId = args[1]?.trim()

      if (!sourceId) {
        await ctx.reply(SOURCE.ENABLE_USAGE)
        return
      }

      try {
        const source = await sessionManager.setSourceEnabled(
          sourceId,
          action === 'enable',
        )
        await ctx.reply(
          action === 'enable' ? SOURCE.ENABLED(source.id, source.codexHome) : SOURCE.DISABLED(source.id, source.codexHome),
        )
      } catch (error) {
        await ctx.reply(SOURCE.UPDATE_FAIL((error as Error).message))
      }

      return
    }

    if (action === 'show') {
      const sourceId = args[1]?.trim()

      if (!sourceId) {
        await ctx.reply(SOURCE.SHOW_USAGE)
        return
      }

      const details = await sessionManager.getSourceDetails(sourceId)
      if (!details) {
        await ctx.reply(SOURCE.UNKNOWN(sourceId))
        return
      }

      await ctx.reply(renderSections([
        {
          title: 'Identity',
          lines: [
            `source: ${details.source.id}`,
            `name: ${details.source.name}`,
            `codexHome: ${details.source.codexHome}`,
          ],
        },
        {
          title: 'Status',
          lines: [
            `enabled: ${details.source.enabled}`,
            `storagePolicy: ${details.source.storagePolicy}`,
            `importEnabled: ${details.source.importEnabled}`,
          ],
        },
        {
          title: 'Top Issues',
          lines: buildSourceIssueLines(details),
        },
        {
          title: 'Links',
          lines: [
            `projects: ${details.projectCount}`,
            `threads: ${details.threadCount}`,
            `agents: ${details.agentCount}`,
          ],
        },
        {
          title: 'Actions',
          lines: [
            `jump: /source where ${details.source.id}`,
          ],
        },
      ]))
      return
    }

    if (action === 'where') {
      const reference = args[1]?.trim()
      const pageSize = parsePositiveInt(args[2]) ?? LIST_PAGE_SIZE
      if (!reference) {
        await ctx.reply(SOURCE.WHERE_USAGE)
        return
      }

      const state = await sessionManager.getSourceState()
      const sourceIndex = resolveIndexedItemIndex(
        state.sources,
        reference,
        (entry) => [entry.source.id],
      )
      if (sourceIndex < 0) {
        await ctx.reply(SOURCE.UNKNOWN(reference))
        return
      }

      const page = Math.floor(sourceIndex / pageSize) + 1
      const entry = state.sources[sourceIndex]
      await ctx.reply(
        [
          `source: ${entry.source.id}`,
          `index: #${sourceIndex + 1}/${state.sources.length}`,
          `page: ${page}`,
          `pageSize: ${pageSize}`,
          `jump: /source list ${page} ${pageSize}`,
        ].join('\n'),
      )
      return
    }

    if (action === 'search') {
      const { query, page, pageSize, start, end } = parseSearchPaginationArgs(args.slice(1))
      if (!query) {
        await ctx.reply(SOURCE.SEARCH_USAGE)
        return
      }

      const state = await sessionManager.searchSources(query)
      const sources = state.sources.slice(start, end)
      const total = state.sources.length
      const totalPages = Math.max(1, Math.ceil(total / pageSize))
      const hasPrev = start > 0
      const hasNext = end < total

      if (total === 0) {
        await ctx.reply(SOURCE.NO_MATCH(query))
        return
      }

      await ctx.reply(
        [
          `source search: ${query}`,
          `page ${page}/${totalPages}, pageSize ${pageSize}`,
          `total: ${total}`,
          hasPrev ? `prev: /source search ${query} ${Math.max(1, page - 1)} ${pageSize}` : undefined,
          hasNext ? `next: /source search ${query} ${page + 1} ${pageSize}` : undefined,
          ...sources.map(
            (entry, index) =>
              `${start + index + 1}. ${highlightSearchText(entry.source.id, query)} (${entry.source.storagePolicy})${entry.source.enabled ? '' : ' [disabled]'}\n${highlightSearchText(entry.source.codexHome, query)}\nprojects: ${entry.projectCount}, threads: ${entry.threadCount}, agents: ${entry.agentCount}`,
          ),
        ]
          .filter(Boolean)
          .join('\n'),
      )
      return
    }

    const state = await sessionManager.getSourceState()
    const { page, pageSize, start, end } = parsePaginationArgs(
      action === 'list' ? args.slice(1) : args,
    )
    const sources = state.sources.slice(start, end)
    const total = state.sources.length
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const hasPrev = start > 0
    const hasNext = end < total
    await ctx.reply(
      [
        `sources: page ${page}/${totalPages}, pageSize ${pageSize}`,
        `total: ${total}`,
        hasPrev ? `prev: /source list ${Math.max(1, page - 1)} ${pageSize}` : undefined,
        hasNext ? `next: /source list ${page + 1} ${pageSize}` : undefined,
        'sources:',
        ...sources.map(
          (entry, index) =>
            `${start + index + 1}. ${entry.source.id} (${entry.source.storagePolicy})${entry.source.enabled ? '' : ' [disabled]'}\n${entry.source.codexHome}\nprojects: ${entry.projectCount}, threads: ${entry.threadCount}, agents: ${entry.agentCount}`,
        ),
      ]
        .filter(Boolean)
        .join('\n'),
    )
  })

  router?.register('s', async (ctx, parts) => {
    const action = parts[0]

    if (action === 'menu') {
      const kb = buildMenuKeyboard([
        { label: '📋 列表', data: 's:list' },
      ])
      kb.text('🔙 主菜单', 'g:menu').row()
      await safeEditSource(ctx, GENERAL.SOURCE_MENU, kb)
      return
    }

    if (action === 'list') {
      const state = await sessionManager.getSourceState()
      const kb = new InlineKeyboard()
      for (const entry of state.sources) {
        const indicator = entry.source.enabled ? '✅' : '❌'
        const label = `${indicator} ${entry.source.id} — ${entry.source.codexHome}`
        kb.text(truncateLabel(label), `s:show:${entry.source.id}`).row()
      }
      kb.text('🔙 返回', 's:menu').row()
      await safeEditSource(ctx, GENERAL.SOURCE_LIST_TITLE, kb)
      return
    }

    if (action === 'show') {
      const sourceId = parts.slice(1).join(':')
      await showSourceDetail(ctx, sessionManager, sourceId)
      return
    }

    if (action === 'enable' || action === 'disable') {
      const sourceId = parts.slice(1).join(':')
      try {
        await sessionManager.setSourceEnabled(sourceId, action === 'enable')
      } catch (error) {
        await ctx.answerCallbackQuery({
          text: SOURCE.UPDATE_FAIL((error as Error).message),
        })
        return
      }
      await showSourceDetail(ctx, sessionManager, sourceId)
      return
    }
  })

  return composer
}

// ─── Callback helpers ────────────────────────────────────────────────────────

async function safeEditSource(
  ctx: Context,
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  try {
    await ctx.editMessageText(text, { reply_markup: keyboard })
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('message is not modified')
    ) {
      return
    }
    throw error
  }
}

async function showSourceDetail(
  ctx: Context,
  sessionManager: SessionManager,
  sourceId: string,
): Promise<void> {
  const details = await sessionManager.getSourceDetails(sourceId)
  if (!details) {
    await ctx.answerCallbackQuery({ text: SOURCE.UNKNOWN(sourceId) })
    return
  }

  const text = renderSections([
    {
      title: 'Identity',
      lines: [
        `name: ${details.source.name}`,
        `path: ${details.source.codexHome}`,
      ],
    },
    {
      title: 'Status',
      lines: [
        `enabled: ${details.source.enabled ? 'yes' : 'no'}`,
        `import: ${details.source.importEnabled ? 'yes' : 'no'}`,
        `policy: ${details.source.storagePolicy}`,
      ],
    },
  ])

  const actions: Array<{ label: string; data: string }> = []
  if (details.source.enabled) {
    actions.push({ label: '❌ 禁用', data: `s:disable:${details.source.id}` })
  } else {
    actions.push({ label: '✅ 启用', data: `s:enable:${details.source.id}` })
  }
  actions.push({ label: '🔙 返回列表', data: 's:list' })

  await safeEditSource(ctx, text, buildActionKeyboard(actions))
}