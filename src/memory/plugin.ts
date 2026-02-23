import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import type { MemoryBackend, MemoryCategory, MemoryScope } from "./types.js"

const z = tool.schema

const CATEGORIES = ["project", "experience", "preference", "entity", "event", "knowledge"] as const
const SCOPES = ["project", "general"] as const

// Max characters injected for general memory to prevent prompt bloat
const MAX_GENERAL_MEMORY_CHARS = 4000

function createMemoryPlugin(backend: MemoryBackend, projectKey?: string): Plugin {
	const sessionProjects = new Set<string>()
	return async (input) => {
		const resolvedProjectKey = projectKey ?? input.project?.id
		if (resolvedProjectKey) sessionProjects.add(resolvedProjectKey)

		return {
			tool: {
				tenet_store: tool({
					description:
						"Store a coding principle, architectural rule, or persistent preference in the tenet layer. " +
						"Tenets are global, always injected into every session, and shape AI behavior long-term. " +
						"Use for: preferred tech stacks, architectural principles, code style rules, workflow habits.",
					args: {
						content: z.string().describe("The principle or rule to remember permanently"),
						category: z
							.enum(CATEGORIES)
							.describe("Category: project, experience, preference, entity, event, knowledge"),
					},
					execute: async ({ content, category }) => {
						await backend.store({
							content: content as string,
							category: category as MemoryCategory,
							source: "agent",
							scope: "tenet",
						})
						return "Tenet stored."
					},
				}),

				tenet_list: tool({
					description:
						"List all stored tenets (global coding principles and preferences). " +
						"Useful to review what persistent rules are already known before adding new ones.",
					args: {},
					execute: async () => {
						const results = await backend.search("", {
							scope: "tenet",
							limit: 50,
							minRelevance: 0,
						})
						if (results.length === 0) return "No tenets stored yet."
						return results.map((r) => `[${r.category}] ${r.content}`).join("\n\n---\n\n")
					},
				}),

				memory_search: tool({
					description:
						"Search long-term memory for relevant context about projects, experiences, preferences, or entities",
					args: {
						query: z.string().describe("What to search for"),
						scope: z
							.enum(SCOPES)
							.optional()
							.describe(
								"Scope to search: 'project' (current repo only), 'general' (global knowledge). Omit to search both.",
							),
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
					execute: async ({ query, scope, category, limit }) => {
						const results = await backend.search(query, {
							scope: scope as MemoryScope | undefined,
							projectKey: resolvedProjectKey,
							category: category as MemoryCategory | undefined,
							limit: limit ?? 5,
						})
						if (results.length === 0) return "No relevant memories found."
						return results.map((r) => `id:${r.id} [${r.category}] ${r.content}`).join("\n\n---\n\n")
					},
				}),

				memory_store: tool({
					description: "Store important information in long-term memory for future sessions",
					args: {
						content: z.string().describe("The information to remember"),
						category: z
							.enum(CATEGORIES)
							.describe("Category: project, experience, preference, entity, event, knowledge"),
						scope: z
							.enum(SCOPES)
							.optional()
							.describe(
								"Scope: 'project' (current repo, default when in a git project), 'general' (global knowledge). Omit to auto-select.",
							),
					},
					execute: async ({ content, category, scope }) => {
						const resolvedScope: MemoryScope = scope
							? (scope as MemoryScope)
							: resolvedProjectKey
								? "project"
								: "general"
						await backend.store({
							content: content as string,
							category: category as MemoryCategory,
							source: "agent",
							scope: resolvedScope,
							projectKey: resolvedScope === "project" ? resolvedProjectKey : undefined,
						})
						return "Stored in memory."
					},
				}),

				memory_delete: tool({
					description:
						"Delete a specific memory entry by its id. " +
						"Use memory_search first to find the id of the entry to remove. " +
						"Useful for pruning stale or incorrect memories before compaction.",
					args: {
						id: z
							.string()
							.describe("The id of the memory entry to delete (from memory_search results)"),
					},
					execute: async ({ id }) => {
						await backend.delete(id as string)
						return "Memory entry deleted."
					},
				}),

				memory_load: tool({
					description:
						"Load the full raw content of a memory scope file. " +
						"Use this before compaction to read all existing memories in a scope. " +
						"Returns empty string if no memories have been stored for that scope yet.",
					args: {
						scope: z
							.enum(["tenet", "project", "general"] as const)
							.describe("Scope to load: 'tenet', 'project', or 'general'"),
						projectKey: z
							.string()
							.optional()
							.describe(
								"Project key override (defaults to current project). Only used when scope='project'.",
							),
					},
					execute: async ({ scope, projectKey: pk }) => {
						const key = pk ?? (scope === "project" ? resolvedProjectKey : undefined)
						const raw = await backend.load(scope as MemoryScope, key)
						return raw || "(empty — no memories stored in this scope)"
					},
				}),

				memory_compact: tool({
					description:
						"Overwrite a memory scope file with synthesized compact content. " +
						"Use at session end: load scope → merge with session findings → synthesize → compact. " +
						"Three-pass order: project (per project touched) → general → tenet. " +
						"Content contracts: project = repo-specific facts; general = cross-project/org knowledge; tenet = dev habits/standards only.",
					args: {
						scope: z.enum(["tenet", "project", "general"] as const).describe("Scope to overwrite"),
						content: z.string().describe("Full synthesized content to replace the scope file with"),
						projectKey: z
							.string()
							.optional()
							.describe(
								"Project key override (defaults to current project). Only used when scope='project'.",
							),
					},
					execute: async ({ scope, content, projectKey: pk }) => {
						const key = pk ?? (scope === "project" ? resolvedProjectKey : undefined)
						await backend.replace(scope as MemoryScope, key, content as string)
						return `Compacted ${scope} memory.`
					},
				}),

				memory_session_projects: tool({
					description:
						"List all project keys that have been active in this session. " +
						"Use at session end to know which project scopes need compaction.",
					args: {},
					execute: async () => {
						if (sessionProjects.size === 0) return "No projects recorded in this session."
						return [...sessionProjects].join("\n")
					},
				}),
			},

			"experimental.chat.system.transform": async (_hookInput, output) => {
				// 1. Inject tenets as text — always, full list
				const tenets = await backend.search("", {
					scope: "tenet",
					limit: 50,
					minRelevance: 0,
				})
				if (tenets.length > 0) {
					const block = tenets.map((m) => `- [${m.category}] ${m.content}`).join("\n")
					output.system.push(`\n\n## Coding Principles & Preferences (Tenets)\n${block}`)
				}

				// 2. Inject general memories as text — capped to avoid prompt bloat
				const generalMemories = await backend.search("", {
					scope: "general",
					limit: 50,
					minRelevance: 0,
				})
				if (generalMemories.length > 0) {
					const lines = generalMemories.map((m) => `- [${m.category}] ${m.content}`)
					let block = ""
					let included = 0
					for (const line of lines) {
						if (block.length + line.length + 1 > MAX_GENERAL_MEMORY_CHARS) break
						block += (block ? "\n" : "") + line
						included++
					}
					const omitted = generalMemories.length - included
					const suffix =
						omitted > 0
							? `\n\n_(${omitted} older ${omitted === 1 ? "entry" : "entries"} omitted — call \`memory_search\` to retrieve them)_`
							: ""
					output.system.push(`\n\n## General Memory\n${block}${suffix}`)
				}

				// 3. Instruct the agent to actively load project-specific memory via tool call
				const projectHint = resolvedProjectKey
					? " Use scope='project' to load memories for this specific repo."
					: ""
				output.system.push(
					"\n\n## Memory",
					"\nYou have persistent memory tools: **memory_search**, **memory_store**, **memory_delete**, **memory_load**, **memory_compact**, **memory_session_projects**, **tenet_store**, **tenet_list**.",
					`\n\nAt the start of each session or when working on a project, call \`memory_search\` to load relevant context.${projectHint}`,
					"\nAfter completing tasks, call `memory_store` for every new fact learned (one fact per call).",
					"\nFor permanent rules or preferences, use `tenet_store` — tenets are always injected into every session.",
				)
			},
		}
	}
}

export { createMemoryPlugin }
export type { MemoryBackend, MemoryCategory }
