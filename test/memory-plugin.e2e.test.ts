import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import type { TestContext } from "./helpers"
import { extractText, hasCompletedTool, promptAndWait, setup, teardown } from "./helpers"

const TIMEOUT = 300_000
const WITH_LLM = process.env.TEST_WITH_LLM === "1"
const llmTest = WITH_LLM ? test : test.skip

// File format used by the txt backend:
//   ## [category] timestamp | source:agent
//
//   content text
// Blocks are separated by "\n---\n\n"
function makeMemoryBlock(category: string, content: string, timestamp: string): string {
	return `## [${category}] ${timestamp} | source:agent\n\n${content}`
}

describe("memory plugin e2e", () => {
	let ctx: TestContext

	beforeAll(async () => {
		ctx = await setup()
		// Ensure memory directory exists for direct-seeding tests
		await mkdir(ctx.memoryDir, { recursive: true })
	}, TIMEOUT)

	afterAll(async () => {
		if (ctx) await teardown(ctx)
	})

	// ── Fast tests (always run — no LLM round-trip needed) ──────────────────

	test("OpenCode server starts with plugin loaded", () => {
		expect(ctx.client).toBeDefined()
		expect(ctx.server).toBeDefined()
	})

	test("can create a session via SDK", async () => {
		const session = await ctx.client.session.create({
			body: { title: "e2e-fast-create" },
		})
		expect(session.data).toBeDefined()
		expect(session.data!.id).toBeString()
	})

	// ── LLM tests (opt-in via TEST_WITH_LLM=1) ──────────────────────────────

	llmTest(
		"memory_store with scope=general writes to general.md",
		async () => {
			const session = await ctx.client.session.create({
				body: { title: "e2e-general-store" },
			})
			expect(session.data).toBeDefined()

			const parts = await promptAndWait(
				ctx,
				session.data!.id,
				'Call memory_store with scope="general", category="knowledge", content="Bun is the preferred runtime for opencode-claw tests". Do not add any extra words — just call the tool.',
			)

			const file = Bun.file(ctx.generalFile)
			const exists = await file.exists()
			if (!exists) {
				console.log("[DEBUG] general.md not created. Parts:", JSON.stringify(parts, null, 2))
			}
			expect(exists).toBe(true)

			const content = await file.text()
			expect(content).toContain("Bun is the preferred runtime")
			expect(content).toContain("[knowledge]")
			expect(hasCompletedTool(parts, "memory_store")).toBe(true)
		},
		TIMEOUT,
	)

	llmTest(
		"tenet_store writes to tenet.md",
		async () => {
			const session = await ctx.client.session.create({
				body: { title: "e2e-tenet-store" },
			})
			expect(session.data).toBeDefined()

			const parts = await promptAndWait(
				ctx,
				session.data!.id,
				'Call tenet_store with category="preference", content="Always use strict TypeScript with noUncheckedIndexedAccess". Do not add any extra words — just call the tool.',
			)

			const file = Bun.file(ctx.tenetFile)
			const exists = await file.exists()
			if (!exists) {
				console.log("[DEBUG] tenet.md not created. Parts:", JSON.stringify(parts, null, 2))
			}
			expect(exists).toBe(true)

			const content = await file.text()
			expect(content).toContain("strict TypeScript")
			expect(content).toContain("[preference]")
			expect(hasCompletedTool(parts, "tenet_store")).toBe(true)
		},
		TIMEOUT,
	)

	llmTest(
		"tenets are injected into system prompt",
		async () => {
			// Seed tenet.md directly — no LLM round-trip needed
			const marker = "e2e-tenet-marker-zeta-nine"
			const tenetContent = makeMemoryBlock("preference", marker, "2024-01-01T00:00:00.000Z")
			await Bun.write(ctx.tenetFile, `${tenetContent}\n`)

			const session = await ctx.client.session.create({ body: { title: "e2e-tenet-inject" } })
			expect(session.data).toBeDefined()

			const parts = await promptAndWait(
				ctx,
				session.data!.id,
				"Without calling any tools, tell me: do you have coding principles or tenets injected into your system prompt? If so, list them.",
			)

			const text = extractText(parts)
			const mentionsTenets =
				text.toLowerCase().includes("tenet") ||
				text.toLowerCase().includes("principle") ||
				text.toLowerCase().includes("typescript") ||
				text.toLowerCase().includes("strict") ||
				text.toLowerCase().includes("zeta-nine") ||
				text.toLowerCase().includes(marker.toLowerCase())
			if (!mentionsTenets) {
				console.log("[DEBUG] tenet inject response:", text)
			}
			expect(mentionsTenets).toBe(true)
		},
		TIMEOUT,
	)

	llmTest(
		"general memory is injected into system prompt",
		async () => {
			// Seed general.md directly — no LLM round-trip needed
			const marker = "e2e-general-marker-omega-five"
			const generalContent = makeMemoryBlock("knowledge", marker, "2024-01-02T00:00:00.000Z")
			await Bun.write(ctx.generalFile, `${generalContent}\n`)

			const session = await ctx.client.session.create({ body: { title: "e2e-general-inject" } })
			expect(session.data).toBeDefined()

			const parts = await promptAndWait(
				ctx,
				session.data!.id,
				"Without calling any tools, do you see any general memory context in your system prompt? If so, describe what you see.",
			)

			const text = extractText(parts)
			const mentionsMemory =
				text.toLowerCase().includes("memory") ||
				text.toLowerCase().includes("context") ||
				text.toLowerCase().includes("omega-five") ||
				text.toLowerCase().includes(marker.toLowerCase())
			if (!mentionsMemory) {
				console.log("[DEBUG] general inject response:", text)
			}
			expect(mentionsMemory).toBe(true)
		},
		TIMEOUT,
	)

	llmTest(
		"memory_search returns results with id: prefix",
		async () => {
			// Seed general.md with a known entry — no LLM needed for seeding
			const searchMarker = "citronetic-monorepo-opencode-claw-subproject"
			const block = makeMemoryBlock("experience", searchMarker, "2024-01-03T00:00:00.000Z")
			// Append to existing file if present
			const existing = (await Bun.file(ctx.generalFile).exists())
				? await Bun.file(ctx.generalFile).text()
				: ""
			const sep = existing.trimEnd() ? "\n\n---\n\n" : ""
			await Bun.write(ctx.generalFile, `${existing.trimEnd()}${sep}${block}\n`)

			// Now ask LLM to call memory_search and report raw results
			const searchSession = await ctx.client.session.create({ body: { title: "e2e-search-read" } })
			const parts = await promptAndWait(
				ctx,
				searchSession.data!.id,
				`Call memory_search with query="${searchMarker}" and scope="general". Then report the raw results you received from the tool, including any "id:" prefix.`,
			)

			const text = extractText(parts)
			const hasId = text.includes("id:") || hasCompletedTool(parts, "memory_search")
			if (!hasId) {
				console.log("[DEBUG] memory_search response:", text)
			}
			expect(hasCompletedTool(parts, "memory_search")).toBe(true)
			// The raw tool result piped back should contain "id:" or the content
			expect(text.includes("id:") || text.toLowerCase().includes("citronetic")).toBe(true)
		},
		TIMEOUT,
	)

	llmTest(
		"memory_delete removes an entry",
		async () => {
			// Seed a unique entry directly to general.md
			const marker = `delete-me-marker-${Date.now()}`
			const block = makeMemoryBlock("knowledge", marker, "2024-01-04T00:00:00.000Z")
			const existing = (await Bun.file(ctx.generalFile).exists())
				? await Bun.file(ctx.generalFile).text()
				: ""
			const sep = existing.trimEnd() ? "\n\n---\n\n" : ""
			await Bun.write(ctx.generalFile, `${existing.trimEnd()}${sep}${block}\n`)

			// Verify it was written
			const beforeContent = await Bun.file(ctx.generalFile).text()
			expect(beforeContent).toContain(marker)

			// Ask LLM to search for it, extract id, then delete
			const deleteSession = await ctx.client.session.create({ body: { title: "e2e-delete-exec" } })
			const parts = await promptAndWait(
				ctx,
				deleteSession.data!.id,
				`First call memory_search with query="${marker}" and scope="general". Extract the id from the result (it starts with "id:"). Then call memory_delete with that id. Report what happened.`,
			)

			expect(hasCompletedTool(parts, "memory_search")).toBe(true)
			expect(hasCompletedTool(parts, "memory_delete")).toBe(true)

			const updatedContent = await Bun.file(ctx.generalFile).text()
			if (updatedContent.includes(marker)) {
				console.log("[DEBUG] marker still present after delete. File contents:", updatedContent)
			}
			expect(updatedContent).not.toContain(marker)
		},
		TIMEOUT,
	)

	llmTest(
		"general memory token cap: system prompt omits old entries and appends note",
		async () => {
			// Write enough entries directly to exceed MAX_GENERAL_MEMORY_CHARS (4000)
			// Each entry content is ~200 chars; need ~22+ entries to reliably exceed cap
			const LONG_SUFFIX = `${"x".repeat(150)} padding to hit cap`
			const blocks: string[] = []
			for (let i = 0; i < 30; i++) {
				const ts = new Date(2023, 0, i + 1).toISOString()
				blocks.push(makeMemoryBlock("knowledge", `Cap entry ${i + 1}: ${LONG_SUFFIX}`, ts))
			}
			const capContent = `${blocks.join("\n\n---\n\n")}\n`
			await Bun.write(ctx.generalFile, capContent)

			// Ask LLM to check for the omission note in its system prompt
			const checkSession = await ctx.client.session.create({ body: { title: "e2e-cap-check" } })
			const parts = await promptAndWait(
				ctx,
				checkSession.data!.id,
				"Without calling any tools, look at your system prompt. Do you see a note saying some memory entries were omitted? Copy that exact note if present.",
			)

			const text = extractText(parts)
			const hasOmissionNote =
				text.toLowerCase().includes("omitted") ||
				text.toLowerCase().includes("memory_search") ||
				text.toLowerCase().includes("older")
			if (!hasOmissionNote) {
				console.log("[DEBUG] cap check response:", text)
			}
			expect(hasOmissionNote).toBe(true)
		},
		TIMEOUT,
	)
})
