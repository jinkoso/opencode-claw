import type { MemoryConfig } from "../config/types.js"
import { createTxtMemoryBackend } from "./txt.js"
import type { MemoryBackend } from "./types.js"

export function createMemoryBackend(config: MemoryConfig): MemoryBackend {
	if (config.backend === "txt") {
		return createTxtMemoryBackend(config.txt.directory)
	}
	// Phase 6: OpenViking backend
	throw new Error(`Unknown memory backend: ${config.backend}`)
}
