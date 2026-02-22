import { resolve } from "node:path"
import { createOpencode } from "@opencode-ai/sdk"
import { createRouter } from "./channels/router.js"
import { createTelegramAdapter } from "./channels/telegram.js"
import type { ChannelAdapter, ChannelId } from "./channels/types.js"
import { loadConfig } from "./config/loader.js"
import { createMemoryBackend } from "./memory/factory.js"
import { createSessionManager } from "./sessions/manager.js"
import { loadSessionMap } from "./sessions/persistence.js"
import { createLogger } from "./utils/logger.js"
import { onShutdown, setupShutdown } from "./utils/shutdown.js"

async function main() {
	const config = await loadConfig()
	const logger = createLogger(config.log)

	logger.info("opencode-claw starting", { version: "0.1.0" })

	// --- Phase 3: Memory System ---
	const memory = createMemoryBackend(config.memory)
	await memory.initialize()
	logger.info("memory: initialized", { backend: config.memory.backend })

	onShutdown(async () => {
		await memory.close()
	})

	// Start OpenCode server + client with memory plugin
	const pluginPath = `file://${resolve("./src/memory/plugin-entry.ts")}`
	logger.info("opencode: starting server...", { plugins: [pluginPath] })
	const { client, server } = await createOpencode({
		port: config.opencode.port,
		config: { plugin: [pluginPath] },
	})
	logger.info("opencode: server ready")

	onShutdown(async () => {
		logger.info("opencode: shutting down server")
		server.close()
	})

	// Load persisted session map
	const sessionMap = await loadSessionMap(config.sessions, logger)
	const sessions = createSessionManager(client, config.sessions, sessionMap, logger)

	onShutdown(async () => {
		await sessions.persist()
	})

	// Setup graceful shutdown
	setupShutdown(logger)

	// --- Phase 2: Channel Adapters ---
	const adapters = new Map<ChannelId, ChannelAdapter>()

	if (config.channels.telegram?.enabled) {
		const telegram = createTelegramAdapter(config.channels.telegram, logger)
		adapters.set("telegram", telegram)
		onShutdown(async () => {
			await telegram.stop()
		})
	}

	// TODO Phase 4: Slack adapter
	// TODO Phase 4: WhatsApp adapter

	const router = createRouter({ client, sessions, adapters, config, logger })

	// Start all adapters with the router handler
	for (const [id, adapter] of adapters) {
		logger.info(`channel: starting ${id}`)
		await adapter.start(router.handler)
	}

	// Phase 3 memory: wired above via plugin
	// TODO Phase 5: start cron scheduler
	// TODO Phase 5: start outbox drainer

	logger.info("opencode-claw ready", {
		channels: Object.entries(config.channels)
			.filter(([_, v]) => v?.enabled)
			.map(([k]) => k),
		memory: config.memory.backend,
		cron: config.cron?.enabled ?? false,
	})
}

main().catch((err) => {
	console.error("Fatal:", err)
	process.exit(1)
})
