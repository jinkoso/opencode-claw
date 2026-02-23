import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { fileExists, readTextFile, writeTextFile } from "../compat.js"
import type {
	MemoryBackend,
	MemoryCategory,
	MemoryEntry,
	MemoryInput,
	MemoryScope,
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

function sanitizeKey(key: string): string {
	return key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
}

function filenameForScope(scope: MemoryScope, projectKey?: string): string {
	if (scope === "tenet") return "tenet.md"
	if (scope === "project") return `project-${sanitizeKey(projectKey ?? "global")}.md`
	return "general.md"
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
	let initialized = false

	function filepath(scope: MemoryScope, projectKey?: string): string {
		return join(directory, filenameForScope(scope, projectKey))
	}

	async function readFile(path: string): Promise<string> {
		if (!(await fileExists(path))) return ""
		return readTextFile(path)
	}

	async function writeFile(path: string, content: string): Promise<void> {
		await writeTextFile(path, content)
	}

	async function readScopedEntries(
		scope: MemoryScope,
		projectKey?: string,
	): Promise<MemoryEntry[]> {
		const raw = await readFile(filepath(scope, projectKey))
		if (!raw) return []
		return parseMemoryFile(raw).map((e) => ({ ...e, scope, projectKey }))
	}

	return {
		async initialize() {
			await mkdir(directory, { recursive: true })
			initialized = true
		},

		async search(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]> {
			const scopeFilter = options?.scope
			const projectKey = options?.projectKey
			const limit = options?.limit ?? 10
			const minScore = options?.minRelevance ?? 0.1

			// Determine which scopes to search
			let scopes: Array<{ scope: MemoryScope; projectKey?: string }>
			if (scopeFilter) {
				scopes = [{ scope: scopeFilter, projectKey }]
			} else {
				// Search all scopes: tenet + project (if projectKey given) + general
				scopes = [{ scope: "tenet" }, { scope: "general" }]
				if (projectKey) {
					scopes.push({ scope: "project", projectKey })
				}
				// Also check legacy MEMORY.md for backward compatibility
			}

			const allEntries: MemoryEntry[] = []
			for (const s of scopes) {
				const entries = await readScopedEntries(s.scope, s.projectKey)
				allEntries.push(...entries)
			}

			// Legacy MEMORY.md fallback (backward compat — read once, treat as "general")
			if (!scopeFilter) {
				const legacyPath = join(directory, "MEMORY.md")
				const legacyRaw = await readFile(legacyPath)
				if (legacyRaw) {
					const legacyEntries = parseMemoryFile(legacyRaw).map((e) => ({
						...e,
						scope: "general" as MemoryScope,
					}))
					allEntries.push(...legacyEntries)
				}
			}

			const scored = allEntries
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
			const scope: MemoryScope = entry.scope ?? "general"
			const path = filepath(scope, entry.projectKey)
			const id = generateId()
			const timestamp = new Date().toISOString()
			const formatted = formatEntry(entry, id, timestamp)

			const existing = await readFile(path)
			const content = existing
				? `${existing.trimEnd()}\n\n${SEPARATOR}${formatted}\n`
				: `${formatted}\n`
			await writeFile(path, content)
		},

		async delete(id: string): Promise<void> {
			// Must search all scope files for the entry
			const scopeCombos: Array<{ scope: MemoryScope; projectKey?: string }> = [
				{ scope: "tenet" },
				{ scope: "general" },
			]

			// Also check all project-*.md files in directory
			try {
				const { readdir } = await import("node:fs/promises")
				const files = await readdir(directory)
				for (const f of files) {
					if (f.startsWith("project-") && f.endsWith(".md")) {
						const key = f.slice("project-".length, -".md".length)
						scopeCombos.push({ scope: "project", projectKey: key })
					}
				}
			} catch {
				// directory may not exist yet, ignore
			}

			// Also handle legacy MEMORY.md
			const legacyPath = join(directory, "MEMORY.md")
			const legacyRaw = await readFile(legacyPath)
			if (legacyRaw) {
				const entries = parseMemoryFile(legacyRaw)
				const filtered = entries.filter((e) => e.id !== id)
				if (filtered.length < entries.length) {
					const content = filtered
						.map((e) => formatEntry(e, e.id, e.createdAt.toISOString()))
						.join(SEPARATOR)
					await writeFile(legacyPath, content ? `${content}\n` : "")
					return
				}
			}

			for (const { scope, projectKey } of scopeCombos) {
				const path = filepath(scope, projectKey)
				const raw = await readFile(path)
				if (!raw) continue

				const entries = parseMemoryFile(raw)
				const filtered = entries.filter((e) => e.id !== id)
				if (filtered.length < entries.length) {
					const content = filtered
						.map((e) => formatEntry(e, e.id, e.createdAt.toISOString()))
						.join(SEPARATOR)
					await writeFile(path, content ? `${content}\n` : "")
					return
				}
			}
		},

		async status(): Promise<MemoryStatus> {
			let total = 0

			for (const scope of ["tenet", "general"] as MemoryScope[]) {
				const raw = await readFile(filepath(scope))
				if (raw) total += parseMemoryFile(raw).length
			}

			// Count project files
			try {
				const { readdir } = await import("node:fs/promises")
				const files = await readdir(directory)
				for (const f of files) {
					if (f.startsWith("project-") && f.endsWith(".md")) {
						const raw = await readFile(join(directory, f))
						if (raw) total += parseMemoryFile(raw).length
					}
				}
			} catch {
				// directory may not exist yet
			}

			// Legacy MEMORY.md
			const legacyRaw = await readFile(join(directory, "MEMORY.md"))
			if (legacyRaw) total += parseMemoryFile(legacyRaw).length

			return {
				backend: "txt",
				initialized,
				entryCount: total,
			}
		},


		async load(scope: MemoryScope, projectKey?: string): Promise<string> {
			return readFile(filepath(scope, projectKey))
		},

		async replace(
			scope: MemoryScope,
			projectKey: string | undefined,
			content: string,
		): Promise<void> {
			const path = filepath(scope, projectKey)
			await writeFile(path, content)
		},

		async close() {
			// No resources to release
		},
	}
}
