import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import type { MemoryBackend, MemoryCategory } from "./types.js"

const z = tool.schema

const CATEGORIES = ["project", "experience", "preference", "entity", "event", "knowledge"] as const

function createMemoryPlugin(backend: MemoryBackend): Plugin {
	return async () => ({
		tool: {
			memory_search: tool({
				description:
					"Search long-term memory for relevant context about projects, experiences, preferences, or entities",
				args: {
					query: z.string().describe("What to search for"),
					category: z
						.enum(CATEGORIES)
						.optional()
						.describe(
							"Filter by category: project, experience, preference, entity, event, knowledge",
						),
					limit: z
						.number()
						.int()
						.min(1)
						.max(20)
						.optional()
						.describe("Max results to return (default: 5)"),
				},
				execute: async ({ query, category, limit }) => {
					const results = await backend.search(query, {
						category: category as MemoryCategory | undefined,
						limit: limit ?? 5,
					})
					if (results.length === 0) return "No relevant memories found."
					return results.map((r) => `[${r.category}] ${r.content}`).join("\n\n---\n\n")
				},
			}),
			memory_store: tool({
				description: "Store important information in long-term memory for future sessions",
				args: {
					content: z.string().describe("The information to remember"),
					category: z
						.enum(CATEGORIES)
						.describe("Category: project, experience, preference, entity, event, knowledge"),
				},
				execute: async ({ content, category }) => {
					await backend.store({
						content: content as string,
						category: category as MemoryCategory,
						source: "agent",
					})
					return "Stored in memory."
				},
			}),
		},

		"experimental.chat.system.transform": async (_input, output) => {
			const memories = await backend.search("recent context", {
				limit: 5,
				minRelevance: 0.05,
			})
			if (memories.length > 0) {
				const block = memories.map((m) => `- [${m.category}] ${m.content}`).join("\n")
				output.system.push(`\n\n## Relevant Context from Memory\n${block}`)
			}
			output.system.push(
				"\n\n## Memory — Mandatory Protocol",
				"\nYou have two persistent memory tools: **memory_search** and **memory_store**.",
				"\n\n**MANDATORY — you MUST follow this on every turn:**",
				"\n1. **BEFORE replying**: call `memory_search` with the user's topic. Always. No exceptions.",
				"\n2. **AFTER completing any task**: call `memory_store` for EVERY new fact you learned.",
				"\n\n**What to store (one fact per call):**",
				"\n- Project: absolute path, repo URL, language/stack, key entry points",
				"\n- Workflows: build, run, lint, test commands",
				"\n- Architecture: patterns, design decisions, known pitfalls",
				"\n- Preferences: user choices, style guidelines",
				"\n- Relationships: which projects depend on each other",
				"\n\n**Categories**: project | experience | preference | entity | event | knowledge",
				"\nStore one clear, self-contained statement per call. This is NOT optional.",
			)
		},

		"experimental.session.compacting": async (_input, output) => {
			output.context.push(
				"MANDATORY: Before this session is compacted, call memory_store to preserve every important fact " +
					"from this session. Store: project paths, build/run/test commands, architecture decisions, " +
					"key file locations, lessons learned, user preferences. One fact per call. Do this first.",
			)
		},
	})
}

export { createMemoryPlugin }
export type { MemoryBackend, MemoryCategory }
