import { App } from "@slack/bolt"
import type { SlackConfig } from "../config/types.js"
import type { Logger } from "../utils/logger.js"
import { createReconnector } from "../utils/reconnect.js"
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

	const reconnector = createReconnector({
		name: "slack",
		logger,
		connect: async () => {
			state = "connecting"
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

		const peerId = message.user
		const channel = "channel" in message ? (message.channel as string) : undefined

		if (config.allowlist && config.allowlist.length > 0 && !config.allowlist.includes(peerId)) {
			if (config.rejectionBehavior === "reject") {
				await say("This assistant is private.")
			}
			logger.debug("slack: message dropped (not in allowlist)", { peerId })
			return
		}

		const threadTs = "thread_ts" in message ? (message.thread_ts as string) : undefined

		const msg = {
			channel: "slack" as const,
			peerId,
			groupId: channel,
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
			await app.client.chat.postMessage({
				channel: peerId,
				text: message.text,
				thread_ts: message.threadId,
			})
		},
		async sendTyping(_peerId) {
			// Slack has no general bot typing indicator API
		},

		status() {
			return state
		},
	}
}
