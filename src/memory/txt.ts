import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type {
	MemoryBackend,
	MemoryCategory,
	MemoryEntry,
	MemoryInput,
	MemorySearchOptions,
	MemoryStatus,
} from "./types.js"

const SEPARATOR = "\n---\n\n"
const HEADER_RE = /^## \[(\w+)\] (\S+) \| source:(.+)$/
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"

function generateId(): string {
	const ts = Date.now().toString(36)
	let suffix = ""
	for (let i = 0; i < 4; i++) {
		suffix += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]
	}
	return `${ts}-${suffix}`
}

function parseMemoryFile(raw: string): MemoryEntry[] {
	const blocks = raw.split(SEPARATOR).filter((b) => b.trim())
	const entries: MemoryEntry[] = []

	for (const block of blocks) {
		const lines = block.trim().split("\n")
		const header = lines[0]
		if (!header) continue

		const match = header.match(HEADER_RE)
		if (!match) continue

		const category = match[1] as MemoryCategory
		const timestamp = match[2] ?? ""
		const source = match[3] ?? ""
		const content = lines.slice(2).join("\n").trim()

		if (!content) continue

		entries.push({
			id: `${timestamp}-${source}`,
			content,
			category,
			source,
			createdAt: new Date(timestamp),
		})
	}

	return entries
}

function formatEntry(entry: MemoryInput, _id: string, timestamp: string): string {
	return `## [${entry.category}] ${timestamp} | source:${entry.source}\n\n${entry.content}`
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/\W+/)
		.filter((t) => t.length > 1)
}

function relevance(query: string, content: string, category: string): number {
	const tokens = tokenize(query)
	if (tokens.length === 0) return 0

	const target = `${category} ${content}`.toLowerCase()
	let hits = 0
	for (const token of tokens) {
		if (target.includes(token)) hits++
	}
	return hits / tokens.length
}

export function createTxtMemoryBackend(directory: string): MemoryBackend {
	const filepath = join(directory, "MEMORY.md")
	let initialized = false

	async function readFile(): Promise<string> {
		const file = Bun.file(filepath)
		if (!(await file.exists())) return ""
		return file.text()
	}

	async function writeFile(content: string): Promise<void> {
		await Bun.write(filepath, content)
	}

	return {
		async initialize() {
			await mkdir(directory, { recursive: true })
			initialized = true
		},

		async search(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]> {
			const raw = await readFile()
			if (!raw) return []

			const entries = parseMemoryFile(raw)
			const limit = options?.limit ?? 10
			const minScore = options?.minRelevance ?? 0.1

			const scored = entries
				.map((entry) => ({
					...entry,
					relevance: relevance(query, entry.content, entry.category),
				}))
				.filter((e) => e.relevance >= minScore)

			if (options?.category) {
				const cat = options.category
				const filtered = scored.filter((e) => e.category === cat)
				filtered.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
				return filtered.slice(0, limit)
			}

			scored.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
			return scored.slice(0, limit)
		},

		async store(entry: MemoryInput): Promise<void> {
			const id = generateId()
			const timestamp = new Date().toISOString()
			const formatted = formatEntry(entry, id, timestamp)

			const existing = await readFile()
			const content = existing
				? `${existing.trimEnd()}\n\n${SEPARATOR}${formatted}\n`
				: `${formatted}\n`
			await writeFile(content)
		},

		async delete(id: string): Promise<void> {
			const raw = await readFile()
			if (!raw) return

			const entries = parseMemoryFile(raw)
			const filtered = entries.filter((e) => e.id !== id)
			if (filtered.length === entries.length) return

			const content = filtered
				.map((e) => formatEntry(e, e.id, e.createdAt.toISOString()))
				.join(SEPARATOR)
			await writeFile(content ? `${content}\n` : "")
		},

		async status(): Promise<MemoryStatus> {
			const raw = await readFile()
			const entries = raw ? parseMemoryFile(raw) : []
			return {
				backend: "txt",
				initialized,
				entryCount: entries.length,
			}
		},

		async close() {
			// No resources to release
		},
	}
}
