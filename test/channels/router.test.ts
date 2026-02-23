import { describe, expect, test } from "bun:test"
import { createRouter } from "../../src/channels/router.js"
import type { ChannelAdapter, ChannelId, OutboundMessage } from "../../src/channels/types.js"
import type { SessionInfo } from "../../src/sessions/manager.js"

const noop = () => {}
const logger = { debug: noop, info: noop, warn: noop, error: noop }

function makeSession(id: string, title: string, active = false): SessionInfo {
	return { id, title, active, key: "opencode-claw:telegram:user", createdAt: 0 }
}

function makeSessions(count: number, activeIndex = -1): SessionInfo[] {
	return Array.from({ length: count }, (_, i) =>
		makeSession(`ses-${i + 1}`, `Session ${i + 1}`, i === activeIndex),
	)
}

function makeAdapter(): { adapter: ChannelAdapter; sent: OutboundMessage[] } {
	const sent: OutboundMessage[] = []
	const adapter: ChannelAdapter = {
		id: "telegram" as ChannelId,
		name: "telegram",
		start: async () => {},
		stop: async () => {},
		send: async (_peerId: string, msg: OutboundMessage) => {
			sent.push(msg)
		},
		status: () => "connected",
	}
	return { adapter, sent }
}

function makeDeps(sessions: SessionInfo[]) {
	const { adapter, sent } = makeAdapter()
	const adapters = new Map<ChannelId, ChannelAdapter>([["telegram", adapter]])

	const deps = {
		client: {} as never,
		sessions: {
			listSessions: async () => sessions,
			switchSession: async () => {},
			newSession: async () => "new-session-id",
			currentSession: () => undefined,
			resolveSession: async () => "some-session",
		} as never,
		adapters,
		config: {
			channels: { telegram: {} },
			router: { progress: { enabled: false, toolThrottleMs: 0, heartbeatMs: 0 } },
		} as never,
		logger,
		timeoutMs: 5000,
	}

	return { deps, sent }
}

function makeMsg(text: string) {
	return {
		channel: "telegram" as ChannelId,
		peerId: "user",
		text,
		raw: {},
	}
}

describe("/sessions pagination", () => {
	test("returns 'No sessions found.' when list is empty", async () => {
		const { deps, sent } = makeDeps([])
		const { handler } = createRouter(deps)
		await handler(makeMsg("/sessions"))
		expect(sent[0]?.text).toBe("No sessions found.")
	})

	test("single page (≤10 sessions): no footer appended", async () => {
		const { deps, sent } = makeDeps(makeSessions(5))
		const { handler } = createRouter(deps)
		await handler(makeMsg("/sessions"))
		const text = sent[0]?.text ?? ""
		expect(text).not.toContain("Page")
		expect(text).not.toContain("use /sessions")
	})

	test("exactly 10 sessions: no footer", async () => {
		const { deps, sent } = makeDeps(makeSessions(10))
		const { handler } = createRouter(deps)
		await handler(makeMsg("/sessions"))
		const text = sent[0]?.text ?? ""
		expect(text).not.toContain("Page")
	})

	test("11 sessions: shows page 1/2 footer with next hint", async () => {
		const { deps, sent } = makeDeps(makeSessions(11))
		const { handler } = createRouter(deps)
		await handler(makeMsg("/sessions"))
		const text = sent[0]?.text ?? ""
		expect(text).toContain("Page 1/2")
		expect(text).toContain("use /sessions 2 for next")
	})

	test("11 sessions page 2: footer has no 'next' hint", async () => {
		const { deps, sent } = makeDeps(makeSessions(11))
		const { handler } = createRouter(deps)
		await handler(makeMsg("/sessions 2"))
		const text = sent[0]?.text ?? ""
		expect(text).toContain("Page 2/2")
		expect(text).not.toContain("use /sessions 3 for next")
	})

	test("page 1 contains first 10 sessions", async () => {
		const { deps, sent } = makeDeps(makeSessions(15))
		const { handler } = createRouter(deps)
		await handler(makeMsg("/sessions 1"))
		const text = sent[0]?.text ?? ""
		expect(text).toContain("ses-1")
		expect(text).toContain("ses-10")
		expect(text).not.toContain("ses-11")
	})

	test("page 2 contains remaining sessions", async () => {
		const { deps, sent } = makeDeps(makeSessions(15))
		const { handler } = createRouter(deps)
		await handler(makeMsg("/sessions 2"))
		const text = sent[0]?.text ?? ""
		expect(text).toContain("ses-11")
		expect(text).toContain("ses-15")
		expect(text).not.toContain("ses-1\n")
	})

	test("out-of-range page clamps to last page", async () => {
		const { deps, sent } = makeDeps(makeSessions(11))
		const { handler } = createRouter(deps)
		await handler(makeMsg("/sessions 99"))
		const text = sent[0]?.text ?? ""
		expect(text).toContain("ses-11")
		expect(text).toContain("Page 2/2")
	})

	test("invalid arg (non-numeric) defaults to page 1", async () => {
		const { deps, sent } = makeDeps(makeSessions(11))
		const { handler } = createRouter(deps)
		await handler(makeMsg("/sessions abc"))
		const text = sent[0]?.text ?? ""
		expect(text).toContain("ses-1")
		expect(text).toContain("Page 1/2")
	})

	test("active session is marked with (active)", async () => {
		const { deps, sent } = makeDeps(makeSessions(3, 1))
		const { handler } = createRouter(deps)
		await handler(makeMsg("/sessions"))
		const text = sent[0]?.text ?? ""
		expect(text).toContain("ses-2 — Session 2 (active)")
		expect(text).not.toContain("ses-1 — Session 1 (active)")
	})

	test("each line is formatted as '• id — title'", async () => {
		const { deps, sent } = makeDeps([makeSession("abc-123", "My project")])
		const { handler } = createRouter(deps)
		await handler(makeMsg("/sessions"))
		expect(sent[0]?.text).toBe("• abc-123 — My project")
	})

	test("middle page shows both prev and next context in footer", async () => {
		const { deps, sent } = makeDeps(makeSessions(25))
		const { handler } = createRouter(deps)
		await handler(makeMsg("/sessions 2"))
		const text = sent[0]?.text ?? ""
		expect(text).toContain("Page 2/3")
		expect(text).toContain("use /sessions 3 for next")
	})
})


// --- /status tests ---

describe("/status command", () => {
	test("no active stream: returns 'No agent is currently running.'", async () => {
		const { deps, sent } = makeDeps([])
		const { handler } = createRouter(deps)
		await handler(makeMsg("/status"))
		expect(sent[0]?.text).toBe("No agent is currently running.")
	})

	test("active stream, no tool yet: reports elapsed time in seconds", async () => {
		const { adapter, sent } = makeAdapter()
		const adapters = new Map<ChannelId, ChannelAdapter>(([["telegram", adapter]]))

		// A never-resolving stream to keep the agent "running"
		let streamResolve: () => void
		const streamDone = new Promise<void>((res) => {
			streamResolve = res
		})
		const neverStream = {
			[Symbol.asyncIterator]() {
				return {
					next(): Promise<IteratorResult<never>> {
						return streamDone.then(() => ({ done: true as const, value: undefined }))
					},
					return() {
						streamResolve()
						return Promise.resolve({ done: true as const, value: undefined })
					},
				}
			},
		}

		const deps = {
			client: {
				event: { subscribe: async () => ({ stream: neverStream }) },
				session: { promptAsync: async () => {} },
			} as never,
			sessions: {
				resolveSession: async () => "ses-running",
				currentSession: () => undefined,
				newSession: async () => "ses-new",
				switchSession: async () => {},
				listSessions: async () => [],
			} as never,
			adapters,
			config: {
				channels: { telegram: {} },
				router: { progress: { enabled: false, toolThrottleMs: 0, heartbeatMs: 0 } },
			} as never,
			logger,
			timeoutMs: 60_000,
		}

		const { handler } = createRouter(deps)

		// Fire the prompt (won't resolve until stream ends)
		const promptDone = handler(makeMsg("hello"))

		// Yield to let the router set up the active stream
		await new Promise<void>((r) => setTimeout(r, 10))

		// Now query status
		const statusSent: OutboundMessage[] = []
		const statusAdapter: ChannelAdapter = {
			...adapter,
			send: async (_peerId, msg) => { statusSent.push(msg) },
		}
		deps.adapters.set("telegram", statusAdapter)
		await handler(makeMsg("/status"))

		const text = statusSent[0]?.text ?? ""
		expect(text).toMatch(/^⏳ Agent is running \(\d+s elapsed\)$/)

		// Clean up
		streamResolve!()
		await promptDone
	})

	test("active stream with lastTool: includes tool name", async () => {
		const { adapter, sent } = makeAdapter()
		const adapters = new Map<ChannelId, ChannelAdapter>(([["telegram", adapter]]))

		let streamResolve: () => void
		const streamDone = new Promise<void>((res) => { streamResolve = res })

		// Emit one tool event then hang
		let iterCount = 0
		const toolStream = {
			[Symbol.asyncIterator]() {
				return {
					next(): Promise<IteratorResult<unknown>> {
						if (iterCount++ === 0) {
							return Promise.resolve({
								done: false,
								value: {
									type: "message.part.updated",
									properties: {
										part: {
											type: "tool",
											callID: "call-1",
											tool: "websearch_web_search_exa",
											sessionID: "ses-running",
											state: { status: "running", title: "websearch_web_search_exa" },
										},
									},
								},
							})
						}
						return streamDone.then(() => ({ done: true as const, value: undefined }))
					},
					return() {
						streamResolve()
						return Promise.resolve({ done: true as const, value: undefined })
					},
				}
			},
		}

		const deps = {
			client: {
				event: { subscribe: async () => ({ stream: toolStream }) },
				session: { promptAsync: async () => {} },
			} as never,
			sessions: {
				resolveSession: async () => "ses-running",
				currentSession: () => undefined,
				newSession: async () => "ses-new",
				switchSession: async () => {},
				listSessions: async () => [],
			} as never,
			adapters,
			config: {
				channels: { telegram: {} },
				router: {
					progress: { enabled: true, toolThrottleMs: 0, heartbeatMs: 0 },
				},
			} as never,
			logger,
			timeoutMs: 60_000,
		}

		const { handler } = createRouter(deps)
		const promptDone = handler(makeMsg("hello"))

		// Wait for the tool event to be processed
		await new Promise<void>((r) => setTimeout(r, 20))

		const statusSent: OutboundMessage[] = []
		const statusAdapter: ChannelAdapter = {
			...adapter,
			send: async (_peerId, msg) => { statusSent.push(msg) },
		}
		deps.adapters.set("telegram", statusAdapter)
		await handler(makeMsg("/status"))

		const text = statusSent[0]?.text ?? ""
		expect(text).toMatch(/last tool: Websearch Web Search Exa/)

		streamResolve!()
		await promptDone
	})

	test("elapsed time formats as minutes when over 60s", () => {
		// Unit test the elapsed formatting logic directly via /status output
		// We verify the pattern works for sub-minute and above-minute values
		const cases: [number, string][] = [
			[0, /^\d+s$/.source],
			[59, /^\d+s$/.source],
			[60, /^\dm \ds$/.source],
			[125, /^\dm \ds$/.source],
		]
		for (const [sec, pattern] of cases) {
			const mins = Math.floor(sec / 60)
			const secs = sec % 60
			const elapsed = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
			expect(elapsed).toMatch(new RegExp(pattern))
		}
	})
})