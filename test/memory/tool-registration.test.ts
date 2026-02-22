/**
 * E2E test: verifies that the memory plugin registers memory_search and
 * memory_store tools in the OpenCode server's tool registry.
 *
 * Requires a running OpenCode binary in PATH and an LLM provider configured.
 * Uses the SDK's client.tool.ids() endpoint which lists all registered tool IDs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type TestContext, setup, teardown } from "../helpers.js"

let ctx: TestContext

beforeAll(async () => {
	ctx = await setup()
}, 60_000)

afterAll(async () => {
	await teardown(ctx)
})

describe("memory plugin tool registration", () => {
	test("memory_search is registered in the tool registry", async () => {
		const result = await ctx.client.tool.ids()
		expect(result.data).toBeDefined()
		expect(result.data).toContain("memory_search")
	})

	test("memory_store is registered in the tool registry", async () => {
		const result = await ctx.client.tool.ids()
		expect(result.data).toBeDefined()
		expect(result.data).toContain("memory_store")
	})

	test("both memory tools are registered together", async () => {
		const result = await ctx.client.tool.ids()
		const ids = result.data ?? []
		const memoryTools = ids.filter((id) => id.startsWith("memory_"))
		expect(memoryTools).toContain("memory_search")
		expect(memoryTools).toContain("memory_store")
	})
})
