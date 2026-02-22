import type { SessionsConfig } from "../config/types.js"
import type { Logger } from "../utils/logger.js"

export async function loadSessionMap(
	config: SessionsConfig,
	logger: Logger,
): Promise<Map<string, string>> {
	const file = Bun.file(config.persistPath)
	if (!(await file.exists())) {
		logger.debug("sessions: no persisted map found, starting fresh")
		return new Map()
	}

	try {
		const data = (await file.json()) as Record<string, string>
		const map = new Map(Object.entries(data))
		logger.info("sessions: loaded persisted map", { count: map.size })
		return map
	} catch (err) {
		logger.warn("sessions: failed to load persisted map, starting fresh", {
			error: err instanceof Error ? err.message : String(err),
		})
		return new Map()
	}
}

export async function saveSessionMap(
	config: SessionsConfig,
	map: Map<string, string>,
	logger: Logger,
): Promise<void> {
	const data = Object.fromEntries(map)
	await Bun.write(config.persistPath, JSON.stringify(data, null, 2))
	logger.debug("sessions: persisted map", { count: map.size })
}
