import type { MemoryConfig } from "../config/types.js"
import { createOpenVikingBackend } from "./openviking.js"
import { createTxtMemoryBackend } from "./txt.js"
import type { MemoryBackend } from "./types.js"

export function createMemoryBackend(config: MemoryConfig): MemoryBackend {
	if (config.backend === "txt") {
		return createTxtMemoryBackend(config.txt.directory)
	}
	if (config.backend === "openviking") {
		if (!config.openviking) {
			throw new Error("memory.openviking config required when backend is 'openviking'")
		}
		return createOpenVikingBackend(config.openviking, config.txt.directory)
	}
	throw new Error(`Unknown memory backend: ${config.backend}`)
}
