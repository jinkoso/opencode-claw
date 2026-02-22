import type { Logger } from "./logger.js"

type ShutdownFn = () => Promise<void> | void

const handlers: ShutdownFn[] = []
let shuttingDown = false

export function onShutdown(fn: ShutdownFn) {
	handlers.push(fn)
}

export function setupShutdown(logger: Logger) {
	const handler = async () => {
		if (shuttingDown) return
		shuttingDown = true
		logger.info("shutdown: signal received, draining...")

		for (const fn of handlers.reverse()) {
			try {
				await fn()
			} catch (err) {
				logger.error("shutdown: handler failed", {
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}

		logger.info("shutdown: complete")
		process.exit(0)
	}

	process.on("SIGTERM", handler)
	process.on("SIGINT", handler)
}
