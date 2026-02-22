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
				`\n\n## Memory Instructions\nYou have access to persistent long-term memory across sessions via two tools:\n- **memory_search**: Look up stored facts about projects, workflows, and past experiences.\n- **memory_store**: Save important information so it persists across sessions.\n\n**When to search memory:**\n- At the start of any task involving a project — search for its location, build commands, test steps, and relationships to other projects.\n- When you are unsure about a project's structure or conventions.\n\n**When to store memory (do this proactively):**\n- Project facts: absolute path on disk, repo URL, language/stack, key entry points.\n- Dev workflows: how to build, run, lint, and format the project.\n- Test procedures: how to run tests locally, what test framework is used, any setup required.\n- Dependencies and relationships: which projects depend on each other, shared libraries, APIs consumed.\n- Architecture decisions: patterns used, notable design choices, known pitfalls.\n- Use category \`project\` for project-specific facts, \`knowledge\` for workflows and procedures, \`experience\` for lessons learned.\n\nStore facts at the granularity of one clear, self-contained statement per call.`,
			)
		},
	})
}

export { createMemoryPlugin }
export type { MemoryBackend, MemoryCategory }
