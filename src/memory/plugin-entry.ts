import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from "../config/loader.js"
import { createMemoryBackend } from "./factory.js"
import { createMemoryPlugin } from "./plugin.js"

// This file runs inside OpenCode's child process (loaded via `import()`).
// It reads the same opencode-claw config and creates its own MemoryBackend
// instance pointing to the same MEMORY.md file on disk.

const config = await loadConfig()
const backend = createMemoryBackend(config.memory)
await backend.initialize()

const memoryPlugin: Plugin = createMemoryPlugin(backend)

export { memoryPlugin }
