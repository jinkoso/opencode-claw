# AGENTS.md — opencode-claw

Headless service wrapping `@opencode-ai/sdk` with persistent memory, messaging channels (Telegram/Slack/WhatsApp), and cron jobs. Single-user. Published as npm package `opencode-claw` with CLI and library entry points.

## Build & Run

```bash
bun install                  # install deps
bun run build                # tsc --build → dist/
bun run typecheck            # tsc --noEmit (src only)
bun run typecheck:test       # tsc --noEmit (src + test)
bun run lint                 # biome check src/ test/
bun run format               # biome format --write src/
bun start                    # run from source (dev) — runs src/cli.ts
```

## Testing

```bash
bun test                                           # all tests
bun test test/memory/                              # all tests in a directory
bun test test/memory/txt-backend.test.ts           # single test file
bun test --test-name-pattern "stores an entry"     # single test by name
```

- **Unit tests** (`test/memory/*.test.ts`): Fast, no network, no OpenCode server needed.
- **E2E tests** (`test/memory-plugin.e2e.test.ts`): Require a running OpenCode server. Start with `bun x opencode server` first. ~30s.
- Test framework: `bun:test` (describe/test/expect). Test config: `tsconfig.test.json` (extends base, adds `"types": ["bun"]`, relaxes `noUnusedLocals`/`noUnusedParameters`).

## TypeScript Configuration

- **Strict mode**: `strict: true`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`
- **Target**: ESNext, ESM (`"type": "module"` in package.json)
- **Module resolution**: `"bundler"` — import paths use `.js` extension even for `.ts` source files
- **No `any`**: Biome enforces `noExplicitAny: "error"`. Never use `as any`, `@ts-ignore`, or `@ts-expect-error`.

### Runtime API Boundaries

- **`src/` — Node.js APIs only.** Use `src/compat.ts` wrappers for file I/O and HTTP servers: `readTextFile`, `fileExists`, `readJsonFile`, `writeTextFile`, `createFileWriter`, `createHttpServer`. Import from `"../compat.js"`.
- **`test/` — Bun APIs OK.** `Bun.file()`, `bun:test`, etc.
- **`src/memory/plugin-entry.ts`** — Exception: runs inside OpenCode's Bun process, Bun APIs acceptable.

## Code Style (Biome-enforced)

- **Indentation**: Tabs
- **Line width**: 100
- **Semicolons**: `asNeeded` — only when required for ASI safety
- **Quotes**: Double quotes
- **Variables**: `const` by default, `let` when needed, never `var` (`noVar: "error"`)
- **Comments**: Minimize — no boilerplate JSDoc. Only truly necessary explanations.

## Imports

- **Sorting**: Automatic via Biome `organizeImports`
- **Type imports**: Separate statement — `import type { Foo } from "./bar.js"` (not inline `import { type Foo }`)
- **Path extensions**: Always `.js` — `import { foo } from "./bar.js"` even when the source file is `.ts`
- **Node built-ins**: Use `node:` prefix — `import { readFile } from "node:fs/promises"`

## Naming Conventions

| Element | Style | Example |
|---------|-------|---------|
| Files | kebab-case | `txt-backend.ts`, `plugin-entry.ts` |
| Types | PascalCase, `type` keyword (never `interface`) | `type MemoryBackend = { ... }` |
| Functions | camelCase, factory prefix `create` | `createLogger()`, `createRouter()` |
| Constants | UPPER_SNAKE_CASE (module-level) | `DEFAULT_BASE_DELAY`, `CATEGORIES` |
| Variables | camelCase | `const threshold = levels[config.level]` |

## Architecture Patterns

### Factory Functions (not classes)

Every module exports a `createXxx()` function returning a typed object literal. Derive the type from the return value:

```typescript
export function createLogger(config: LogConfig) {
	// ...
	return { debug, info, warn, error }
}
export type Logger = ReturnType<typeof createLogger>
```

### Config via Zod

Schemas in `src/config/schema.ts`, types derived in `src/config/types.ts` via `z.infer<>`:

```typescript
export type Config = z.infer<typeof configSchema>
export type MemoryConfig = Config["memory"]
```

### Error Handling

- **Catch blocks**: `err instanceof Error ? err.message : String(err)` — never bare `err`.
- **No empty catches**: Always log or comment why it's intentionally ignored.
- **Reconnectable subsystems**: Use `createReconnector()` from `src/utils/reconnect.ts` (exponential backoff + jitter).

### Graceful Shutdown

Register cleanup via `onShutdown(fn)` from `src/utils/shutdown.ts`. Handlers run in reverse order on SIGTERM/SIGINT:

```typescript
onShutdown(async () => {
	adapter.stop()
})
```

### Public API Exports

All public types and functions re-exported from `src/exports.ts`. Co-locate type definitions with their implementation file, then re-export.

## Module Structure

```
src/
  cli.ts                #!/usr/bin/env node — --init flag → wizard, else → main()
  index.ts              Main entry — wires all subsystems, calls setupShutdown()
  exports.ts            Public library API (re-exports for npm consumers)
  compat.ts             Node.js fs/http wrappers (use these, not Bun APIs)
  config/               Zod schemas (schema.ts) + derived types (types.ts) + loader
  channels/             Adapters: telegram, slack, whatsapp + shared types
  memory/               Backends: txt, openviking + plugin + factory
  sessions/             Session routing, file persistence, prompt streaming
  cron/                 node-cron scheduler
  outbox/               File-based async delivery queue (writer + drainer)
  health/               HTTP health check server
  wizard/               TUI onboarding wizard (@clack/prompts)
  utils/                Logger, shutdown handler, reconnect
test/
  memory/               Unit tests (no server needed)
  memory-plugin.e2e.test.ts   E2E against real OpenCode
  helpers.ts            E2E setup/teardown utilities
```

## npm Package

- **CLI**: `npx opencode-claw` (entry: `dist/cli.js`), `npx opencode-claw --init` for setup wizard
- **Library**: `import { main, createMemoryBackend } from "opencode-claw"`
- **Plugin**: `import { memoryPlugin } from "opencode-claw/plugin"`
- **Exports map**: `.` → `dist/exports.js`, `./plugin` → `dist/memory/plugin-entry.js`
- **`prepublishOnly`** runs `tsc --build` automatically

## Dependencies (don't add without reason)

| Package | Purpose |
|---------|---------|
| `@opencode-ai/sdk` | OpenCode client + server |
| `@opencode-ai/plugin` | Plugin SDK (tool registration) |
| `grammy` + `@grammyjs/runner` | Telegram bot |
| `@slack/bolt` | Slack bot |
| `@whiskeysockets/baileys` | WhatsApp (Baileys) |
| `@clack/prompts` | TUI onboarding wizard |
| `node-cron` | Cron scheduling |
| `zod` | Config validation |

## Key Constraints

- OpenCode SDK is the agent runtime — never fork or modify OpenCode source
- Single-user design — no multi-tenancy, no auth layer
- `src/memory/plugin-entry.ts` runs in OpenCode's Bun process (separate from main)
- Both processes share `opencode-claw.json` config and memory files on disk
- Never commit `opencode-claw.json` — contains real tokens (use `opencode-claw.example.json` as reference)

## Design Docs

- [`docs/tech-design.md`](docs/tech-design.md) — Full technical design: interfaces, types, config schema, project structure
- [`docs/streaming-design.md`](docs/streaming-design.md) — Progress reporting: tool notifications, heartbeat, question forwarding
- [`docs/investigation-report.md`](docs/investigation-report.md) — Research synthesis of OpenCode, OpenClaw, OpenViking, MonClaw
