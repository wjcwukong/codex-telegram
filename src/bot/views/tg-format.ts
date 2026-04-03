/**
 * Convert markdown-ish AI output to Telegram-safe HTML.
 * Handles: fenced code blocks (with language labels), inline code, bold,
 * italic, strikethrough, links, headings, blockquotes, horizontal rules,
 * bullets (nested), and numbered lists.
 * Falls back gracefully — always produces valid HTML or returns input unchanged.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function markdownToTelegramHtml(text: string): string {
  // Phase 1: Extract fenced code blocks to protect from other transforms
  const codeBlocks: string[] = []
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const idx = codeBlocks.length
    const escaped = escapeHtml(code.trimEnd())
    const langLabel = lang ? `<b>[${escapeHtml(lang)}]</b>\n` : ''
    codeBlocks.push(
      lang
        ? `${langLabel}<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
        : `<pre>${escaped}</pre>`,
    )
    return `\x00CB${idx}\x00`
  })

  // Phase 2: Extract inline code
  const inlineCodes: string[] = []
  result = result.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const idx = inlineCodes.length
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`)
    return `\x00IC${idx}\x00`
  })

  // Phase 2.5: Extract strikethrough before HTML escaping
  const strikes: string[] = []
  result = result.replace(/~~(.+?)~~/g, (_match, inner: string) => {
    const idx = strikes.length
    strikes.push(inner)
    return `\x00ST${idx}\x00`
  })

  // Phase 2.6: Extract markdown links before HTML escaping
  const links: string[] = []
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText: string, url: string) => {
    const idx = links.length
    links.push(`<a href="${escapeHtml(url)}">${escapeHtml(linkText)}</a>`)
    return `\x00LK${idx}\x00`
  })

  // Phase 3: Escape remaining HTML entities
  result = escapeHtml(result)

  // Phase 4: Markdown formatting
  // Horizontal rules: --- or *** or ___
  result = result.replace(/^[-*_]{3,}$/gm, '———')
  // Bold: **text**
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  // Italic: *text* (not inside words)
  result = result.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<i>$1</i>')
  // Strikethrough: restore extracted ~~text~~ as <s>
  result = result.replace(/\x00ST(\d+)\x00/g, (_m, idx) => `<s>${escapeHtml(strikes[parseInt(idx)])}</s>`)
  // Headings: # text → bold (Telegram has no heading tags)
  result = result.replace(/^#{1,3}\s+(.+)$/gm, '<b>$1</b>')
  // Blockquotes: > text → ▎ italic
  result = result.replace(/^&gt;\s+(.+)$/gm, '▎ <i>$1</i>')
  // Nested bullets: indented - text → indented • text (must come before top-level bullets)
  result = result.replace(/^(\s+)[-*]\s+(.+)$/gm, '$1• $2')
  // Bullets: - text or * text → • text
  result = result.replace(/^[-*]\s+(.+)$/gm, '• $1')
  // Numbered lists: preserve numbering
  result = result.replace(/^(\d+)\.\s+(.+)$/gm, '$1. $2')

  // Phase 5: Restore protected blocks
  result = result.replace(/\x00CB(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)])
  result = result.replace(/\x00IC(\d+)\x00/g, (_m, idx) => inlineCodes[parseInt(idx)])
  result = result.replace(/\x00LK(\d+)\x00/g, (_m, idx) => links[parseInt(idx)])

  return result
}

/**
 * Format text for Telegram with HTML, with automatic fallback.
 * Returns { text, parse_mode } for use with Telegram API.
 * If HTML conversion would exceed maxLength, falls back to plain text.
 */
export function formatForTelegram(
  text: string,
  maxLength = 4096,
): { text: string; parse_mode?: 'HTML' } {
  try {
    const html = markdownToTelegramHtml(text)
    if (html.length <= maxLength) {
      return { text: html, parse_mode: 'HTML' }
    }
  } catch { /* fall through */ }
  // Fallback: plain text, truncated if needed
  return { text: text.length > maxLength ? text.slice(0, maxLength - 3) + '...' : text }
}
