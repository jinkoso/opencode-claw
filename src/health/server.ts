import { readdir } from "node:fs/promises"
import { join } from "node:path"
import type { ChannelAdapter, ChannelId } from "../channels/types.js"
import { createHttpServer } from "../compat.js"
import type { OutboxConfig } from "../config/types.js"
import type { MemoryBackend } from "../memory/types.js"
import type { Logger } from "../utils/logger.js"

type HealthDeps = {
	port: number
	adapters: Map<ChannelId, ChannelAdapter>
	memory: MemoryBackend
	outbox: OutboxConfig
	logger: Logger
}

async function countFiles(dir: string): Promise<number> {
	try {
		const entries = await readdir(dir, { recursive: true })
		return entries.filter((e) => e.endsWith(".json")).length
	} catch {
		return 0
	}
}

function channelsInfo(adapters: Map<ChannelId, ChannelAdapter>): Record<string, string> {
	const result: Record<string, string> = {}
	for (const [id, adapter] of adapters) {
		result[id] = adapter.status()
	}
	return result
}

export function createHealthServer(deps: HealthDeps) {
	let srv: ReturnType<typeof createHttpServer> | null = null

	async function handleRequest(req: Request): Promise<Response> {
		const url = new URL(req.url)
		const json = (data: unknown, status = 200) =>
			new Response(JSON.stringify(data, null, 2), {
				status,
				headers: { "content-type": "application/json" },
			})

		switch (url.pathname) {
			case "/health": {
				const channels = channelsInfo(deps.adapters)
				const allConnected = Object.values(channels).every((s) => s === "connected")
				const anyConnected = Object.values(channels).some((s) => s === "connected")
				const status = allConnected ? "up" : anyConnected ? "degraded" : "down"
				return json({ status, uptime: process.uptime() })
			}

			case "/channels": {
				return json(channelsInfo(deps.adapters))
			}

			case "/memory": {
				const info = await deps.memory.status()
				return json(info)
			}

			case "/outbox": {
				const pendingDir = deps.outbox.directory
				const deadDir = join(deps.outbox.directory, "dead")
				const pending = await countFiles(pendingDir)
				const dead = await countFiles(deadDir)
				return json({ pending, dead })
			}

			default: {
				return json({ error: "not found" }, 404)
			}
		}
	}

	function start(): void {
		srv = createHttpServer(deps.port, handleRequest)
		srv.start()
		deps.logger.info("health: server started", { port: deps.port })
	}

	function stop(): void {
		if (srv) {
			srv.stop()
			srv = null
		}
		deps.logger.info("health: server stopped")
	}

	return { start, stop }
}

export type HealthServer = ReturnType<typeof createHealthServer>
