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
		expect(output.system.length).toBeGreaterThan(0)
		const joined = output.system.join("")
		expect(joined).toContain("Memory")
		expect(joined).toContain("memory_search")
		expect(joined).toContain("memory_store")
	})

	test("injects general memories as full text when entries exist", async () => {
		await backend.store({
			content: "General fact about tooling",
			category: "knowledge",
			scope: "general",
			source: "agent",
		})

		const transform = plugin["experimental.chat.system.transform"] as (
			input: unknown,
			output: { system: string[] },
		) => Promise<void>
		const output = { system: [] as string[] }
		await transform({}, output)

		const joined = output.system.join("")
		expect(joined).toContain("General Memory")
		expect(joined).toContain("General fact about tooling")
	})

	test("does not auto-inject project memories — only instructs agent to call memory_search", async () => {
		await backend.store({
			content: "Project-specific detail",
			category: "project",
			scope: "project",
			projectKey: "some-repo-hash",
			source: "agent",
		})

		const transform = plugin["experimental.chat.system.transform"] as (
			input: unknown,
			output: { system: string[] },
		) => Promise<void>
		const output = { system: [] as string[] }
		await transform({}, output)

		const joined = output.system.join("")
		// Project content is NOT injected as text
		expect(joined).not.toContain("Project-specific detail")
		// But the instruction to call memory_search is present
		expect(joined).toContain("memory_search")
	})

	test("omits overflow entries and appends a note when general memory exceeds char cap", async () => {
		// Store many long entries to exceed the 4000-char cap
		for (let i = 0; i < 20; i++) {
			await backend.store({
				content: `${"x".repeat(250)} entry-${i}`,
				category: "knowledge",
				scope: "general",
				source: "agent",
			})
		}

		const transform = plugin["experimental.chat.system.transform"] as (
			input: unknown,
			output: { system: string[] },
		) => Promise<void>
		const output = { system: [] as string[] }
		await transform({}, output)

		const joined = output.system.join("")
		expect(joined).toContain("General Memory")
		// Should warn about omitted entries
		expect(joined).toContain("omitted")
		expect(joined).toContain("memory_search")
	})
})

describe("memory_delete tool", () => {
	test("is registered on the plugin", () => {
		expect(plugin.tool?.memory_delete).toBeDefined()
	})

	test("deletes an entry by id", async () => {
		// Store an entry and retrieve its id via memory_search
		const storeTool = plugin.tool?.memory_store
		await storeTool!.execute(
			{ content: "Fact to be deleted", category: "knowledge" },
			makeCtx(),
		)

		const searchTool = plugin.tool?.memory_search
		const searchResult = await searchTool!.execute({ query: "deleted" }, makeCtx())
		expect(searchResult).toContain("Fact to be deleted")

		// Extract the id from the result line: 'id:<id> [knowledge] ...'
		const idMatch = searchResult.match(/^id:([^\s]+)/)
		expect(idMatch).not.toBeNull()
		const entryId = idMatch![1]!

		const deleteTool = plugin.tool?.memory_delete
		const deleteResult = await deleteTool!.execute({ id: entryId }, makeCtx())
		expect(deleteResult).toBe("Memory entry deleted.")

		// Confirm it's gone
		const afterDelete = await searchTool!.execute({ query: "deleted" }, makeCtx())
		expect(afterDelete).toBe("No relevant memories found.")
	})

	test("memory_search output includes id prefix", async () => {
		await backend.store({ content: "Some fact", category: "knowledge", source: "agent" })
		const searchTool = plugin.tool?.memory_search
		const result = await searchTool!.execute({ query: "fact" }, makeCtx())
		expect(result).toMatch(/^id:[^\s]+/)
	})
})

describe("tenet_store tool", () => {
	test("returns confirmation string on success", async () => {
		const tenetStore = plugin.tool?.tenet_store
		expect(tenetStore).toBeDefined()

		const result = await tenetStore!.execute(
			{ content: "Always prefer TypeScript over JavaScript", category: "preference" },
			makeCtx(),
		)
		expect(result).toBe("Tenet stored.")
	})

	test("persists tenet to tenet scope in the backend", async () => {
		const tenetStore = plugin.tool?.tenet_store
		await tenetStore!.execute(
			{ content: "Use ESM modules everywhere", category: "preference" },
			makeCtx(),
		)

		const results = await backend.search("ESM", { scope: "tenet" })
		expect(results.length).toBeGreaterThan(0)
		expect(results[0]?.content).toContain("ESM")
	})
})

describe("tenet_list tool", () => {
	test("returns 'No tenets stored yet.' when empty", async () => {
		const tenetList = plugin.tool?.tenet_list
		expect(tenetList).toBeDefined()

		const result = await tenetList!.execute({}, makeCtx())
		expect(result).toBe("No tenets stored yet.")
	})

	test("lists all stored tenets after storing", async () => {
		const tenetStore = plugin.tool?.tenet_store
		await tenetStore!.execute({ content: "Always use strict mode", category: "preference" }, makeCtx())
		await tenetStore!.execute({ content: "Prefer functional over OOP", category: "preference" }, makeCtx())

		const result = await plugin.tool!.tenet_list!.execute({}, makeCtx())
		expect(result).toContain("Always use strict mode")
		expect(result).toContain("Prefer functional over OOP")
	})

	test("does not list general or project memories", async () => {
		const storeTool = plugin.tool?.memory_store
		await storeTool!.execute({ content: "This is a general fact", category: "knowledge" }, makeCtx())

		const result = await plugin.tool!.tenet_list!.execute({}, makeCtx())
		expect(result).toBe("No tenets stored yet.")
	})
})

describe("memory_store auto-scope", () => {
	test("defaults to general when no projectKey in stub", async () => {
		const storeTool = plugin.tool?.memory_store
		await storeTool!.execute({ content: "Cross-project fact", category: "knowledge" }, makeCtx())

		const general = await backend.search("cross-project", { scope: "general" })
		expect(general.length).toBeGreaterThan(0)
	})

	test("stores to project scope when project.id is in stub", async () => {
		const projectStub = {
			client: {},
			project: { id: "my-repo-hash-abc" },
			directory: dir,
			worktree: dir,
			serverUrl: new URL("http://localhost"),
			$: {},
		} as unknown as PluginInput
		const projectPlugin = await createMemoryPlugin(backend)(projectStub)

		const storeTool = projectPlugin.tool?.memory_store
		await storeTool!.execute({ content: "Repo-specific fact", category: "project" }, makeCtx())

		const results = await backend.search("repo-specific", { scope: "project", projectKey: "my-repo-hash-abc" })
		expect(results.length).toBeGreaterThan(0)
	})
})

describe("memory_load tool", () => {
	test("is registered on the plugin", () => {
		expect(plugin.tool?.memory_load).toBeDefined()
	})

	test("returns empty message when scope has no content", async () => {
		const result = await plugin.tool!.memory_load!.execute({ scope: "general" }, makeCtx())
		expect(result).toBe("(empty \u2014 no memories stored in this scope)")
	})

	test("returns raw file content after storing entries", async () => {
		await backend.store({ content: "Cross-project tooling fact", category: "knowledge", scope: "general", source: "agent" })
		const result = await plugin.tool!.memory_load!.execute({ scope: "general" }, makeCtx())
		expect(result).toContain("Cross-project tooling fact")
	})

	test("loads project scope with current project key by default", async () => {
		const projectStub = {
			client: {},
			project: { id: "proj-hash-xyz" },
			directory: dir,
			worktree: dir,
			serverUrl: new URL("http://localhost"),
			$: {},
		} as unknown as PluginInput
		const projectPlugin = await createMemoryPlugin(backend)(projectStub)
		await backend.store({ content: "Repo detail", category: "project", scope: "project", projectKey: "proj-hash-xyz", source: "agent" })
		const result = await projectPlugin.tool!.memory_load!.execute({ scope: "project" }, makeCtx())
		expect(result).toContain("Repo detail")
	})
})

describe("memory_compact tool", () => {
	test("is registered on the plugin", () => {
		expect(plugin.tool?.memory_compact).toBeDefined()
	})

	test("overwrites general scope with new content", async () => {
		await backend.store({ content: "Old general fact", category: "knowledge", scope: "general", source: "agent" })
		const compactResult = await plugin.tool!.memory_compact!.execute(
			{ scope: "general", content: "Synthesized compact general memory" },
			makeCtx(),
		)
		expect(compactResult).toBe("Compacted general memory.")
		const loaded = await plugin.tool!.memory_load!.execute({ scope: "general" }, makeCtx())
		expect(loaded).toBe("Synthesized compact general memory")
	})

	test("overwrites tenet scope with new content", async () => {
		await backend.store({ content: "Old tenet", category: "preference", scope: "tenet", source: "agent" })
		const result = await plugin.tool!.memory_compact!.execute(
			{ scope: "tenet", content: "New compact tenet content" },
			makeCtx(),
		)
		expect(result).toBe("Compacted tenet memory.")
		const loaded = await plugin.tool!.memory_load!.execute({ scope: "tenet" }, makeCtx())
		expect(loaded).toBe("New compact tenet content")
	})
})

describe("memory_session_projects tool", () => {
	test("is registered on the plugin", () => {
		expect(plugin.tool?.memory_session_projects).toBeDefined()
	})

	test("returns 'No projects recorded' when no project in stub", async () => {
		const result = await plugin.tool!.memory_session_projects!.execute({}, makeCtx())
		expect(result).toBe("No projects recorded in this session.")
	})

	test("tracks project key when plugin is invoked with a project", async () => {
		const projectStub = {
			client: {},
			project: { id: "tracked-proj-hash" },
			directory: dir,
			worktree: dir,
			serverUrl: new URL("http://localhost"),
			$: {},
		} as unknown as PluginInput
		const factory = createMemoryPlugin(backend)
		const projectPlugin = await factory(projectStub)
		const result = await projectPlugin.tool!.memory_session_projects!.execute({}, makeCtx())
		expect(result).toContain("tracked-proj-hash")
	})
})
