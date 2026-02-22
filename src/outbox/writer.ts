import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { ChannelId } from "../channels/types.js"
import type { OutboxConfig } from "../config/types.js"

export type OutboxEntry = {
	id: string
	channel: ChannelId
	peerId: string
	text: string
	threadId?: string
	enqueuedAt: string
	attempts: number
}

export type OutboxWriter = {
	enqueue(entry: Omit<OutboxEntry, "id" | "enqueuedAt" | "attempts">): Promise<void>
}

const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"

function generateId(): string {
	const ts = Date.now().toString(36)
	let suffix = ""
	for (let i = 0; i < 6; i++) {
		suffix += CHARS[Math.floor(Math.random() * CHARS.length)]
	}
	return `${ts}-${suffix}`
}

export function createOutboxWriter(config: OutboxConfig): OutboxWriter {
	return {
		async enqueue(entry) {
			const id = generateId()
			const full: OutboxEntry = {
				...entry,
				id,
				enqueuedAt: new Date().toISOString(),
				attempts: 0,
			}

			const dir = join(config.directory, entry.channel, entry.peerId)
			await mkdir(dir, { recursive: true })

			const path = join(dir, `${id}.json`)
			await Bun.write(path, JSON.stringify(full, null, 2))
		},
	}
}
