import { z } from "zod"

const telegramSchema = z.object({
	enabled: z.boolean(),
	botToken: z.string().min(1),
	allowlist: z.array(z.string()),
	mode: z.enum(["polling", "webhook"]).default("polling"),
	webhookUrl: z.string().url().optional(),
	rejectionBehavior: z.enum(["ignore", "reject"]).default("ignore"),
})

const slackSchema = z.object({
	enabled: z.boolean(),
	botToken: z.string().min(1),
	appToken: z.string().min(1),
	allowlist: z.array(z.string()).optional(),
	mode: z.enum(["socket", "http"]).default("socket"),
	signingSecret: z.string().optional(),
	rejectionBehavior: z.enum(["ignore", "reject"]).default("ignore"),
	requireMentionInChannels: z.boolean().default(true),
	requireMentionInDms: z.boolean().default(false),
})

const whatsappSchema = z.object({
	enabled: z.boolean(),
	allowlist: z.array(z.string()),
	authDir: z.string().default("./data/whatsapp/auth"),
	debounceMs: z.number().int().min(0).default(1000),
	rejectionBehavior: z.enum(["ignore", "reject"]).default("ignore"),
})

const memorySchema = z.object({
	backend: z.enum(["txt", "openviking"]).default("txt"),
	txt: z
		.object({
			directory: z.string().default("./data/memory"),
		})
		.default({}),
	openviking: z
		.object({
			mode: z.enum(["http", "subprocess"]).default("http"),
			url: z.string().url().default("http://localhost:8100"),
			path: z.string().optional(),
			embedding: z.enum(["openai", "volcengine"]).optional(),
			fallback: z.boolean().default(true),
		})
		.optional(),
})

const cronJobSchema = z.object({
	id: z.string().min(1),
	schedule: z.string().min(1),
	description: z.string(),
	prompt: z.string().min(1),
	reportTo: z
		.object({
			channel: z.enum(["slack", "telegram", "whatsapp"]),
			peerId: z.string().min(1),
			threadId: z.string().optional(),
		})
		.optional(),
	enabled: z.boolean().default(true),
	timeoutMs: z.number().int().min(1000).default(300_000),
})

const cronSchema = z.object({
	enabled: z.boolean().default(true),
	defaultTimeoutMs: z.number().int().min(1000).default(300_000),
	jobs: z.array(cronJobSchema).default([]),
})

export const configSchema = z.object({
	opencode: z
		.object({
			configPath: z.string().optional(),
			port: z.number().int().min(0).default(0),
			directory: z.string().optional(),
		})
		.default({}),
	memory: memorySchema.default({ backend: "txt" }),
	channels: z.object({
		telegram: telegramSchema.optional(),
		slack: slackSchema.optional(),
		whatsapp: whatsappSchema.optional(),
	}),
	cron: cronSchema.optional(),
	sessions: z
		.object({
			titleTemplate: z.string().default("{{channel}}:{{peerId}}"),
			persistPath: z.string().default("./data/sessions.json"),
		})
		.default({}),
	outbox: z
		.object({
			directory: z.string().default("./data/outbox"),
			pollIntervalMs: z.number().int().min(100).default(500),
			maxAttempts: z.number().int().min(1).default(3),
		})
		.default({}),
	log: z
		.object({
			level: z.enum(["debug", "info", "warn", "error"]).default("info"),
			file: z.string().optional(),
		})
		.default({}),
	health: z
		.object({
			enabled: z.boolean().default(false),
			port: z.number().int().min(1).default(9090),
		})
		.optional(),
	router: z
		.object({
			timeoutMs: z.number().int().min(1000).default(300_000),
			progress: z
				.object({
					enabled: z.boolean().default(true),
					toolThrottleMs: z.number().int().min(1000).default(5_000),
					heartbeatMs: z.number().int().min(10_000).default(60_000),
				})
				.default({}),
		})
		.default({}),
})
