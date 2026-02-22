export { main } from "./index.js"

export type {
	Config,
	MemoryConfig,
	OutboxConfig,
	LogConfig,
	HealthConfig,
	RouterConfig,
} from "./config/types.js"
export type {
	MemoryBackend,
	MemoryEntry,
	MemoryInput,
	MemorySearchOptions,
	MemoryStatus,
	MemoryCategory,
} from "./memory/types.js"
export { createMemoryBackend } from "./memory/factory.js"
export type {
	ChannelAdapter,
	ChannelId,
	InboundMessage,
	OutboundMessage,
	ChannelStatus,
} from "./channels/types.js"
export type { OutboxEntry, OutboxWriter } from "./outbox/writer.js"
export { createOutboxWriter } from "./outbox/writer.js"
export type { OutboxDrainer } from "./outbox/drainer.js"
export { createOutboxDrainer } from "./outbox/drainer.js"
