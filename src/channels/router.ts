import type { OpencodeClient, QuestionRequest, Todo } from "@opencode-ai/sdk/v2"
import type { Config } from "../config/types.js"
import type { SessionManager } from "../sessions/manager.js"
import { buildSessionKey } from "../sessions/manager.js"
import { promptStreaming } from "../sessions/prompt.js"
import type { ProgressOptions } from "../sessions/prompt.js"
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
	if (!list || list.length === 0) return true
	return list.includes(msg.senderId ?? msg.peerId)
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

const PAGE_SIZE = 10
const HELP_TEXT = `Available commands:
/new [title] — Create a new session
/switch <id> — Switch to an existing session
/sessions [page] — List your sessions (paginated)
/current — Show current session
/status — Show current agent run status
/fork — Fork current session into a new one
/cancel — Abort the currently running agent
/help — Show this help`

type ActiveStreamMeta = {
	startedAt: number
	lastTool: string | undefined
}

// peerKey uniquely identifies a peer within a channel for active-stream tracking
function peerKey(channel: ChannelId, peerId: string): string {
	return `${channel}:${peerId}`
}

async function handleCommand(
	cmd: Command,
	msg: InboundMessage,
	deps: RouterDeps,
	activeStreams: Map<string, string>,
	activeStreamsMeta: Map<string, ActiveStreamMeta>,
): Promise<string> {
	const sessionThreadId = msg.channel === "slack" ? undefined : msg.threadId
	const key = buildSessionKey(msg.channel, msg.peerId, sessionThreadId)
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
			const list = await deps.sessions.listSessions(key)
			if (list.length === 0) return "No sessions found."
			const page = Math.max(1, Number.parseInt(cmd.args) || 1)
			const totalPages = Math.ceil(list.length / PAGE_SIZE)
			const clamped = Math.min(page, totalPages)
			const slice = list.slice((clamped - 1) * PAGE_SIZE, clamped * PAGE_SIZE)
			const lines = slice.map((s) => {
				const marker = s.active ? " (active)" : ""
				return `• ${s.id} — ${s.title}${marker}`
			})
			if (totalPages > 1) {
				lines.push(
					`\nPage ${clamped}/${totalPages}${clamped < totalPages ? ` — use /sessions ${clamped + 1} for next` : ""}`,
				)
			}
			return lines.join("\n")
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
				sessionID: current,
			})
			if (!result.data) return "Fork failed: no data returned."
			const forked = result.data.id
			await deps.sessions.switchSession(key, forked)
			return `Forked into new session: ${forked}`
		}
		case "cancel": {
			const pk = peerKey(msg.channel, msg.peerId)
			const sessionId = activeStreams.get(pk)
			if (!sessionId) return "No agent is currently running."
			const result = await deps.client.session.abort({ sessionID: sessionId })
			const aborted = result.data ?? false
			deps.logger.info("router: session aborted by user", { sessionId, aborted })
			return aborted ? "Agent aborted." : "Abort request sent (agent may already be done)."
		}
		case "status": {
			const pk = peerKey(msg.channel, msg.peerId)
			const sessionId = activeStreams.get(pk)
			if (!sessionId) return "No agent is currently running."
			const meta = activeStreamsMeta.get(pk)
			const elapsedSec = meta ? Math.floor((Date.now() - meta.startedAt) / 1000) : 0
			const mins = Math.floor(elapsedSec / 60)
			const secs = elapsedSec % 60
			const elapsed = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
			const tool = meta?.lastTool ? ` — last tool: ${humanizeToolName(meta.lastTool)}` : ""
			return `⏳ Agent is running (${elapsed} elapsed${tool})`
		}
		case "help": {
			return HELP_TEXT
		}
		default: {
			return `Unknown command: /${cmd.name}\n\n${HELP_TEXT}`
		}
	}
}

/** Turn raw MCP tool names like `websearch_web_search_exa` into `Web Search Exa`. */
function humanizeToolName(raw: string): string {
	if (raw.includes(" ")) return raw
	return raw.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatTodoList(todos: Todo[]): string {
	if (todos.length === 0) return "📋 Todo list cleared."
	const icons: Record<string, string> = {
		completed: "✅",
		in_progress: "🔄",
		pending: "⬜",
		cancelled: "❌",
	}
	const lines = todos.map((t) => {
		const icon = icons[t.status] ?? "•"
		return `${icon} [${t.priority}] ${t.content}`
	})
	return `📋 **Todos**\n${lines.join("\n")}`
}

type QuestionResolver = {
	resolve: (text: string) => void
	timeout: ReturnType<typeof setTimeout>
}
async function routeMessage(
	msg: InboundMessage,
	deps: RouterDeps,
	activeStreams: Map<string, string>,
	activeStreamsMeta: Map<string, ActiveStreamMeta>,
	pendingQuestions: Map<string, QuestionResolver>,
): Promise<void> {
	const adapter = deps.adapters.get(msg.channel)
	if (!adapter) {
		deps.logger.warn("router: no adapter for channel", { channel: msg.channel })
		return
	}

	// Allowlist check
	if (!checkAllowlist(deps.config, msg)) {
		const behavior = rejection(deps.config, msg.channel)
		if (behavior === "reject") {
			await adapter.send(msg.peerId, { text: "This assistant is private.", threadId: msg.threadId })
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
		const reply = await handleCommand(cmd, msg, deps, activeStreams, activeStreamsMeta)
		await adapter.send(msg.peerId, {
			text: reply,
			replyToId: msg.replyToId,
			threadId: msg.threadId,
		})
		return
	}

	// Resolve or create session
	const sessionThreadId = msg.channel === "slack" ? undefined : msg.threadId
	const key = buildSessionKey(msg.channel, msg.peerId, sessionThreadId)
	const sessionId = await deps.sessions.resolveSession(key)

	deps.logger.debug("router: prompting session", { sessionId, channel: msg.channel })

	const pk = peerKey(msg.channel, msg.peerId)
	activeStreams.set(pk, sessionId)
	activeStreamsMeta.set(pk, { startedAt: Date.now(), lastTool: undefined })
	// Start typing indicator
	if (adapter.sendTyping) {
		await adapter.sendTyping(msg.peerId).catch(() => {})
	}

	const progressEnabled = deps.config.router.progress.enabled

	function formatQuestion(request: QuestionRequest): string {
		const lines: string[] = ["❓ The agent has a question:"]
		for (const q of request.questions) {
			lines.push("")
			if (q.header) lines.push(`**${q.header}**`)
			lines.push(q.question)
			if (q.options && q.options.length > 0) {
				for (let i = 0; i < q.options.length; i++) {
					const opt = q.options[i]
					if (opt) {
						lines.push(`  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}`)
					}
				}
			}
			if (q.multiple) lines.push("(You can pick multiple — separate with commas)")
		}
		lines.push("")
		lines.push("Reply with your answer:")
		return lines.join("\n")
	}

	function waitForUserReply(questionTimeoutMs: number): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				pendingQuestions.delete(pk)
				reject(new Error("question_timeout"))
			}, questionTimeoutMs)
			pendingQuestions.set(pk, { resolve, timeout: timer })
		})
	}

	const progress: ProgressOptions | undefined = progressEnabled
		? {
				onToolRunning: (_tool, title) => {
					const meta = activeStreamsMeta.get(pk)
					if (meta) meta.lastTool = title
					return adapter.send(msg.peerId, {
						text: `🔧 ${humanizeToolName(title)}...`,
						replyToId: msg.replyToId,
					})
				},
				onHeartbeat: async () => {
					if (adapter.sendTyping) {
						await adapter.sendTyping(msg.peerId).catch(() => {})
					}
					await adapter.send(msg.peerId, { text: "⏳ Still working...", threadId: msg.threadId })
				},
				onQuestion: async (request) => {
					const text = formatQuestion(request)
					await adapter.send(msg.peerId, { text, threadId: msg.threadId })
					const userReply = await waitForUserReply(deps.timeoutMs)
					return request.questions.map(() => [userReply])
				},
				toolThrottleMs: deps.config.router.progress.toolThrottleMs,
				heartbeatMs: deps.config.router.progress.heartbeatMs,
				onTodoUpdated: async (todos) => {
					const text = formatTodoList(todos)
					await adapter.send(msg.peerId, { text, threadId: msg.threadId })
				},
			}
		: undefined
	let reply: string
	try {
		reply = await promptStreaming(
			deps.client,
			sessionId,
			msg.text,
			deps.timeoutMs,
			deps.logger,
			progress,
		)
	} catch (err) {
		if (err instanceof Error && err.message === "timeout") {
			await adapter.send(msg.peerId, {
				text: "Request timed out. The agent took too long to respond.",
				replyToId: msg.replyToId,
				threadId: msg.threadId,
			})
			return
		}
		if (err instanceof Error && err.message === "aborted") {
			// Already notified via /cancel reply; nothing more to send
			return
		}
		throw err
	} finally {
		activeStreams.delete(pk)
		activeStreamsMeta.delete(pk)
		pendingQuestions.delete(pk)
		if (adapter.stopTyping) {
			await adapter.stopTyping(msg.peerId).catch(() => {})
		}
	}

	if (!reply) {
		deps.logger.warn("router: empty response from agent", { sessionId })
		await adapter.send(msg.peerId, { text: "(empty response)", threadId: msg.threadId })
		return
	}

	await adapter.send(msg.peerId, { text: reply, replyToId: msg.replyToId, threadId: msg.threadId })
}

export function createRouter(deps: RouterDeps) {
	// Tracks which sessionId is currently streaming for each channel:peerId pair
	const activeStreams = new Map<string, string>()
	// Tracks timing + last tool for each active stream
	const activeStreamsMeta = new Map<string, ActiveStreamMeta>()
	// Tracks pending question resolvers — when agent asks a question, user's next message resolves it
	const pendingQuestions = new Map<string, QuestionResolver>()
	async function handler(msg: InboundMessage): Promise<void> {
		try {
			// Check if this message is a reply to a pending question
			const pk = peerKey(msg.channel, msg.peerId)
			const pending = pendingQuestions.get(pk)
			if (pending) {
				clearTimeout(pending.timeout)
				pendingQuestions.delete(pk)
				pending.resolve(msg.text)
				return
			}

			await routeMessage(msg, deps, activeStreams, activeStreamsMeta, pendingQuestions)
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
