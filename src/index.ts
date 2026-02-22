import { createOpencode } from "@opencode-ai/sdk"
import { loadConfig } from "./config/loader.js"
import { createSessionManager } from "./sessions/manager.js"
import { loadSessionMap } from "./sessions/persistence.js"
import { createLogger } from "./utils/logger.js"
import { onShutdown, setupShutdown } from "./utils/shutdown.js"

async function main() {
	const config = await loadConfig()
	const logger = createLogger(config.log)

	logger.info("opencode-claw starting", { version: "0.1.0" })

	// Start OpenCode server + client
	logger.info("opencode: starting server...")
	const { client, server } = await createOpencode({
		port: config.opencode.port,
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

	// TODO Phase 2: start channel adapters
	// TODO Phase 3: register memory plugin
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
