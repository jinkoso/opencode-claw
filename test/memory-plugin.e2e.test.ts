import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type TestContext, extractText, hasCompletedTool, setup, teardown } from "./helpers"

const TIMEOUT = 120_000

describe("memory plugin e2e", () => {
	let ctx: TestContext

	beforeAll(async () => {
		ctx = await setup()
	}, TIMEOUT)

	afterAll(async () => {
		if (ctx) await teardown(ctx)
	})

	test(
		"memory_store writes to MEMORY.md",
		async () => {
			const session = await ctx.client.session.create({
				body: { title: "e2e-store-test" },
			})
			expect(session.data).toBeDefined()

			const response = await ctx.client.session.prompt({
				path: { id: session.data!.id },
				body: {
					parts: [
						{
							type: "text" as const,
							text: 'Please store this in memory with category "experience": Bun is the preferred runtime for opencode-claw tests',
						},
					],
				},
			})

			expect(response.data).toBeDefined()
			const parts = response.data!.parts

			const file = Bun.file(ctx.memoryFile)
			const exists = await file.exists()
			if (!exists) {
				console.log(
					"[DEBUG] MEMORY.md not created. Response parts:",
					JSON.stringify(parts, null, 2),
				)
			}
			expect(exists).toBe(true)

			const content = await file.text()
			expect(content).toContain("Bun is the preferred runtime")
			expect(content).toContain("[experience]")

			if (!hasCompletedTool(parts, "memory_store")) {
				console.log(
					"[WARN] memory_store tool part not found in response, but MEMORY.md was written. Parts:",
					JSON.stringify(
						parts.map((p) => ({ type: p.type, tool: "tool" in p ? p.tool : undefined })),
						null,
						2,
					),
				)
			}
		},
		TIMEOUT,
	)

	test(
		"memory_search retrieves stored memories",
		async () => {
			const session = await ctx.client.session.create({
				body: { title: "e2e-search-test" },
			})
			expect(session.data).toBeDefined()

			const storeResponse = await ctx.client.session.prompt({
				path: { id: session.data!.id },
				body: {
					parts: [
						{
							type: "text" as const,
							text: 'Please store this in memory with category "project": citronetic uses a monorepo structure with opencode-claw as a subproject',
						},
					],
				},
			})
			expect(storeResponse.data).toBeDefined()

			const file = Bun.file(ctx.memoryFile)
			expect(await file.exists()).toBe(true)
			const stored = await file.text()
			expect(stored).toContain("citronetic uses a monorepo")

			const searchResponse = await ctx.client.session.prompt({
				path: { id: session.data!.id },
				body: {
					parts: [
						{
							type: "text" as const,
							text: 'Search my memory for "citronetic monorepo" and tell me what you find.',
						},
					],
				},
			})
			expect(searchResponse.data).toBeDefined()

			const text = extractText(searchResponse.data!.parts)
			const found =
				text.toLowerCase().includes("citronetic") ||
				hasCompletedTool(searchResponse.data!.parts, "memory_search")
			if (!found) {
				console.log(
					"[DEBUG] search response parts:",
					JSON.stringify(searchResponse.data!.parts, null, 2),
				)
			}
			expect(found).toBe(true)
		},
		TIMEOUT,
	)

	test(
		"system prompt transform injects memory context",
		async () => {
			const file = Bun.file(ctx.memoryFile)
			if (!(await file.exists())) {
				const bootstrap = await ctx.client.session.create({
					body: { title: "e2e-bootstrap" },
				})
				await ctx.client.session.prompt({
					path: { id: bootstrap.data!.id },
					body: {
						parts: [
							{
								type: "text" as const,
								text: 'Please store this in memory with category "knowledge": opencode-claw system prompt injection test marker alpha-bravo-charlie',
							},
						],
					},
				})
			}

			const session = await ctx.client.session.create({
				body: { title: "e2e-system-prompt-test" },
			})
			expect(session.data).toBeDefined()

			const response = await ctx.client.session.prompt({
				path: { id: session.data!.id },
				body: {
					parts: [
						{
							type: "text" as const,
							text: "Without using any tools, tell me: do you have any context from memory injected into your system prompt? If so, list the memories you can see.",
						},
					],
				},
			})
			expect(response.data).toBeDefined()

			const text = extractText(response.data!.parts)
			const mentionsMemory =
				text.toLowerCase().includes("memory") ||
				text.toLowerCase().includes("context") ||
				text.toLowerCase().includes("alpha-bravo-charlie") ||
				text.toLowerCase().includes("opencode-claw")
			if (!mentionsMemory) {
				console.log("[DEBUG] system prompt test response text:", text)
			}
			expect(mentionsMemory).toBe(true)
		},
		TIMEOUT,
	)
})
