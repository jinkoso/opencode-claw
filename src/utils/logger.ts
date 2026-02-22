import type { LogConfig } from "../config/types.js"

type Level = "debug" | "info" | "warn" | "error"

const levels: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export function createLogger(config: LogConfig) {
	const threshold = levels[config.level]
	const writer = config.file ? Bun.file(config.file).writer() : null

	function write(level: Level, msg: string, data?: Record<string, unknown>) {
		if (levels[level] < threshold) return

		const entry = {
			ts: new Date().toISOString(),
			level,
			msg,
			...data,
		}

		const line = JSON.stringify(entry)

		if (writer) {
			writer.write(`${line}\n`)
			writer.flush()
		} else {
			if (level === "error") console.error(line)
			else console.log(line)
		}
	}

	return {
		debug: (msg: string, data?: Record<string, unknown>) => write("debug", msg, data),
		info: (msg: string, data?: Record<string, unknown>) => write("info", msg, data),
		warn: (msg: string, data?: Record<string, unknown>) => write("warn", msg, data),
		error: (msg: string, data?: Record<string, unknown>) => write("error", msg, data),
	}
}

export type Logger = ReturnType<typeof createLogger>
