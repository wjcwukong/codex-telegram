import type { Context } from 'grammy'
import { readAccessConfig } from './auth.js'

export async function acknowledge(ctx: Context): Promise<void> {
  try {
    await ctx.react(readAccessConfig().ackReaction as never)
  } catch (error) {
    console.error(
      `[server] failed to react to message ${ctx.message?.message_id ?? 'unknown'}:`,
      error,
    )
  }
}
