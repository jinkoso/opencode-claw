import { resolve } from "node:path"
import { createOpencode } from "@opencode-ai/sdk"
import { createRouter } from "./channels/router.js"
import { createSlackAdapter } from "./channels/slack.js"
import { createTelegramAdapter } from "./channels/telegram.js"
import type { ChannelAdapter, ChannelId } from "./channels/types.js"
import { createWhatsAppAdapter } from "./channels/whatsapp.js"
import { loadConfig } from "./config/loader.js"
import { createCronScheduler } from "./cron/scheduler.js"
import { createHealthServer } from "./health/server.js"
import { createMemoryBackend } from "./memory/factory.js"
import { createOutboxDrainer } from "./outbox/drainer.js"
import { createOutboxWriter } from "./outbox/writer.js"
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

	if (config.channels.slack?.enabled) {
		const slack = createSlackAdapter(config.channels.slack, logger)
		adapters.set("slack", slack)
		onShutdown(async () => {
			await slack.stop()
		})
	}

	if (config.channels.whatsapp?.enabled) {
		const whatsapp = createWhatsAppAdapter(config.channels.whatsapp, logger)
		adapters.set("whatsapp", whatsapp)
		onShutdown(async () => {
			await whatsapp.stop()
		})
	}

	const router = createRouter({
		client,
		sessions,
		adapters,
		config,
		logger,
		timeoutMs: config.router.timeoutMs,
	})

	// Start all adapters with the router handler
	for (const [id, adapter] of adapters) {
		logger.info(`channel: starting ${id}`)
		await adapter.start(router.handler)
	}

	// --- Phase 4: Outbox ---
	const outbox = createOutboxWriter(config.outbox)
	const drainer = createOutboxDrainer(config.outbox, adapters, logger)
	drainer.start()
	onShutdown(() => {
		drainer.stop()
	})

	// --- Phase 5: Cron ---
	if (config.cron?.enabled) {
		const scheduler = createCronScheduler({
			client,
			outbox,
			config: config.cron,
			logger,
		})
		scheduler.start()
		onShutdown(() => {
			scheduler.stop()
		})
	}

	// --- Phase 7: Health Server ---
	if (config.health?.enabled) {
		const health = createHealthServer({
			port: config.health.port,
			adapters,
			memory,
			outbox: config.outbox,
			logger,
		})
		health.start()
		onShutdown(() => {
			health.stop()
		})
	}

	logger.info("opencode-claw ready", {
		channels: Object.entries(config.channels)
			.filter(([_, v]) => v?.enabled)
			.map(([k]) => k),
		memory: config.memory.backend,
		cron: config.cron?.enabled ?? false,
		health: config.health?.enabled ?? false,
	})
}

main().catch((err) => {
	console.error("Fatal:", err)
	process.exit(1)
})
