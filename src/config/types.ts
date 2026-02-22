import type { z } from "zod"
import type { configSchema } from "./schema.js"

export type Config = z.infer<typeof configSchema>
export type TelegramConfig = NonNullable<Config["channels"]["telegram"]>
export type SlackConfig = NonNullable<Config["channels"]["slack"]>
export type WhatsAppConfig = NonNullable<Config["channels"]["whatsapp"]>
export type MemoryConfig = Config["memory"]
export type CronConfig = NonNullable<Config["cron"]>
export type CronJobConfig = CronConfig["jobs"][number]
export type SessionsConfig = Config["sessions"]
export type OutboxConfig = Config["outbox"]
export type LogConfig = Config["log"]
