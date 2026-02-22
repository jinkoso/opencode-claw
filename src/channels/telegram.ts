import { Bot } from "grammy"
import type { TelegramConfig } from "../config/types.js"
import type { Logger } from "../utils/logger.js"
import { createReconnector } from "../utils/reconnect.js"
import type {
	ChannelAdapter,
	ChannelStatus,
	InboundMessageHandler,
	OutboundMessage,
} from "./types.js"

export function createTelegramAdapter(config: TelegramConfig, logger: Logger): ChannelAdapter {
	const bot = new Bot(config.botToken)
	let state: ChannelStatus = "disconnected"
	let handler: InboundMessageHandler | undefined

	const reconnector = createReconnector({
		name: "telegram",
		logger,
		connect: async () => {
			state = "connecting"
			bot.start({
				onStart: () => {
					state = "connected"
					reconnector.reset()
					logger.info("telegram: bot connected")
				},
			})
		},
	})

	bot.on("message:text", async (ctx) => {
		if (!handler) return
		if (!ctx.from) return

		const peerId = String(ctx.from.id)

		if (config.allowlist.length > 0 && !config.allowlist.includes(peerId)) {
			if (config.rejectionBehavior === "reject") {
				await ctx.reply("This assistant is private.")
			}
			logger.debug("telegram: message dropped (not in allowlist)", { peerId })
			return
		}

		const msg = {
			channel: "telegram" as const,
			peerId,
			peerName: ctx.from.first_name,
			groupId: ctx.chat.type !== "private" ? String(ctx.chat.id) : undefined,
			threadId: ctx.message.message_thread_id ? String(ctx.message.message_thread_id) : undefined,
			text: ctx.message.text ?? "",
			raw: ctx.message,
		}

		await handler(msg)
	})

	bot.catch((err) => {
		logger.error("telegram: bot error", { error: err.message })
		state = "error"
		reconnector.attempt()
	})

	return {
		id: "telegram",
		name: "Telegram",

		async start(h) {
			handler = h
			state = "connecting"
			logger.info("telegram: starting bot (polling mode)")

			bot.start({
				onStart: () => {
					state = "connected"
					logger.info("telegram: bot connected")
				},
			})
		},

		async stop() {
			reconnector.stop()
			state = "disconnected"
			await bot.stop()
			logger.info("telegram: bot stopped")
		},

		async send(peerId, message: OutboundMessage) {
			await bot.api.sendMessage(Number(peerId), message.text, {
				reply_parameters: message.replyToId ? { message_id: Number(message.replyToId) } : undefined,
			})
		},
		async sendTyping(peerId) {
			await bot.api.sendChatAction(Number(peerId), "typing")
		},

		status() {
			return state
		},
	}
}
