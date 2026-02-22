import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createOpencode } from "@opencode-ai/sdk"

export type TestContext = {
	dir: string
	memoryDir: string
	memoryFile: string
	configPath: string
	client: Awaited<ReturnType<typeof createOpencode>>["client"]
	server: Awaited<ReturnType<typeof createOpencode>>["server"]
}

export async function setup(): Promise<TestContext> {
	const dir = await mkdtemp(join(tmpdir(), "opencode-claw-test-"))
	const memoryDir = join(dir, "memory")
	const memoryFile = join(memoryDir, "MEMORY.md")

	// Write a minimal opencode-claw config for the plugin to load
	const configPath = join(dir, "opencode-claw.json")
	await Bun.write(
		configPath,
		JSON.stringify({
			opencode: { port: 0 },
			memory: {
				backend: "txt",
				txt: { directory: memoryDir },
			},
			channels: {},
		}),
	)

	// plugin-entry.ts calls loadConfig() which searches OPENCODE_CLAW_CONFIG first.
	// Set it so the plugin finds the temp config regardless of cwd.
	const prev = process.env.OPENCODE_CLAW_CONFIG
	process.env.OPENCODE_CLAW_CONFIG = configPath

	const pluginPath = `file://${resolve("./src/memory/plugin-entry.ts")}`

	const { client, server } = await createOpencode({
		port: 0,
		timeout: 30_000,
		config: {
			plugin: [pluginPath],
		},
	})

	// Restore so tests don't bleed into each other
	if (prev === undefined) {
		process.env.OPENCODE_CLAW_CONFIG = undefined
	} else {
		process.env.OPENCODE_CLAW_CONFIG = prev
	}

	return { dir, memoryDir, memoryFile, configPath, client, server }
}

export async function teardown(ctx: TestContext) {
	ctx.server.close()
	await rm(ctx.dir, { recursive: true, force: true })
}

export function extractText(parts: ReadonlyArray<{ type: string; text?: string }>): string {
	return parts
		.filter(
			(p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string",
		)
		.map((p) => p.text)
		.join("\n\n")
}

export function findToolParts(
	parts: ReadonlyArray<{ type: string; tool?: string; state?: { status: string } }>,
	toolName: string,
): Array<{ type: string; tool: string; state: { status: string } }> {
	return parts.filter(
		(p): p is { type: string; tool: string; state: { status: string } } =>
			p.type === "tool" && p.tool === toolName,
	)
}

export function hasCompletedTool(
	parts: ReadonlyArray<{ type: string; tool?: string; state?: { status: string } }>,
	toolName: string,
): boolean {
	return findToolParts(parts, toolName).some((p) => p.state.status === "completed")
}
