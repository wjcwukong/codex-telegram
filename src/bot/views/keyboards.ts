import { InlineKeyboard } from 'grammy'

// Callback data format: "domain:action:p1:p2:..." (max 64 bytes!)
// Domains: p=project, t=thread, a=agent, r=run, s=source, g=general

const DEFAULT_MAX_LABEL = 40
const MENU_COLS = 2
const ACTION_COLS = 2

/** Truncate a label to fit Telegram button limits. */
export function truncateLabel(label: string, maxLen = DEFAULT_MAX_LABEL): string {
  if (label.length <= maxLen) return label
  return label.slice(0, maxLen - 1) + '…'
}

/** Build a menu of subcommand buttons (2 per row). */
export function buildMenuKeyboard(
  items: Array<{ label: string; data: string }>,
): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (let i = 0; i < items.length; i++) {
    kb.text(truncateLabel(items[i].label), items[i].data)
    if ((i + 1) % MENU_COLS === 0 || i === items.length - 1) kb.row()
  }
  return kb
}

/** Build a list of items as buttons (1 per row) with pagination. */
export function buildListKeyboard(
  items: Array<{ label: string; data: string }>,
  page: number,
  totalPages: number,
  paginationPrefix: string,
): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const item of items) {
    kb.text(truncateLabel(item.label), item.data).row()
  }
  return addPaginationRow(kb, page, totalPages, paginationPrefix)
}

/** Build action buttons for detail views (2 per row). */
export function buildActionKeyboard(
  actions: Array<{ label: string; data: string }>,
): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (let i = 0; i < actions.length; i++) {
    kb.text(truncateLabel(actions[i].label), actions[i].data)
    if ((i + 1) % ACTION_COLS === 0 || i === actions.length - 1) kb.row()
  }
  return kb
}

/** Build a confirmation dialog (Yes / Cancel on one row). */
export function buildConfirmKeyboard(
  confirmData: string,
  cancelData: string,
): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ 确认', confirmData)
    .text('❌ 取消', cancelData)
}

/** Build a single "Back" button. */
export function buildBackKeyboard(data: string): InlineKeyboard {
  return new InlineKeyboard().text('◀ 返回', data)
}

/** Append a pagination row: [◀ Prev] [Page X/Y] [Next ▶]. */
export function addPaginationRow(
  kb: InlineKeyboard,
  page: number,
  totalPages: number,
  prefix: string,
): InlineKeyboard {
  if (totalPages <= 1) return kb

  if (page > 1) {
    kb.text('◀ 上页', `${prefix}:${page - 1}`)
  }

  // no-op callback for display only
  kb.text(`${page}/${totalPages}`, `g:noop`)

  if (page < totalPages) {
    kb.text('下页 ▶', `${prefix}:${page + 1}`)
  }

  kb.row()
  return kb
}
