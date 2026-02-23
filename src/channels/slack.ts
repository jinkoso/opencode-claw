import { App } from "@slack/bolt"
import type { SlackConfig } from "../config/types.js"
import type { Logger } from "../utils/logger.js"
import { createReconnector } from "../utils/reconnect.js"
import { splitMessage } from "./split-message.js"
import type {
	ChannelAdapter,
	ChannelStatus,
	InboundMessageHandler,
	OutboundMessage,
} from "./types.js"

export function createSlackAdapter(config: SlackConfig, logger: Logger): ChannelAdapter {
	const app = new App({
		token: config.botToken,
		appToken: config.appToken,
		socketMode: config.mode === "socket",
		signingSecret: config.mode === "http" ? config.signingSecret : undefined,
	})

	let state: ChannelStatus = "disconnected"
	let handler: InboundMessageHandler | undefined
	let botUserId: string | undefined

	const reconnector = createReconnector({
		name: "slack",
		logger,
		connect: async () => {
			state = "connecting"
			const auth = await app.client.auth.test()
			botUserId = auth.user_id
			await app.start()
			state = "connected"
			reconnector.reset()
			logger.info("slack: reconnected")
		},
	})

	app.message(async ({ message, say }) => {
		if (!handler) return
		if (!("text" in message) || !message.text) return
		if ("bot_id" in message && message.bot_id) return
		if (!("user" in message) || !message.user) return

		const channelId = "channel" in message ? (message.channel as string) : undefined
		if (!channelId) return

		const isDm = channelId.startsWith("D")
		const requireMention = isDm ? config.requireMentionInDms : config.requireMentionInChannels

		// In channels (not DMs), only reply if mentioned
		if (requireMention) {
			if (!botUserId) {
				// Should not happen if started correctly
				const auth = await app.client.auth.test()
				botUserId = auth.user_id
			}
			if (botUserId && !message.text.includes(`<@${botUserId}>`)) {
				return
			}
		}

		const userId = message.user
		const peerId = isDm ? userId : channelId
		if (config.allowlist && config.allowlist.length > 0 && !config.allowlist.includes(userId)) {
			if (config.rejectionBehavior === "reject") {
				await say("This assistant is private.")
			}
			logger.debug("slack: message dropped (not in allowlist)", { userId })
			return
		}

		const threadTs = "thread_ts" in message ? (message.thread_ts as string) : undefined

		const msg = {
			channel: "slack" as const,
			peerId,
			senderId: userId,
			groupId: channelId,
			threadId: threadTs,
			text: message.text,
			raw: message,
		}

		await handler(msg)
	})

	app.error(async (error) => {
		logger.error("slack: app error", {
			error: error.message,
		})
		state = "error"
		reconnector.attempt()
	})

	return {
		id: "slack",
		name: "Slack",

		async start(h) {
			handler = h
			state = "connecting"
			logger.info("slack: starting app", { mode: config.mode })
			const auth = await app.client.auth.test()
			botUserId = auth.user_id
			await app.start()
			state = "connected"
			logger.info("slack: app connected")
		},

		async stop() {
			reconnector.stop()
			state = "disconnected"
			await app.stop()
			logger.info("slack: app stopped")
		},

		async send(peerId, message: OutboundMessage) {
			const chunks = splitMessage(message.text, 40000)
			for (const chunk of chunks) {
				await app.client.chat.postMessage({
					channel: peerId,
					text: chunk,
					thread_ts: message.threadId,
				})
			}
		},
		async sendTyping(_peerId) {
			// Slack has no general bot typing indicator API
		},

		status() {
			return state
		},
	}
}
