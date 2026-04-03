import type { Bot } from 'grammy'
import {
  sendFormattedOutput,
  TELEGRAM_MESSAGE_LIMIT,
  type MessageSender,
} from './views/formatting.js'
import { formatForTelegram } from './views/tg-format.js'

// ─── StreamHandle ────────────────────────────────────────────────────────────

export interface StreamHandle {
  readonly chatId: number | string
  readonly messageId: number
  appendDelta(delta: string): void
  finalize(fullText: string): Promise<void>
  cancel(): Promise<void>
}

const STREAM_UPDATE_INTERVAL_MS = 500

/**
 * Serialises Telegram message delivery per chat so messages arrive in order.
 */
export class DeliveryQueue {
  private queues = new Map<string, Promise<void>>()
  private sendMessage: MessageSender
  private bot: Bot

  constructor(bot: Bot) {
    this.bot = bot
    this.sendMessage = (chatId, text, options) =>
      bot.api.sendMessage(chatId, text, options as Parameters<typeof bot.api.sendMessage>[2])
  }

  enqueue(chatId: string, output: string): void {
    const previous = this.queues.get(chatId) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        await sendFormattedOutput(this.sendMessage, chatId, output)
      })

    this.queues.set(chatId, current)

    void current
      .catch((error) => {
        console.error(`[delivery] failed to deliver output to chat ${chatId}:`, error)
      })
      .finally(() => {
        if (this.queues.get(chatId) === current) {
          this.queues.delete(chatId)
        }
      })
  }

  /**
   * Start a streaming delivery: sends an initial placeholder message and
   * returns a {@link StreamHandle} that progressively updates it.
   */
  async startStream(
    chatId: number | string,
    initialText = '⏳ 思考中...',
  ): Promise<StreamHandle> {
    const msg = await this.bot.api.sendMessage(chatId, initialText)
    const messageId = msg.message_id

    let buffer = ''
    let lastSentText = initialText
    let timer: ReturnType<typeof setInterval> | undefined
    let finalized = false

    const flush = async () => {
      if (finalized || buffer === lastSentText) return
      const text = buffer.length > TELEGRAM_MESSAGE_LIMIT
        ? buffer.slice(0, TELEGRAM_MESSAGE_LIMIT)
        : buffer
      try {
        await this.bot.api.editMessageText(chatId, messageId, text)
        lastSentText = text
      } catch (err) {
        if (!String(err).includes('message is not modified')) {
          console.error('[delivery] stream update failed:', err)
        }
      }
    }

    const startTimer = () => {
      if (!timer) {
        timer = setInterval(() => void flush(), STREAM_UPDATE_INTERVAL_MS)
      }
    }

    const stopTimer = () => {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
    }

    const bot = this.bot

    const handle: StreamHandle = {
      chatId,
      messageId,

      appendDelta(delta: string) {
        if (finalized) return
        buffer += delta
        startTimer()
      },

      finalize: async (fullText: string) => {
        if (finalized) return
        finalized = true
        stopTimer()
        // Try HTML formatting first, fall back to plain text
        const { text: formatted, parse_mode } = formatForTelegram(fullText, TELEGRAM_MESSAGE_LIMIT)
        try {
          await bot.api.editMessageText(chatId, messageId, formatted, {
            ...(parse_mode ? { parse_mode } : {}),
          })
        } catch (err) {
          if (parse_mode && !String(err).includes('message is not modified')) {
            // HTML failed — retry as plain text
            const plain = fullText.length > TELEGRAM_MESSAGE_LIMIT
              ? fullText.slice(0, TELEGRAM_MESSAGE_LIMIT)
              : fullText
            try {
              await bot.api.editMessageText(chatId, messageId, plain)
            } catch (err2) {
              if (!String(err2).includes('message is not modified')) {
                console.error('[delivery] stream finalize failed:', err2)
              }
            }
          } else if (!String(err).includes('message is not modified')) {
            console.error('[delivery] stream finalize failed:', err)
          }
        }
      },

      cancel: async () => {
        if (finalized) return
        finalized = true
        stopTimer()
        try {
          await bot.api.editMessageText(chatId, messageId, '❌ 已取消')
        } catch (err) {
          console.error('[delivery] stream cancel failed:', err)
        }
      },
    }

    return handle
  }
}
