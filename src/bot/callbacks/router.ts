import type { Context } from 'grammy'

type CallbackHandler = (ctx: Context, parts: string[]) => Promise<void>

export class CallbackRouter {
  private handlers = new Map<string, CallbackHandler>()

  /** Register a handler for a domain prefix. */
  register(domain: string, handler: CallbackHandler): void {
    this.handlers.set(domain, handler)
  }

  /** Route a callback query to the right handler. */
  async route(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data
    if (!data) return

    const parts = data.split(':')
    const domain = parts[0]
    const handler = this.handlers.get(domain)

    if (handler) {
      await handler(ctx, parts.slice(1))
    }

    // Always answer to dismiss the loading spinner
    await ctx.answerCallbackQuery().catch(() => {})
  }
}
