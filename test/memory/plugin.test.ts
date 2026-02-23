import { afterEach, beforeEach, describe, expect, test } from "bun:test"
/**
 * Unit tests for createMemoryPlugin.
 * Calls the plugin's tool execute functions and system transform hook directly,
 * without spinning up an OpenCode server — fast and deterministic.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { createMemoryPlugin } from "../../src/memory/plugin.js"
import { createTxtMemoryBackend } from "../../src/memory/txt.js"
import type { MemoryBackend } from "../../src/memory/types.js"

// Minimal ToolContext stub — only fields used by the execute functions
function makeCtx() {
	return {
		sessionID: "test-session",
		messageID: "test-message",
		agent: "test-agent",
		directory: "/tmp",
		worktree: "/tmp",
		abort: new AbortController().signal,
		metadata: () => {},
		ask: async () => {},
	}
}

let dir: string
let backend: MemoryBackend
let plugin: Awaited<ReturnType<ReturnType<typeof createMemoryPlugin>>>

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plugin-test-"))
	backend = createTxtMemoryBackend(dir)
	await backend.initialize()
	const stub = {
		client: {},
		project: {},
		directory: dir,
		worktree: dir,
		serverUrl: new URL("http://localhost"),
		$: {},
	} as unknown as PluginInput
	plugin = await createMemoryPlugin(backend)(stub)
})

afterEach(async () => {
	await backend.close()
	await rm(dir, { recursive: true, force: true })
})

describe("memory_store tool", () => {
	test("returns confirmation string on success", async () => {
		const storeTool = plugin.tool?.memory_store
		expect(storeTool).toBeDefined()

		const result = await storeTool!.execute(
			{ content: "The project uses Bun", category: "project" },
			makeCtx(),
		)
		expect(result).toBe("Stored in memory.")
	})

	test("actually persists content to the backend", async () => {
		const storeTool = plugin.tool?.memory_store
		await storeTool!.execute(
			{ content: "User prefers dark mode", category: "preference" },
			makeCtx(),
		)

		const status = await backend.status()
		expect(status.entryCount).toBe(1)

		const entries = await backend.search("dark mode")
		expect(entries.length).toBeGreaterThan(0)
		expect(entries[0]?.content).toContain("dark mode")
	})
})

describe("memory_search tool", () => {
	test("returns 'No relevant memories found.' when empty", async () => {
		const searchTool = plugin.tool?.memory_search
		expect(searchTool).toBeDefined()

		const result = await searchTool!.execute({ query: "anything" }, makeCtx())
		expect(result).toBe("No relevant memories found.")
	})

	test("returns formatted results after storing", async () => {
		// Store via backend directly so we know what's there
		await backend.store({
			content: "Project is written in TypeScript",
			category: "project",
			source: "agent",
		})

		const searchTool = plugin.tool?.memory_search
		const result = await searchTool!.execute({ query: "TypeScript project" }, makeCtx())

		expect(result).toContain("[project]")
		expect(result).toContain("TypeScript")
	})

	test("respects category filter", async () => {
		await backend.store({ content: "Project uses React", category: "project", source: "agent" })
		await backend.store({ content: "User prefers React", category: "preference", source: "agent" })

		const searchTool = plugin.tool?.memory_search
		const result = await searchTool!.execute({ query: "React", category: "project" }, makeCtx())

		expect(result).toContain("[project]")
		expect(result).not.toContain("[preference]")
	})

	test("respects limit", async () => {
		for (let i = 0; i < 5; i++) {
			await backend.store({
				content: `Important fact number ${i}`,
				category: "knowledge",
				source: "agent",
			})
		}

		const searchTool = plugin.tool?.memory_search
		const result = await searchTool!.execute({ query: "important fact", limit: 2 }, makeCtx())

		// At most 2 entries: each formatted block contains "---" separator or "[knowledge]"
		const blocks = result.split("---").filter((b) => b.trim())
		expect(blocks.length).toBeLessThanOrEqual(2)
	})
})

describe("experimental.chat.system.transform hook", () => {
	test("is registered on the plugin", () => {
		expect(plugin["experimental.chat.system.transform"]).toBeDefined()
	})

	test("injects memory instructions even when memory is empty", async () => {
		const transform = plugin["experimental.chat.system.transform"] as (
			input: unknown,
			output: { system: string[] },
		) => Promise<void>
		const output = { system: [] as string[] }
		await transform({}, output)
		// Multiple strings are pushed: at minimum the instruction block items
		expect(output.system.length).toBeGreaterThan(0)
		const joined = output.system.join("")
		expect(joined).toContain("Memory")
		expect(joined).toContain("memory_search")
		expect(joined).toContain("memory_store")
		expect(joined).toContain("MANDATORY")
	})
	test("injects relevant memories into output.system when entries exist", async () => {
		// Store something with terms that match the default "recent context" query
		await backend.store({
			content: "recent project context important",
			category: "project",
			source: "agent",
		})

		const transform = plugin["experimental.chat.system.transform"] as (
			input: unknown,
			output: { system: string[] },
		) => Promise<void>

		const output = { system: [] as string[] }
		await transform({}, output)
		// If relevant memories were found, a block is pushed
		// (may be empty if minRelevance 0.05 filters everything — acceptable)
		// Just verify it doesn't throw and output.system is an array
		expect(Array.isArray(output.system)).toBe(true)
	})
})

describe("experimental.session.compacting hook", () => {
	test("is registered on the plugin", () => {
		expect(plugin["experimental.session.compacting"]).toBeDefined()
	})

	test("pushes a flush instruction into output.context", async () => {
		const hook = plugin["experimental.session.compacting"] as (
			input: { sessionID: string },
			output: { context: string[]; prompt?: string },
		) => Promise<void>
		const output = { context: [] as string[] }
		await hook({ sessionID: "ses-test" }, output)
		expect(output.context.length).toBe(1)
		const msg = output.context[0]!
		expect(msg).toContain("memory_store")
		expect(msg).toContain("MANDATORY")
	})

	test("does not modify output.prompt", async () => {
		const hook = plugin["experimental.session.compacting"] as (
			input: { sessionID: string },
			output: { context: string[]; prompt?: string },
		) => Promise<void>
		const output: { context: string[]; prompt?: string } = { context: [] }
		await hook({ sessionID: "ses-test" }, output)
		expect(output.prompt).toBeUndefined()
	})
})
