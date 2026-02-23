import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import type { SessionsConfig } from "../config/types.js"
import type { Logger } from "../utils/logger.js"
import { saveSessionMap } from "./persistence.js"

export type SessionInfo = {
	id: string
	key: string
	title: string
	active: boolean
	createdAt?: number
}

export function buildSessionKey(channel: string, peerId: string, threadId?: string): string {
	const base = `opencode-claw:${channel}:${peerId}`
	if (threadId) return `${base}:thread:${threadId}`
	return base
}

export function createSessionManager(
	client: OpencodeClient,
	config: SessionsConfig,
	map: Map<string, string>,
	logger: Logger,
) {
	async function persist() {
		await saveSessionMap(config, map, logger)
	}

	async function resolveSession(key: string, title?: string): Promise<string> {
		const existing = map.get(key)
		if (existing) return existing

		const session = await client.session.create({
			title: title ?? key,
		})
		if (!session.data) throw new Error("session.create returned no data")
		map.set(key, session.data.id)
		await persist()
		logger.info("sessions: created new session", { key, id: session.data.id })
		return session.data.id
	}

	async function switchSession(key: string, targetId: string) {
		map.set(key, targetId)
		await persist()
		logger.info("sessions: switched session", { key, targetId })
	}

	async function newSession(key: string, title?: string): Promise<string> {
		const session = await client.session.create({
			title: title ?? `New session ${new Date().toISOString()}`,
		})
		if (!session.data) throw new Error("session.create returned no data")
		map.set(key, session.data.id)
		await persist()
		logger.info("sessions: created and switched to new session", { key, id: session.data.id })
		return session.data.id
	}

	async function listSessions(key: string): Promise<SessionInfo[]> {
		const all = await client.session.list()
		const sessions = all.data ?? []
		const activeId = map.get(key)

		return sessions.map((s) => ({
			id: s.id,
			key: [...map.entries()].find(([, id]) => id === s.id)?.[0] ?? "(external)",
			title: s.title ?? s.id,
			active: s.id === activeId,
			createdAt: s.time.created,
		}))
	}

	function currentSession(key: string): string | undefined {
		return map.get(key)
	}

	return {
		resolveSession,
		switchSession,
		newSession,
		listSessions,
		currentSession,
		persist,
	}
}

export type SessionManager = ReturnType<typeof createSessionManager>
