import type { OpencodeClient } from "@opencode-ai/sdk"
import type { Config } from "../config/types.js"
import type { SessionManager } from "../sessions/manager.js"
import { buildSessionKey } from "../sessions/manager.js"
import type { Logger } from "../utils/logger.js"
import type { ChannelAdapter, ChannelId, InboundMessage } from "./types.js"

type RouterDeps = {
	client: OpencodeClient
	sessions: SessionManager
	adapters: Map<ChannelId, ChannelAdapter>
	config: Config
	logger: Logger
	timeoutMs: number
}

function allowlist(config: Config, channel: ChannelId): string[] | undefined {
	const ch = config.channels[channel]
	if (!ch) return undefined
	if ("allowlist" in ch && Array.isArray(ch.allowlist)) return ch.allowlist
	return undefined
}

function rejection(config: Config, channel: ChannelId): "ignore" | "reject" {
	const ch = config.channels[channel]
	if (!ch) return "ignore"
	if ("rejectionBehavior" in ch && ch.rejectionBehavior) return ch.rejectionBehavior
	return "ignore"
}

function checkAllowlist(config: Config, msg: InboundMessage): boolean {
	const list = allowlist(config, msg.channel)
	if (!list) return true
	return list.includes(msg.peerId)
}

function extractText(parts: ReadonlyArray<{ type: string; text?: string }>): string {
	return parts
		.filter(
			(p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string",
		)
		.map((p) => p.text)
		.join("\n\n")
}

type Command = {
	name: string
	args: string
}

function parseCommand(text: string): Command | undefined {
	const trimmed = text.trim()
	if (!trimmed.startsWith("/")) return undefined
	const space = trimmed.indexOf(" ")
	if (space === -1) return { name: trimmed.slice(1).toLowerCase(), args: "" }
	return { name: trimmed.slice(1, space).toLowerCase(), args: trimmed.slice(space + 1).trim() }
}

const HELP_TEXT = `Available commands:
/new [title] — Create a new session
/switch <id> — Switch to an existing session
/sessions — List your sessions
/current — Show current session
/fork — Fork current session into a new one
/help — Show this help`

async function handleCommand(cmd: Command, msg: InboundMessage, deps: RouterDeps): Promise<string> {
	const key = buildSessionKey(msg.channel, msg.peerId, msg.threadId)
	const prefix = `${msg.channel}:${msg.peerId}`

	switch (cmd.name) {
		case "new": {
			const id = await deps.sessions.newSession(key, cmd.args || undefined)
			return `Created new session: ${id}`
		}
		case "switch": {
			if (!cmd.args) return "Usage: /switch <session-id>"
			await deps.sessions.switchSession(key, cmd.args)
			return `Switched to session: ${cmd.args}`
		}
		case "sessions": {
			const list = await deps.sessions.listSessions(prefix)
			if (list.length === 0) return "No sessions found."
			return list
				.map((s) => {
					const marker = s.active ? " (active)" : ""
					return `• ${s.id} — ${s.title}${marker}`
				})
				.join("\n")
		}
		case "current": {
			const id = deps.sessions.currentSession(key)
			if (!id) return "No active session. Send a message to create one."
			return `Current session: ${id}`
		}
		case "fork": {
			const current = deps.sessions.currentSession(key)
			if (!current) return "No active session to fork."
			const result = await deps.client.session.fork({
				path: { id: current },
				body: {},
			})
			if (!result.data) return "Fork failed: no data returned."
			const forked = result.data.id
			await deps.sessions.switchSession(key, forked)
			return `Forked into new session: ${forked}`
		}
		case "help": {
			return HELP_TEXT
		}
		default: {
			return `Unknown command: /${cmd.name}\n\n${HELP_TEXT}`
		}
	}
}

async function routeMessage(msg: InboundMessage, deps: RouterDeps): Promise<void> {
	const adapter = deps.adapters.get(msg.channel)
	if (!adapter) {
		deps.logger.warn("router: no adapter for channel", { channel: msg.channel })
		return
	}

	// Allowlist check
	if (!checkAllowlist(deps.config, msg)) {
		const behavior = rejection(deps.config, msg.channel)
		if (behavior === "reject") {
			await adapter.send(msg.peerId, { text: "This assistant is private." })
		}
		deps.logger.debug("router: message dropped (not in allowlist)", {
			channel: msg.channel,
			peerId: msg.peerId,
		})
		return
	}

	// Command interception
	const cmd = parseCommand(msg.text)
	if (cmd) {
		const reply = await handleCommand(cmd, msg, deps)
		await adapter.send(msg.peerId, { text: reply, replyToId: msg.replyToId })
		return
	}

	// Resolve or create session
	const key = buildSessionKey(msg.channel, msg.peerId, msg.threadId)
	const sessionId = await deps.sessions.resolveSession(key)

	deps.logger.debug("router: prompting session", { sessionId, channel: msg.channel })

	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), deps.timeoutMs)

	let result: Awaited<ReturnType<typeof deps.client.session.prompt>>
	try {
		result = await deps.client.session.prompt({
			path: { id: sessionId },
			body: { parts: [{ type: "text", text: msg.text }] },
		})
	} catch (err) {
		clearTimeout(timer)
		if (controller.signal.aborted) {
			deps.logger.warn("router: session prompt timed out", {
				sessionId,
				timeoutMs: deps.timeoutMs,
			})
			await adapter.send(msg.peerId, {
				text: "Request timed out. The agent took too long to respond.",
				replyToId: msg.replyToId,
			})
			return
		}
		throw err
	}
	clearTimeout(timer)

	if (!result.data) {
		deps.logger.error("router: prompt returned no data", { sessionId })
		await adapter.send(msg.peerId, { text: "Error: no response from agent." })
		return
	}

	// Extract text parts from response
	const reply = extractText(result.data.parts)
	if (!reply) {
		deps.logger.warn("router: empty response from agent", { sessionId })
		await adapter.send(msg.peerId, { text: "(empty response)" })
		return
	}

	await adapter.send(msg.peerId, { text: reply, replyToId: msg.replyToId })
}

export function createRouter(deps: RouterDeps) {
	async function handler(msg: InboundMessage): Promise<void> {
		try {
			await routeMessage(msg, deps)
		} catch (err) {
			deps.logger.error("router: unhandled error", {
				channel: msg.channel,
				peerId: msg.peerId,
				error: err instanceof Error ? err.message : String(err),
			})
			// Best-effort error reply
			const adapter = deps.adapters.get(msg.channel)
			if (adapter) {
				await adapter
					.send(msg.peerId, { text: "An internal error occurred. Please try again." })
					.catch(() => {})
			}
		}
	}

	return { handler }
}

export type Router = ReturnType<typeof createRouter>
