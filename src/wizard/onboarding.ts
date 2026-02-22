import { access, writeFile } from "node:fs/promises"
import type { WizardPrompter } from "./prompts.js"

type ChannelId = "telegram" | "slack" | "whatsapp"

type TelegramConfig = {
	enabled: boolean
	botToken: string
	allowlist: string[]
	mode: "polling" | "webhook"
	rejectionBehavior: "ignore" | "reject"
}

type SlackConfig = {
	enabled: boolean
	botToken: string
	appToken: string
	mode: "socket" | "http"
	rejectionBehavior: "ignore" | "reject"
}

type WhatsAppConfig = {
	enabled: boolean
	allowlist: string[]
	authDir: string
	debounceMs: number
	rejectionBehavior: "ignore" | "reject"
}

type ChannelsConfig = {
	telegram?: TelegramConfig
	slack?: SlackConfig
	whatsapp?: WhatsAppConfig
}

type MemoryConfig =
	| { backend: "txt" }
	| { backend: "openviking"; openviking: { url: string; fallback: boolean } }

type ConfigShape = {
	opencode: { port: number }
	memory: MemoryConfig
	channels: ChannelsConfig
	cron?: { enabled: boolean; defaultTimeoutMs: number; jobs: [] }
}

const ALL_CAPS_RE = /^[A-Z][A-Z0-9_]*$/

function resolveTokenValue(input: string): string {
	const trimmed = input.trim()
	if (trimmed.startsWith("${") && trimmed.endsWith("}")) return trimmed
	if (trimmed.startsWith("$")) return `\${${trimmed.slice(1)}}`
	if (ALL_CAPS_RE.test(trimmed)) return `\${${trimmed}}`
	return trimmed
}

function splitAllowlist(raw: string): string[] {
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
}

async function collectTelegramConfig(p: WizardPrompter): Promise<TelegramConfig> {
	const rawToken = await p.text({
		message: "Telegram bot token (paste value or env var name like TELEGRAM_BOT_TOKEN):",
		placeholder: "TELEGRAM_BOT_TOKEN",
		validate: (v) => (v.trim().length === 0 ? "Required" : undefined),
	})
	const botToken = resolveTokenValue(rawToken)

	const rawAllowlist = await p.text({
		message: "Allowed Telegram usernames (comma-separated, leave blank for none):",
		placeholder: "alice,bob",
	})

	return {
		enabled: true,
		botToken,
		allowlist: splitAllowlist(rawAllowlist),
		mode: "polling",
		rejectionBehavior: "ignore",
	}
}

async function collectSlackConfig(p: WizardPrompter): Promise<SlackConfig> {
	const rawBotToken = await p.text({
		message: "Slack bot token (xoxb-... or env var name like SLACK_BOT_TOKEN):",
		placeholder: "SLACK_BOT_TOKEN",
		validate: (v) => (v.trim().length === 0 ? "Required" : undefined),
	})
	const botToken = resolveTokenValue(rawBotToken)

	const rawAppToken = await p.text({
		message: "Slack app token (xapp-... or env var name like SLACK_APP_TOKEN):",
		placeholder: "SLACK_APP_TOKEN",
		validate: (v) => (v.trim().length === 0 ? "Required" : undefined),
	})
	const appToken = resolveTokenValue(rawAppToken)

	return {
		enabled: true,
		botToken,
		appToken,
		mode: "socket",
		rejectionBehavior: "ignore",
	}
}

async function collectWhatsAppConfig(p: WizardPrompter): Promise<WhatsAppConfig> {
	const rawAllowlist = await p.text({
		message: "Allowed phone numbers (comma-separated with country code, e.g. 5511999887766):",
		placeholder: "5511999887766,441234567890",
		validate: (v) => (v.trim().length === 0 ? "Required" : undefined),
	})

	return {
		enabled: true,
		allowlist: splitAllowlist(rawAllowlist),
		authDir: "./data/whatsapp/auth",
		debounceMs: 1000,
		rejectionBehavior: "ignore",
	}
}

async function collectChannels(p: WizardPrompter): Promise<ChannelsConfig> {
	const channels: ChannelsConfig = {}
	const configured = new Set<ChannelId>()

	const channelOptions = [
		{ value: "telegram" as ChannelId, label: "Telegram", hint: "requires bot token" },
		{ value: "slack" as ChannelId, label: "Slack", hint: "requires bot + app token" },
		{ value: "whatsapp" as ChannelId, label: "WhatsApp", hint: "scan QR on first run" },
		{ value: "skip" as const, label: "Skip — no channels now" },
	]

	let configureMore = true

	while (configureMore) {
		const available = channelOptions.filter(
			(o) => o.value === "skip" || !configured.has(o.value as ChannelId),
		)

		const choice = await p.select({
			message: "Which channel would you like to configure?",
			options: available,
		})

		if (choice === "skip") break

		const channelId = choice as ChannelId

		if (channelId === "telegram") {
			channels.telegram = await collectTelegramConfig(p)
			configured.add("telegram")
		} else if (channelId === "slack") {
			channels.slack = await collectSlackConfig(p)
			configured.add("slack")
		} else if (channelId === "whatsapp") {
			channels.whatsapp = await collectWhatsAppConfig(p)
			configured.add("whatsapp")
		}

		const allChannels: ChannelId[] = ["telegram", "slack", "whatsapp"]
		const remaining = allChannels.filter((c) => !configured.has(c))

		if (remaining.length === 0) break

		configureMore = await p.confirm({
			message: "Configure another channel?",
			initialValue: false,
		})
	}

	return channels
}

async function collectMemoryConfig(p: WizardPrompter): Promise<MemoryConfig> {
	const backend = await p.select({
		message: "Memory backend:",
		options: [
			{ value: "txt" as const, label: "Text files (simple, zero deps)" },
			{ value: "openviking" as const, label: "OpenViking (semantic search)" },
		],
		initialValue: "txt" as const,
	})

	if (backend === "openviking") {
		const url = await p.text({
			message: "OpenViking URL:",
			initialValue: "http://localhost:8100",
			validate: (v) => {
				try {
					new URL(v)
					return undefined
				} catch {
					return "Must be a valid URL"
				}
			},
		})

		const fallback = await p.confirm({
			message: "Fall back to text files if OpenViking is unreachable?",
			initialValue: true,
		})

		return { backend: "openviking", openviking: { url, fallback } }
	}

	return { backend: "txt" }
}

export async function runOnboardingWizard(p: WizardPrompter): Promise<void> {
	const configPath = "./opencode-claw.json"
	let existingConfigFound = false
	try {
		await access(configPath)
		existingConfigFound = true
	} catch {
		// file doesn't exist — proceed
	}

	if (existingConfigFound) {
		const overwrite = await p.confirm({
			message: "opencode-claw.json already exists. Overwrite it?",
			initialValue: false,
		})
		if (!overwrite) {
			await p.outro("Setup cancelled. Existing config unchanged.")
			return
		}
	}

	await p.intro("opencode-claw setup")

	const channels = await collectChannels(p)

	const memory = await collectMemoryConfig(p)

	const portRaw = await p.text({
		message: "OpenCode server port (0 = random):",
		initialValue: "0",
		validate: (v) => {
			const n = Number(v)
			if (!Number.isInteger(n) || n < 0 || n > 65535) return "Must be an integer 0–65535"
			return undefined
		},
	})
	const port = Number(portRaw)

	const enableCron = await p.confirm({
		message: "Enable cron job scheduling?",
		initialValue: false,
	})

	if (enableCron) {
		await p.note(
			"Add jobs to the config file manually after setup.\nSee opencode-claw.example.json for the cron job schema.",
			"Cron jobs",
		)
	}

	const channelSummary =
		Object.keys(channels).length === 0
			? "  No channels configured"
			: Object.keys(channels)
					.map((c) => `  - ${c}`)
					.join("\n")

	const memorySummary =
		memory.backend === "openviking"
			? `  openviking (${memory.openviking.url})`
			: "  txt (./data/memory)"

	await p.note(
		[
			`Channels:\n${channelSummary}`,
			`Memory: ${memorySummary}`,
			`OpenCode port: ${port}`,
			`Cron: ${enableCron ? "enabled" : "disabled"}`,
		].join("\n"),
		"Config summary",
	)

	const config: ConfigShape = {
		opencode: { port },
		memory,
		channels,
		...(enableCron ? { cron: { enabled: true, defaultTimeoutMs: 300000, jobs: [] } } : {}),
	}

	await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8")

	await p.outro("Config written to opencode-claw.json. Run 'npx opencode-claw' to start.")
}
