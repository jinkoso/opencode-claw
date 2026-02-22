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

const searchPaths = [
	process.env.OPENCODE_CLAW_CONFIG,
	"./opencode-claw.json",
	`${process.env.HOME}/.config/opencode-claw/config.json`,
].filter(Boolean) as string[]

export async function loadConfig(): Promise<Config> {
	let raw: unknown = null
	let found = ""

	for (const p of searchPaths) {
		const file = Bun.file(p)
		if (await file.exists()) {
			raw = await file.json()
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

	return result.data
}
