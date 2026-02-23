import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { loadConfig } from "../../src/config/loader.js"

const minimalConfig = JSON.stringify({
	channels: {},
})

const configWithWhatsapp = JSON.stringify({
	channels: {
		whatsapp: {
			enabled: true,
			allowlist: ["5511999887766"],
		},
	},
})

let tmpDir: string
let originalEnv: string | undefined

beforeEach(async () => {
	tmpDir = join(tmpdir(), `loader-test-${Date.now()}`)
	await mkdir(tmpDir, { recursive: true })
	originalEnv = process.env.OPENCODE_CLAW_CONFIG
})

afterEach(async () => {
	if (originalEnv === undefined) {
		delete process.env.OPENCODE_CLAW_CONFIG
	} else {
		process.env.OPENCODE_CLAW_CONFIG = originalEnv
	}
	await rm(tmpDir, { recursive: true, force: true })
})

describe("path resolution — relative defaults", () => {
	test("memory.txt.directory is resolved to an absolute path", async () => {
		const configPath = join(tmpDir, "opencode-claw.json")
		await writeFile(configPath, minimalConfig)
		process.env.OPENCODE_CLAW_CONFIG = configPath

		const config = await loadConfig()

		expect(isAbsolute(config.memory.txt.directory)).toBe(true)
	})

	test("memory.txt.directory is anchored to config file's directory", async () => {
		const configPath = join(tmpDir, "opencode-claw.json")
		await writeFile(configPath, minimalConfig)
		process.env.OPENCODE_CLAW_CONFIG = configPath

		const config = await loadConfig()

		expect(config.memory.txt.directory).toBe(join(tmpDir, "data", "memory"))
	})

	test("sessions.persistPath is resolved to an absolute path", async () => {
		const configPath = join(tmpDir, "opencode-claw.json")
		await writeFile(configPath, minimalConfig)
		process.env.OPENCODE_CLAW_CONFIG = configPath

		const config = await loadConfig()

		expect(isAbsolute(config.sessions.persistPath)).toBe(true)
		expect(config.sessions.persistPath).toBe(join(tmpDir, "data", "sessions.json"))
	})

	test("outbox.directory is resolved to an absolute path", async () => {
		const configPath = join(tmpDir, "opencode-claw.json")
		await writeFile(configPath, minimalConfig)
		process.env.OPENCODE_CLAW_CONFIG = configPath

		const config = await loadConfig()

		expect(isAbsolute(config.outbox.directory)).toBe(true)
		expect(config.outbox.directory).toBe(join(tmpDir, "data", "outbox"))
	})

	test("whatsapp.authDir is resolved to an absolute path", async () => {
		const configPath = join(tmpDir, "opencode-claw.json")
		await writeFile(configPath, configWithWhatsapp)
		process.env.OPENCODE_CLAW_CONFIG = configPath

		const config = await loadConfig()

		expect(config.channels.whatsapp).toBeDefined()
		expect(isAbsolute(config.channels.whatsapp!.authDir)).toBe(true)
		expect(config.channels.whatsapp!.authDir).toBe(join(tmpDir, "data", "whatsapp", "auth"))
	})
})

describe("path resolution — explicit relative paths in config", () => {
	test("explicit relative memory directory is anchored to config file dir", async () => {
		const configPath = join(tmpDir, "opencode-claw.json")
		await writeFile(
			configPath,
			JSON.stringify({
				channels: {},
				memory: { txt: { directory: "./my-memory" } },
			}),
		)
		process.env.OPENCODE_CLAW_CONFIG = configPath

		const config = await loadConfig()

		expect(config.memory.txt.directory).toBe(join(tmpDir, "my-memory"))
	})

	test("explicit relative sessions path is anchored to config file dir", async () => {
		const configPath = join(tmpDir, "opencode-claw.json")
		await writeFile(
			configPath,
			JSON.stringify({
				channels: {},
				sessions: { persistPath: "./state/sessions.json" },
			}),
		)
		process.env.OPENCODE_CLAW_CONFIG = configPath

		const config = await loadConfig()

		expect(config.sessions.persistPath).toBe(join(tmpDir, "state", "sessions.json"))
	})
})

describe("path resolution — absolute paths in config are left unchanged", () => {
	test("absolute memory directory is preserved as-is", async () => {
		const absDir = join(tmpDir, "absolute-memory")
		const configPath = join(tmpDir, "opencode-claw.json")
		await writeFile(
			configPath,
			JSON.stringify({
				channels: {},
				memory: { txt: { directory: absDir } },
			}),
		)
		process.env.OPENCODE_CLAW_CONFIG = configPath

		const config = await loadConfig()

		expect(config.memory.txt.directory).toBe(absDir)
	})

	test("absolute sessions.persistPath is preserved as-is", async () => {
		const absPath = join(tmpDir, "state", "sessions.json")
		const configPath = join(tmpDir, "opencode-claw.json")
		await writeFile(
			configPath,
			JSON.stringify({
				channels: {},
				sessions: { persistPath: absPath },
			}),
		)
		process.env.OPENCODE_CLAW_CONFIG = configPath

		const config = await loadConfig()

		expect(config.sessions.persistPath).toBe(absPath)
	})
})

describe("config file discovery via OPENCODE_CLAW_CONFIG", () => {
	test("config file in a non-cwd directory is found and paths resolved relative to it", async () => {
		const subDir = join(tmpDir, "deep", "nested")
		await mkdir(subDir, { recursive: true })
		const configPath = join(subDir, "opencode-claw.json")
		await writeFile(configPath, minimalConfig)
		process.env.OPENCODE_CLAW_CONFIG = configPath

		const config = await loadConfig()

		expect(config.memory.txt.directory).toBe(join(subDir, "data", "memory"))
		expect(config.sessions.persistPath).toBe(join(subDir, "data", "sessions.json"))
		expect(config.outbox.directory).toBe(join(subDir, "data", "outbox"))
	})
})
