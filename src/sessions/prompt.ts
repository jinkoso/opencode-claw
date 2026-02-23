import type { Event, OpencodeClient, QuestionRequest, Todo } from "@opencode-ai/sdk/v2"
import type { Logger } from "../utils/logger.js"

export type ToolProgressCallback = (tool: string, title: string) => Promise<void>
export type HeartbeatCallback = () => Promise<void>
export type QuestionCallback = (question: QuestionRequest) => Promise<Array<Array<string>>>
export type TodoUpdatedCallback = (todos: Todo[]) => Promise<void>

export type ProgressOptions = {
	onToolRunning?: ToolProgressCallback
	onHeartbeat?: HeartbeatCallback
	onQuestion?: QuestionCallback
	onTodoUpdated?: TodoUpdatedCallback
	toolThrottleMs?: number
	heartbeatMs?: number
}

export async function promptStreaming(
	client: OpencodeClient,
	sessionId: string,
	promptText: string,
	timeoutMs: number,
	logger: Logger,
	progress?: ProgressOptions,
): Promise<string> {
	const { stream } = await client.event.subscribe()

	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)

	const textParts = new Map<string, string>()
	const notifiedTools = new Set<string>()
	let lastToolNotifyTime = 0
	let lastActivityTime = Date.now()
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined

	const toolThrottleMs = progress?.toolThrottleMs ?? 5_000
	const heartbeatMs = progress?.heartbeatMs ?? 60_000

	if (progress?.onHeartbeat && heartbeatMs > 0) {
		const onHeartbeat = progress.onHeartbeat
		heartbeatTimer = setInterval(() => {
			const elapsed = Date.now() - lastActivityTime
			if (elapsed >= heartbeatMs) {
				onHeartbeat().catch(() => {})
				lastActivityTime = Date.now()
			}
		}, heartbeatMs)
	}

	function touchActivity() {
		lastActivityTime = Date.now()
	}

	try {
		await client.session.promptAsync({
			sessionID: sessionId,
			parts: [{ type: "text", text: promptText }],
		})

		for await (const raw of stream) {
			if (controller.signal.aborted) {
				throw new Error("timeout")
			}

			const event = raw as Event

			if (event.type === "message.part.delta") {
				const { sessionID, partID, delta } = event.properties
				if (sessionID !== sessionId) continue
				const prev = textParts.get(partID) ?? ""
				textParts.set(partID, prev + delta)
				continue
			}

			if (event.type === "message.part.updated") {
				const { part } = event.properties
				if (part.sessionID !== sessionId) continue

				if (part.type === "text" && part.text) {
					textParts.set(part.id, part.text)
				}

				if (part.type === "tool" && part.state.status === "running" && progress?.onToolRunning) {
					const now = Date.now()
					if (!notifiedTools.has(part.callID) && now - lastToolNotifyTime >= toolThrottleMs) {
						notifiedTools.add(part.callID)
						lastToolNotifyTime = now
						const title = "title" in part.state && part.state.title ? part.state.title : part.tool
						await progress.onToolRunning(part.tool, title).catch(() => {})
						touchActivity()
					}
				}
				continue
			}

			if (event.type === "question.asked") {
				const request = event.properties
				if (request.sessionID !== sessionId) continue

				if (progress?.onQuestion) {
					try {
						const answers = await progress.onQuestion(request)
						await client.question.reply({
							requestID: request.id,
							answers,
						})
						touchActivity()
					} catch {
						await client.question.reject({ requestID: request.id })
					}
				} else {
					await client.question.reject({ requestID: request.id })
				}
				continue
			}
			if (event.type === "todo.updated") {
				const { sessionID, todos } = event.properties
				if (sessionID !== sessionId) continue
				if (progress?.onTodoUpdated) {
					await progress.onTodoUpdated(todos).catch(() => {})
					touchActivity()
				}
				continue
			}

			if (event.type === "session.error") {
				const { sessionID, error } = event.properties
				if (sessionID && sessionID !== sessionId) continue
				if (error && "name" in error && error.name === "MessageAbortedError") {
					throw new Error("aborted")
				}
				const msg =
					error && "data" in error && typeof error.data.message === "string"
						? error.data.message
						: "unknown session error"
				throw new Error(msg)
			}

			if (event.type === "session.idle") {
				if (event.properties.sessionID !== sessionId) continue
				break
			}
		}
	} catch (err) {
		if (controller.signal.aborted || (err instanceof Error && err.message === "timeout")) {
			logger.warn("prompt: session timed out", { sessionId, timeoutMs })
			throw new Error("timeout")
		}
		throw err
	} finally {
		clearTimeout(timer)
		if (heartbeatTimer) clearInterval(heartbeatTimer)
		await stream.return(undefined)
	}

	const parts = [...textParts.values()]
	return parts.join("")
}
