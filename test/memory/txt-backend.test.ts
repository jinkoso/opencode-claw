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

	test("persists content to MEMORY.md on disk", async () => {
		await backend.store({
			content: "TypeScript everywhere",
			category: "knowledge",
			source: "agent",
		})
		const raw = await Bun.file(join(dir, "MEMORY.md")).text()
		expect(raw).toContain("TypeScript everywhere")
		expect(raw).toContain("[knowledge]")
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
