import { describe, expect, test } from "bun:test"
import { buildSessionKey, createSessionManager } from "../../src/sessions/manager.js"
import type { SessionInfo } from "../../src/sessions/manager.js"


function makeClient(
	sessions: Array<{ id: string; title: string; time: { created: number; updated: number } }>,
) {
	return {
		session: {
			list: async () => ({ data: sessions }),
			create: async ({ title }: { title: string }) => ({
				data: { id: `new-${title}`, title },
			}),
		},
	} as never
}

const noop = () => {}
const logger = { debug: noop, info: noop, warn: noop, error: noop }


const config = { persistPath: "/dev/null" } as never

describe("listSessions", () => {
	test("returns all sessions from OpenCode, not just map-tracked ones", async () => {
		const remoteSessions = [
			{ id: "ses-a", title: "My session", time: { created: 1000, updated: 2000 } },
			{ id: "ses-ext", title: "External session", time: { created: 3000, updated: 4000 } },
		]

		const map = new Map([["opencode-claw:telegram:alice", "ses-a"]])
		const manager = createSessionManager(makeClient(remoteSessions), config, map, logger)

		const key = "opencode-claw:telegram:alice"
		const list = await manager.listSessions(key)

		expect(list).toHaveLength(2)

		const ids = list.map((s: SessionInfo) => s.id)
		expect(ids).toContain("ses-a")
		expect(ids).toContain("ses-ext")
	})

	test("marks the active session correctly", async () => {
		const remoteSessions = [
			{ id: "ses-a", title: "Active one", time: { created: 1000, updated: 2000 } },
			{ id: "ses-b", title: "Inactive one", time: { created: 1000, updated: 2000 } },
		]
		const key = buildSessionKey("telegram", "alice")
		const map = new Map([[key, "ses-a"]])
		const manager = createSessionManager(makeClient(remoteSessions), config, map, logger)

		const list = await manager.listSessions(key)

		const active = list.filter((s: SessionInfo) => s.active)
		const inactive = list.filter((s: SessionInfo) => !s.active)
		expect(active).toHaveLength(1)
		expect(active[0]?.id).toBe("ses-a")
		expect(inactive).toHaveLength(1)
		expect(inactive[0]?.id).toBe("ses-b")
	})

	test("labels externally-created sessions with key '(external)'", async () => {
		const remoteSessions = [
			{ id: "ses-owned", title: "Owned", time: { created: 1000, updated: 2000 } },
			{ id: "ses-foreign", title: "Foreign", time: { created: 1000, updated: 2000 } },
		]
		const key = buildSessionKey("slack", "bob")
		const map = new Map([[key, "ses-owned"]])
		const manager = createSessionManager(makeClient(remoteSessions), config, map, logger)

		const list = await manager.listSessions(key)

		const foreign = list.find((s: SessionInfo) => s.id === "ses-foreign")
		const owned = list.find((s: SessionInfo) => s.id === "ses-owned")
		expect(foreign?.key).toBe("(external)")
		expect(owned?.key).toBe(key)
	})

	test("returns the session title from the SDK response", async () => {
		const remoteSessions = [
			{ id: "ses-1", title: "Important project", time: { created: 1000, updated: 2000 } },
		]
		const map = new Map<string, string>()
		const manager = createSessionManager(makeClient(remoteSessions), config, map, logger)

		const list = await manager.listSessions("any-key")

		expect(list[0]?.title).toBe("Important project")
	})

	test("returns empty array when OpenCode has no sessions", async () => {
		const map = new Map<string, string>()
		const manager = createSessionManager(makeClient([]), config, map, logger)

		const list = await manager.listSessions("any-key")

		expect(list).toHaveLength(0)
	})

	test("returns createdAt from session time.created", async () => {
		const remoteSessions = [
			{ id: "ses-ts", title: "Timestamped", time: { created: 1700000000, updated: 1700001000 } },
		]
		const map = new Map<string, string>()
		const manager = createSessionManager(makeClient(remoteSessions), config, map, logger)

		const list = await manager.listSessions("any-key")

		expect(list[0]?.createdAt).toBe(1700000000)
	})

	test("no session is active when key has no mapping", async () => {
		const remoteSessions = [
			{ id: "ses-a", title: "Some session", time: { created: 1000, updated: 2000 } },
		]
		const map = new Map<string, string>()
		const manager = createSessionManager(makeClient(remoteSessions), config, map, logger)

		const list = await manager.listSessions("opencode-claw:telegram:nobody")

		expect(list.every((s: SessionInfo) => !s.active)).toBe(true)
	})
})
