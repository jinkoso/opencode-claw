import type { MemoryConfig } from "../config/types.js"
import type {
	MemoryBackend,
	MemoryEntry,
	MemoryInput,
	MemorySearchOptions,
	MemoryStatus,
} from "./types.js"

type OpenVikingConfig = NonNullable<MemoryConfig["openviking"]>

type VikingResponse<T = unknown> = {
	status: "ok" | "error"
	result?: T
	error?: { code: string; message: string }
}

type FindResultItem = {
	uri: string
	content: string
	score: number
	metadata?: Record<string, unknown>
}

type FindResult = {
	items: FindResultItem[]
	total?: number
}

const CATEGORY_TO_PATH: Record<string, string> = {
	project: "patterns",
	experience: "cases",
	preference: "preferences",
	entity: "entities",
	event: "events",
	knowledge: "patterns",
}

const PATH_TO_CATEGORY: Record<string, string> = {
	patterns: "project",
	cases: "experience",
	preferences: "preference",
	entities: "entity",
	events: "event",
}

function mapCategory(category: string): string {
	return CATEGORY_TO_PATH[category] ?? "patterns"
}

function reverseCategory(path: string): string {
	for (const [segment, cat] of Object.entries(PATH_TO_CATEGORY)) {
		if (path.includes(segment)) return cat
	}
	return "knowledge"
}

async function request<T>(
	url: string,
	method: string,
	body?: unknown,
	params?: Record<string, string>,
): Promise<T> {
	let endpoint = url
	if (params) {
		const qs = new URLSearchParams(params).toString()
		if (qs) endpoint = `${url}?${qs}`
	}

	const init: RequestInit = {
		method,
		headers: { "Content-Type": "application/json" },
	}
	if (body !== undefined) {
		init.body = JSON.stringify(body)
	}

	const res = await fetch(endpoint, init)
	const data = (await res.json()) as VikingResponse<T>

	if (data.status === "error") {
		const msg = data.error?.message ?? "Unknown OpenViking error"
		throw new Error(`OpenViking: ${data.error?.code ?? "UNKNOWN"} — ${msg}`)
	}

	return data.result as T
}

export function createOpenVikingBackend(
	config: OpenVikingConfig,
	fallbackDir?: string,
): MemoryBackend {
	const base = config.url.replace(/\/$/, "")
	let available = false
	let fallback: MemoryBackend | undefined

	return {
		async initialize() {
			try {
				await request<unknown>(`${base}/api/v1/sessions`, "GET")
				available = true
			} catch {
				if (config.fallback && fallbackDir) {
					const { createTxtMemoryBackend } = await import("./txt.js")
					fallback = createTxtMemoryBackend(fallbackDir)
					await fallback.initialize()
					available = false
				} else {
					throw new Error(`OpenViking unavailable at ${base} and fallback is disabled`)
				}
			}
		},

		async search(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]> {
			if (fallback) return fallback.search(query, options)

			const result = await request<FindResult>(`${base}/api/v1/search/find`, "POST", {
				query,
				limit: options?.limit ?? 10,
				score_threshold: options?.minRelevance ?? 0.1,
			})

			const items = result.items ?? []
			return items.map((item) => ({
				id: item.uri,
				content: item.content,
				category: reverseCategory(item.uri) as MemoryEntry["category"],
				source: "openviking",
				createdAt: new Date(),
				relevance: item.score,
				metadata: item.metadata,
			}))
		},

		async store(entry: MemoryInput): Promise<void> {
			if (fallback) return fallback.store(entry)

			const session = await request<{ session_id: string }>(`${base}/api/v1/sessions`, "POST", {})
			const sid = session.session_id

			const category = mapCategory(entry.category)
			const tagged = `[${category}] [source:${entry.source}] ${entry.content}`

			await request<unknown>(`${base}/api/v1/sessions/${sid}/messages`, "POST", {
				role: "user",
				content: tagged,
			})

			await request<unknown>(`${base}/api/v1/sessions/${sid}/commit`, "POST")
		},

		async delete(id: string): Promise<void> {
			if (fallback) return fallback.delete(id)

			if (id.startsWith("viking://")) {
				await request<unknown>(`${base}/api/v1/fs`, "DELETE", undefined, {
					uri: id,
					recursive: "false",
				})
			}
		},

		async status(): Promise<MemoryStatus> {
			if (fallback) {
				const s = await fallback.status()
				return { ...s, backend: "openviking (fallback: txt)" }
			}

			try {
				const sessions = await request<unknown[]>(`${base}/api/v1/sessions`, "GET")
				return {
					backend: "openviking",
					initialized: true,
					entryCount: Array.isArray(sessions) ? sessions.length : 0,
				}
			} catch {
				return {
					backend: "openviking",
					initialized: available,
					entryCount: 0,
				}
			}
		},

		async close() {
			if (fallback) await fallback.close()
		},
	}
}
