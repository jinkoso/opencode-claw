import { readdir } from "node:fs/promises"
import { mkdir, rename } from "node:fs/promises"
import { join } from "node:path"
import type { ChannelAdapter, ChannelId } from "../channels/types.js"
import type { OutboxConfig } from "../config/types.js"
import type { Logger } from "../utils/logger.js"
import type { OutboxEntry } from "./writer.js"

export type OutboxDrainer = {
	start(): void
	stop(): void
}

export function createOutboxDrainer(
	config: OutboxConfig,
	adapters: Map<ChannelId, ChannelAdapter>,
	logger: Logger,
): OutboxDrainer {
	let timer: ReturnType<typeof setInterval> | null = null

	async function readEntries(): Promise<Array<{ entry: OutboxEntry; filepath: string }>> {
		const results: Array<{ entry: OutboxEntry; filepath: string }> = []
		const baseDir = config.directory

		if (!(await dirExists(baseDir))) return results

		const channels = await readdir(baseDir, { withFileTypes: true })
		for (const ch of channels) {
			if (!ch.isDirectory() || ch.name === "dead") continue

			const channelDir = join(baseDir, ch.name)
			const peers = await readdir(channelDir, { withFileTypes: true })
			for (const peer of peers) {
				if (!peer.isDirectory()) continue

				const peerDir = join(channelDir, peer.name)
				const files = await readdir(peerDir)
				for (const file of files) {
					if (!file.endsWith(".json")) continue

					const filepath = join(peerDir, file)
					const raw = await Bun.file(filepath).text()
					const entry = JSON.parse(raw) as OutboxEntry
					results.push({ entry, filepath })
				}
			}
		}

		return results
	}

	async function moveToDead(filepath: string, entry: OutboxEntry): Promise<void> {
		const deadDir = join(config.directory, "dead", entry.channel, entry.peerId)
		await mkdir(deadDir, { recursive: true })

		const filename = filepath.split("/").pop() ?? `${entry.id}.json`
		const dest = join(deadDir, filename)
		await rename(filepath, dest)
		logger.warn("outbox: moved to dead letter", {
			id: entry.id,
			channel: entry.channel,
			peerId: entry.peerId,
			attempts: entry.attempts,
		})
	}

	async function drain(): Promise<void> {
		const pending = await readEntries()
		if (pending.length === 0) return

		for (const { entry, filepath } of pending) {
			const adapter = adapters.get(entry.channel)
			if (!adapter || adapter.status() !== "connected") continue

			try {
				await adapter.send(entry.peerId, {
					text: entry.text,
					threadId: entry.threadId,
				})
				// Delete successfully delivered entry
				const file = Bun.file(filepath)
				if (await file.exists()) {
					await Bun.write(filepath, "")
					// Use unlink via fs
					const { unlink } = await import("node:fs/promises")
					await unlink(filepath)
				}
				logger.debug("outbox: delivered", {
					id: entry.id,
					channel: entry.channel,
				})
			} catch (err) {
				entry.attempts++
				if (entry.attempts >= config.maxAttempts) {
					await moveToDead(filepath, entry)
				} else {
					await Bun.write(filepath, JSON.stringify(entry, null, 2))
					logger.warn("outbox: delivery failed, will retry", {
						id: entry.id,
						attempts: entry.attempts,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
		}
	}

	async function dirExists(path: string): Promise<boolean> {
		try {
			await readdir(path)
			return true
		} catch {
			return false
		}
	}

	return {
		start() {
			timer = setInterval(() => {
				drain().catch((err) => {
					logger.error("outbox: drain error", {
						error: err instanceof Error ? err.message : String(err),
					})
				})
			}, config.pollIntervalMs)
			logger.info("outbox: drainer started", {
				pollIntervalMs: config.pollIntervalMs,
			})
		},

		stop() {
			if (timer) {
				clearInterval(timer)
				timer = null
			}
			logger.info("outbox: drainer stopped")
		},
	}
}
