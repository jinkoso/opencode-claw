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

export function createSlackAdapter(
	config: SlackConfig,
	logger: Logger,
	sessionExists?: (channelId: string, threadTs: string) => boolean,
): ChannelAdapter {
	const app = new App({
		token: config.botToken,
		appToken: config.appToken,
		socketMode: config.mode === "socket",
		signingSecret: config.mode === "http" ? config.signingSecret : undefined,
	})

	let state: ChannelStatus = "disconnected"
	let handler: InboundMessageHandler | undefined
	let botUserId: string | undefined

	// Tracks thread_ts values that we have processed a mention for (in-memory; survives restarts via sessionExists callback)
	const knownThreads = new Set<string>()

	// Deduplication: prevents app.message + app_mention from double-processing the same event
	// Maps message.ts → time it was processed; evicted after 60s
	const recentlyProcessed = new Map<string, number>()

	function dedup(ts: string): boolean {
		const now = Date.now()
		for (const [key, time] of recentlyProcessed) {
			if (now - time > 60_000) recentlyProcessed.delete(key)
		}
		if (recentlyProcessed.has(ts)) return false
		recentlyProcessed.set(ts, now)
		return true
	}

	function isBotMentioned(text: string): boolean {
		return botUserId ? text.includes(`<@${botUserId}>`) : false
	}

	function isThreadKnown(channelId: string, threadTs: string): boolean {
		if (knownThreads.has(threadTs)) return true
		return sessionExists ? sessionExists(channelId, threadTs) : false
	}

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

	app.message(async ({ message, say: _say }) => {
		if (!handler) return
		if (!("text" in message) || !message.text) return
		if ("bot_id" in message && message.bot_id) return
		if (!("user" in message) || !message.user) return

		const channelId = "channel" in message ? (message.channel as string) : undefined
		if (!channelId) return

		const messageTs = "ts" in message ? (message.ts as string) : undefined
		if (!messageTs) return

		if (!dedup(messageTs)) return

		const isDm = channelId.startsWith("D")
		const threadTs = "thread_ts" in message ? (message.thread_ts as string) : undefined
		const mentioned = isBotMentioned(message.text)

		let effectiveThreadId: string | undefined

		if (!isDm && config.threadMode !== false) {
			if (threadTs) {
				// Message is a reply inside an existing thread
				const known = isThreadKnown(channelId, threadTs)
				if (!known && !mentioned) {
					// Thread we never started and bot wasn't mentioned — skip
					return
				}
				knownThreads.add(threadTs)
				effectiveThreadId = threadTs
			} else {
				// Top-level message in a channel
				if (config.requireMentionInChannels && !mentioned) {
					return
				}
				// This message becomes the thread root
				knownThreads.add(messageTs)
				effectiveThreadId = messageTs
			}
		} else if (!isDm) {
			// threadMode disabled: legacy mention-only check, no thread scoping
			if (config.requireMentionInChannels && !mentioned) {
				return
			}
			effectiveThreadId = threadTs
		} else {
			// DM
			const requireMention = config.requireMentionInDms
			if (requireMention) {
				if (!botUserId) {
					const auth = await app.client.auth.test()
					botUserId = auth.user_id
				}
				if (!mentioned) return
			}
			effectiveThreadId = threadTs
		}

		const userId = message.user
		const peerId = isDm ? userId : channelId

		if (config.allowlist && config.allowlist.length > 0 && !config.allowlist.includes(userId)) {
			if (config.rejectionBehavior === "reject") {
				await app.client.chat.postMessage({
					channel: channelId,
					text: "This assistant is private.",
					thread_ts: effectiveThreadId,
				})
			}
			logger.debug("slack: message dropped (not in allowlist)", { userId })
			return
		}

		const msg = {
			channel: "slack" as const,
			peerId,
			senderId: userId,
			groupId: channelId,
			threadId: effectiveThreadId,
			text: message.text,
			raw: message,
		}

		await handler(msg)
	})

	// app_mention fires for @bot in channels even without message.channels subscription
	app.event("app_mention", async ({ event }) => {
		if (!handler) return
		if (!event.text || !event.user) return

		const ts = event.ts
		if (!dedup(ts)) return

		const channelId = event.channel
		const isDm = channelId.startsWith("D")
		const threadTs = event.thread_ts as string | undefined

		let effectiveThreadId: string | undefined

		if (!isDm && config.threadMode !== false) {
			effectiveThreadId = threadTs ?? ts
			knownThreads.add(effectiveThreadId)
		} else {
			effectiveThreadId = threadTs
		}

		const userId = event.user

		if (config.allowlist && config.allowlist.length > 0 && !config.allowlist.includes(userId)) {
			if (config.rejectionBehavior === "reject") {
				await app.client.chat.postMessage({
					channel: channelId,
					text: "This assistant is private.",
					thread_ts: effectiveThreadId,
				})
			}
			logger.debug("slack: mention dropped (not in allowlist)", { userId })
			return
		}

		const msg = {
			channel: "slack" as const,
			peerId: isDm ? userId : channelId,
			senderId: userId,
			groupId: channelId,
			threadId: effectiveThreadId,
			text: event.text,
			raw: event,
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
