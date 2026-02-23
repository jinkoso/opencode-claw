import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createOpencode } from "@opencode-ai/sdk"
import type { Event } from "@opencode-ai/sdk"

export type TestContext = {
	dir: string
	memoryDir: string
	memoryFile: string
	generalFile: string
	tenetFile: string
	configPath: string
	client: Awaited<ReturnType<typeof createOpencode>>["client"]
	server: Awaited<ReturnType<typeof createOpencode>>["server"]
	_prevEnv: string | undefined
}

export async function setup(): Promise<TestContext> {
	const dir = await mkdtemp(join(tmpdir(), "opencode-claw-test-"))
	const memoryDir = join(dir, "memory")
	const memoryFile = join(memoryDir, "MEMORY.md")
	const generalFile = join(memoryDir, "general.md")
	const tenetFile = join(memoryDir, "tenet.md")

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
	// Keep it set for the full test suite lifetime so the plugin always finds the config.
	const _prevEnv = process.env.OPENCODE_CLAW_CONFIG
	process.env.OPENCODE_CLAW_CONFIG = configPath

	const pluginPath = `file://${resolve("./src/memory/plugin-entry.ts")}`

	const { client, server } = await createOpencode({
		port: 0,
		timeout: 30_000,
		config: {
			plugin: [pluginPath],
		},
	})

	return {
		dir,
		memoryDir,
		memoryFile,
		generalFile,
		tenetFile,
		configPath,
		client,
		server,
		_prevEnv,
	}
}

export async function teardown(ctx: TestContext) {
	ctx.server.close()
	// Restore env var
	if (ctx._prevEnv === undefined) {
		delete process.env.OPENCODE_CLAW_CONFIG
	} else {
		process.env.OPENCODE_CLAW_CONFIG = ctx._prevEnv
	}
	await rm(ctx.dir, { recursive: true, force: true })
}

/**
 * Send a prompt to an existing session and wait for session.idle via SSE.
 * Returns the final list of message parts from the session.
 */
export async function promptAndWait(
	ctx: TestContext,
	sessionId: string,
	text: string,
	timeoutMs = 300_000,
): Promise<
	ReadonlyArray<{ type: string; text?: string; tool?: string; state?: { status: string } }>
> {
	const { stream } = await ctx.client.event.subscribe()
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	let timedOut = false

	try {
		await ctx.client.session.promptAsync({
			path: { id: sessionId },
			body: {
				parts: [{ type: "text" as const, text }],
			},
		})
		for await (const raw of stream) {
			if (controller.signal.aborted) {
				timedOut = true
				break
			}

			const event = raw as Event
			if (event.type === "session.error") {
				const { sessionID, error } = event.properties
				if (sessionID && sessionID !== sessionId) continue
				const msg =
					error &&
					"data" in error &&
					typeof (error as { data?: { message?: unknown } }).data?.message === "string"
						? (error as { data: { message: string } }).data.message
						: "unknown session error"
				throw new Error(msg)
			}
			if (event.type === "session.idle") {
				if (event.properties.sessionID !== sessionId) continue
				break
			}
		}
	} finally {
		clearTimeout(timer)
		try { await stream.return(undefined) } catch { /* ignore close errors */ }
	}

	if (timedOut) throw new Error(`promptAndWait timed out after ${timeoutMs}ms`)

	// Fetch final messages
	const msgs = await ctx.client.session.messages({ path: { id: sessionId } })
	if (!msgs.data) return []

	// Collect parts from the last assistant message
	const parts: Array<{ type: string; text?: string; tool?: string; state?: { status: string } }> =
		[]
	for (const msg of msgs.data) {
		for (const part of msg.parts) {
			parts.push(part as { type: string; text?: string; tool?: string; state?: { status: string } })
		}
	}
	return parts
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
