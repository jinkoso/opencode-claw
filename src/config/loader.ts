import { dirname, isAbsolute, resolve } from "node:path"
import { fileExists, readJsonFile } from "../compat.js"
import { configSchema } from "./schema.js"
import type { Config } from "./types.js"

function expand(value: string): string {
	return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
		const env = process.env[name]
		if (env === undefined) throw new Error(`Environment variable "${name}" is not set`)
		return env
	})
}

function expandDeep(obj: unknown): unknown {
	if (typeof obj === "string") return expand(obj)
	if (Array.isArray(obj)) return obj.map(expandDeep)
	if (obj !== null && typeof obj === "object") {
		const result: Record<string, unknown> = {}
		for (const [key, val] of Object.entries(obj)) {
			result[key] = expandDeep(val)
		}
		return result
	}
	return obj
}

export async function loadConfig(): Promise<Config> {
	const searchPaths = [
		process.env.OPENCODE_CLAW_CONFIG,
		"./opencode-claw.json",
		`${process.env.HOME}/.config/opencode-claw/config.json`,
	].filter(Boolean) as string[]

	let raw: unknown = null
	let found = ""

	for (const p of searchPaths) {
		if (await fileExists(p)) {
			raw = await readJsonFile<unknown>(p)
			found = p
			break
		}
	}

	if (!raw) {
		throw new Error(
			[
				"No config file found. Searched:",
				...searchPaths.map((p) => `  - ${p}`),
				"",
				"Copy opencode-claw.example.json to opencode-claw.json and fill in your values.",
			].join("\n"),
		)
	}

	const expanded = expandDeep(raw)
	const result = configSchema.safeParse(expanded)
	if (!result.success) {
		const errors = result.error.issues
			.map((i) => `  - ${i.path.join(".")}: ${i.message}`)
			.join("\n")
		throw new Error(`Config validation failed (${found}):\n${errors}`)
	}

	const data = result.data
	const base = dirname(resolve(found))

	function resolvePath(p: string): string {
		return isAbsolute(p) ? p : resolve(base, p)
	}

	data.memory.txt.directory = resolvePath(data.memory.txt.directory)
	data.sessions.persistPath = resolvePath(data.sessions.persistPath)
	data.outbox.directory = resolvePath(data.outbox.directory)
	if (data.channels.whatsapp) {
		data.channels.whatsapp.authDir = resolvePath(data.channels.whatsapp.authDir)
	}

	return data
}
