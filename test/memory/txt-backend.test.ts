import { afterEach, beforeEach, describe, expect, test } from "bun:test"
/**
 * Unit tests for the txt memory backend.
 * Fast: no OpenCode server, no network, just file I/O.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTxtMemoryBackend } from "../../src/memory/txt.js"
import type { MemoryBackend } from "../../src/memory/types.js"

let dir: string
let backend: MemoryBackend

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "txt-backend-test-"))
	backend = createTxtMemoryBackend(dir)
	await backend.initialize()
})

afterEach(async () => {
	await backend.close()
	await rm(dir, { recursive: true, force: true })
})

describe("initialize", () => {
	test("creates the memory directory", async () => {
		const file = Bun.file(join(dir, "MEMORY.md"))
		// directory exists (initialize was called), file not written yet
		const status = await backend.status()
		expect(status.initialized).toBe(true)
		expect(status.entryCount).toBe(0)
		expect(await file.exists()).toBe(false)
	})
})

describe("store", () => {
	test("stores an entry and reports count", async () => {
		await backend.store({ content: "I prefer TypeScript", category: "preference", source: "agent" })
		const status = await backend.status()
		expect(status.entryCount).toBe(1)
	})

	test("stores multiple entries", async () => {
		await backend.store({ content: "Project uses Bun", category: "project", source: "agent" })
		await backend.store({
			content: "User likes dark mode",
			category: "preference",
			source: "agent",
		})
		const status = await backend.status()
		expect(status.entryCount).toBe(2)
	})

	test("persists content to general.md on disk (default scope)", async () => {
		await backend.store({
			content: "TypeScript everywhere",
			category: "knowledge",
			source: "agent",
		})
		const raw = await Bun.file(join(dir, "general.md")).text()
		expect(raw).toContain("TypeScript everywhere")
		expect(raw).toContain("[knowledge]")
	})

	test("persists tenet-scoped content to tenet.md", async () => {
		await backend.store({
			content: "Always prefer TypeScript over JavaScript",
			category: "preference",
			source: "agent",
			scope: "tenet",
		})
		const raw = await Bun.file(join(dir, "tenet.md")).text()
		expect(raw).toContain("Always prefer TypeScript over JavaScript")
		expect(raw).toContain("[preference]")
	})

	test("persists project-scoped content to project-{key}.md", async () => {
		await backend.store({
			content: "This repo uses Bun as its runtime",
			category: "project",
			source: "agent",
			scope: "project",
			projectKey: "abc123",
		})
		const raw = await Bun.file(join(dir, "project-abc123.md")).text()
		expect(raw).toContain("This repo uses Bun as its runtime")
		expect(raw).toContain("[project]")
	})
})

describe("search", () => {
	test("returns empty array when no entries", async () => {
		const results = await backend.search("anything")
		expect(results).toEqual([])
	})

	test("finds relevant entries by keyword", async () => {
		await backend.store({
			content: "The project uses Bun runtime",
			category: "project",
			source: "agent",
		})
		await backend.store({
			content: "User prefers dark mode",
			category: "preference",
			source: "agent",
		})

		const results = await backend.search("Bun runtime")
		expect(results.length).toBeGreaterThan(0)
		expect(results[0]?.content).toContain("Bun")
	})

	test("filters by category", async () => {
		await backend.store({ content: "Project uses React", category: "project", source: "agent" })
		await backend.store({ content: "User prefers React", category: "preference", source: "agent" })

		const results = await backend.search("React", { category: "project" })
		expect(results.length).toBe(1)
		expect(results[0]?.category).toBe("project")
	})

	test("respects the limit option", async () => {
		for (let i = 0; i < 5; i++) {
			await backend.store({
				content: `Entry number ${i} with common keyword`,
				category: "knowledge",
				source: "agent",
			})
		}

		const results = await backend.search("common keyword", { limit: 2 })
		expect(results.length).toBeLessThanOrEqual(2)
	})

	test("returns results sorted by relevance descending", async () => {
		await backend.store({ content: "Bun is fast", category: "knowledge", source: "agent" })
		await backend.store({
			content: "Bun Bun Bun is very very fast runtime",
			category: "knowledge",
			source: "agent",
		})

		const results = await backend.search("Bun fast")
		expect(results.length).toBeGreaterThan(0)
		for (let i = 1; i < results.length; i++) {
			expect(results[i - 1]?.relevance ?? 0).toBeGreaterThanOrEqual(results[i]?.relevance ?? 0)
		}
	})

	test("minRelevance filters out low-scoring entries", async () => {
		await backend.store({
			content: "Completely unrelated content xyz",
			category: "knowledge",
			source: "agent",
		})
		await backend.store({ content: "Bun runtime is great", category: "knowledge", source: "agent" })

		const results = await backend.search("Bun", { minRelevance: 0.5 })
		// Only the highly relevant entry should appear
		for (const r of results) {
			expect(r.relevance ?? 0).toBeGreaterThanOrEqual(0.5)
		}
	})
})

describe("delete", () => {
	test("removes an entry by id", async () => {
		await backend.store({ content: "To be deleted", category: "knowledge", source: "agent" })
		const before = await backend.search("deleted")
		expect(before.length).toBeGreaterThan(0)

		const id = before[0]!.id
		await backend.delete(id)

		const after = await backend.search("deleted")
		expect(after.find((e) => e.id === id)).toBeUndefined()
	})

	test("no-ops silently when id does not exist", async () => {
		await expect(backend.delete("nonexistent-id")).resolves.toBeUndefined()
	})
})

describe("status", () => {
	test("reports backend name as txt", async () => {
		const status = await backend.status()
		expect(status.backend).toBe("txt")
	})

	test("updates entry count after stores", async () => {
		expect((await backend.status()).entryCount).toBe(0)
		await backend.store({ content: "first", category: "knowledge", source: "agent" })
		expect((await backend.status()).entryCount).toBe(1)
		await backend.store({ content: "second", category: "project", source: "agent" })
		expect((await backend.status()).entryCount).toBe(2)
	})
})

describe("scoped search", () => {
	test("scope:tenet only returns tenet entries", async () => {
		await backend.store({
			content: "Tenet: always use TypeScript",
			category: "preference",
			source: "agent",
			scope: "tenet",
		})
		await backend.store({
			content: "General: TypeScript is great",
			category: "knowledge",
			source: "agent",
			scope: "general",
		})

		const results = await backend.search("TypeScript", { scope: "tenet" })
		expect(results.length).toBe(1)
		expect(results[0]?.content).toContain("Tenet")
	})

	test("scope:general only returns general entries", async () => {
		await backend.store({
			content: "Tenet: use ESM modules",
			category: "preference",
			source: "agent",
			scope: "tenet",
		})
		await backend.store({
			content: "General: ESM is the standard",
			category: "knowledge",
			source: "agent",
			scope: "general",
		})

		const results = await backend.search("ESM", { scope: "general" })
		expect(results.length).toBe(1)
		expect(results[0]?.content).toContain("General")
	})

	test("scope:project only returns entries for the given projectKey", async () => {
		await backend.store({
			content: "Project A: uses React",
			category: "project",
			source: "agent",
			scope: "project",
			projectKey: "proj-a",
		})
		await backend.store({
			content: "Project B: uses Vue",
			category: "project",
			source: "agent",
			scope: "project",
			projectKey: "proj-b",
		})

		const results = await backend.search("uses", { scope: "project", projectKey: "proj-a" })
		expect(results.length).toBe(1)
		expect(results[0]?.content).toContain("React")
	})

	test("unscoped search includes all scopes", async () => {
		await backend.store({
			content: "Tenet knowledge entry",
			category: "knowledge",
			source: "agent",
			scope: "tenet",
		})
		await backend.store({
			content: "General knowledge entry",
			category: "knowledge",
			source: "agent",
			scope: "general",
		})
		await backend.store({
			content: "Project knowledge entry",
			category: "knowledge",
			source: "agent",
			scope: "project",
			projectKey: "test-proj",
		})

		const results = await backend.search("knowledge entry", {
			projectKey: "test-proj",
			minRelevance: 0,
		})
		expect(results.length).toBe(3)
	})

	test("tenet search with empty query and minRelevance:0 returns all tenets", async () => {
		await backend.store({
			content: "First tenet",
			category: "preference",
			source: "agent",
			scope: "tenet",
		})
		await backend.store({
			content: "Second tenet",
			category: "experience",
			source: "agent",
			scope: "tenet",
		})
		await backend.store({
			content: "General note",
			category: "knowledge",
			source: "agent",
			scope: "general",
		})

		const results = await backend.search("", { scope: "tenet", minRelevance: 0 })
		expect(results.length).toBe(2)
	})
})
