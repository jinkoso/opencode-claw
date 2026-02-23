import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTxtMemoryBackend } from "../src/memory/txt.js"
const ok = (msg: string) => console.log(`  ✅ ${msg}`)
const fail = (msg: string) => {
	console.error(`  ❌ ${msg}`)
	process.exit(1)
}
const section = (msg: string) => console.log(`\n── ${msg} ──`)

async function main() {
	const dir = await mkdtemp(join(tmpdir(), "claw-compaction-test-"))
	console.log(`\nTest directory: ${dir}`)

	try {
		const backend = createTxtMemoryBackend(dir)
		await backend.initialize()

		section("1. Seed: store raw session facts")

		const PROJECT_KEY = "test-project-abc123"

		await backend.store({
			content: "opencode-claw uses Bun as its test runner",
			category: "knowledge",
			source: "agent",
			scope: "project",
			projectKey: PROJECT_KEY,
		})
		await backend.store({
			content: "txt backend stores files in markdown with --- separators",
			category: "project",
			source: "agent",
			scope: "project",
			projectKey: PROJECT_KEY,
		})
		await backend.store({
			content: "plugin-entry.ts runs in OpenCode's Bun process",
			category: "knowledge",
			source: "agent",
			scope: "project",
			projectKey: PROJECT_KEY,
		})
		ok("3 project-scoped entries stored")

		await backend.store({
			content: "citronetic is the org that owns opencode-claw",
			category: "entity",
			source: "agent",
			scope: "general",
		})
		await backend.store({
			content: "opencode-claw wraps @opencode-ai/sdk with memory and channels",
			category: "knowledge",
			source: "agent",
			scope: "general",
		})
		ok("2 general entries stored")

		await backend.store({
			content: "Never use 'as any' or @ts-ignore — biome enforces noExplicitAny",
			category: "preference",
			source: "agent",
			scope: "tenet",
		})
		await backend.store({
			content: "Always use factory functions (createXxx) instead of classes",
			category: "preference",
			source: "agent",
			scope: "tenet",
		})
		ok("2 tenet entries stored")

		section("2. Load scope contents (simulates memory_load tool)")

		const rawProject = await backend.load("project", PROJECT_KEY)
		const rawGeneral = await backend.load("general")
		const rawTenet = await backend.load("tenet")

		if (!rawProject.includes("Bun as its test runner")) fail("project load missing entry 1")
		if (!rawProject.includes("--- separators")) fail("project load missing entry 2")
		if (!rawProject.includes("plugin-entry.ts")) fail("project load missing entry 3")
		ok(`project scope loaded (${rawProject.length} chars, 3 entries)`)

		if (!rawGeneral.includes("citronetic")) fail("general load missing entry 1")
		if (!rawGeneral.includes("wraps @opencode-ai/sdk")) fail("general load missing entry 2")
		ok(`general scope loaded (${rawGeneral.length} chars, 2 entries)`)

		if (!rawTenet.includes("noExplicitAny")) fail("tenet load missing entry 1")
		if (!rawTenet.includes("factory functions")) fail("tenet load missing entry 2")
		ok(`tenet scope loaded (${rawTenet.length} chars, 2 entries)`)

		section("3. Compact: project scope (simulates memory_compact tool)")

		const compactedProject = `## [knowledge] ${new Date().toISOString()} | source:agent

opencode-claw project facts:
- Uses Bun as test runner (bun:test framework)
- txt backend stores memory in markdown files separated by --- delimiters
- plugin-entry.ts runs inside OpenCode's Bun process (separate from main Node.js process)`

		await backend.replace("project", PROJECT_KEY, compactedProject)
		ok("project scope compacted")

		const verifyProject = await backend.load("project", PROJECT_KEY)
		if (!verifyProject.includes("Bun as test runner"))
			fail("compacted project missing merged content")
		if (!verifyProject.includes("--- delimiters"))
			fail("compacted project missing reformatted entry")
		if (verifyProject.includes("txt backend stores files in markdown with --- separators"))
			fail("compacted project still has raw (pre-compaction) entry — should be replaced")
		ok("project scope reflects compacted content, old raw entries gone")

		section("4. Compact: general scope")

		const compactedGeneral = `## [entity] ${new Date().toISOString()} | source:agent

citronetic org:
- citronetic owns opencode-claw
- opencode-claw wraps @opencode-ai/sdk, adds persistent memory, Telegram/Slack/WhatsApp channels, and cron jobs`

		await backend.replace("general", undefined, compactedGeneral)
		ok("general scope compacted")

		const verifyGeneral = await backend.load("general")
		if (!verifyGeneral.includes("citronetic owns opencode-claw"))
			fail("compacted general missing org fact")
		if (!verifyGeneral.includes("cron jobs")) fail("compacted general missing cron fact")
		ok("general scope reflects compacted content")

		section("5. Compact: tenet scope")

		const compactedTenet = `## [preference] ${new Date().toISOString()} | source:agent

Dev standards:
- No 'as any' or @ts-ignore — biome noExplicitAny is enforced as error
- Use factory functions (createXxx) returning typed object literals — never classes
- Import paths always use .js extension even for .ts source files`

		await backend.replace("tenet", undefined, compactedTenet)
		ok("tenet scope compacted")

		const verifyTenet = await backend.load("tenet")
		if (!verifyTenet.includes("noExplicitAny is enforced"))
			fail("compacted tenet missing type safety rule")
		if (!verifyTenet.includes("factory functions"))
			fail("compacted tenet missing factory pattern rule")
		if (!verifyTenet.includes(".js extension"))
			fail("compacted tenet missing new rule added during compaction")
		ok("tenet scope reflects compacted content with new rule merged in")

		section("6. Verify search still works after compaction")

		const projectSearch = await backend.search("Bun", {
			scope: "project",
			projectKey: PROJECT_KEY,
			minRelevance: 0,
		})
		if (projectSearch.length === 0) fail("search returned no results after compaction")
		if (!projectSearch[0]?.content.includes("Bun")) fail("search result doesn't contain 'Bun'")
		ok(
			`search('Bun', project) → ${projectSearch.length} result(s): "${projectSearch[0]?.content.slice(0, 60)}..."`,
		)

		const tenetSearch = await backend.search("factory", { scope: "tenet", minRelevance: 0 })
		if (tenetSearch.length === 0) fail("tenet search returned no results after compaction")
		ok(`search('factory', tenet) → ${tenetSearch.length} result(s)`)

		section("7. Verify memory_delete on a newly stored entry")

		await backend.store({
			content: "temporary fact to delete",
			category: "knowledge",
			source: "agent",
			scope: "general",
		})
		const beforeDelete = await backend.load("general")
		if (!beforeDelete.includes("temporary fact to delete"))
			fail("entry not written before delete test")

		const deleteResults = await backend.search("temporary fact to delete", {
			scope: "general",
			minRelevance: 0,
		})
		if (deleteResults.length === 0) fail("search didn't find the entry to delete")
		const entryId = deleteResults[0]!.id
		ok(`Found entry to delete, id: ${entryId}`)

		await backend.delete(entryId)
		const afterDelete = await backend.load("general")
		if (afterDelete.includes("temporary fact to delete")) fail("entry still present after delete")
		ok("Entry deleted successfully, no longer in general.md")

		section("8. Verify status()")

		const status = await backend.status()
		if (!status.initialized) fail("status.initialized should be true")
		if (status.entryCount === 0) fail("status.entryCount should be > 0")
		ok(
			`status: backend=${status.backend}, initialized=${status.initialized}, entryCount=${status.entryCount}`,
		)

		console.log("\n✅ All compaction workflow checks passed!\n")
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

main().catch((err) => {
	console.error("\n❌ Test failed:", err)
	process.exit(1)
})
