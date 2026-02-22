# AGENTS.md — opencode-claw

## What This Is

A headless service wrapping `@opencode-ai/sdk` with persistent memory, messaging channels (Telegram/Slack/WhatsApp), and cron jobs. Single-user by design. Published as an npm package (`opencode-claw`) with both CLI and library entry points.

## Build & Run

```bash
bun install                  # install deps
bun run build                # tsc --build → dist/
bun run typecheck            # tsc --noEmit (src only)
bun run typecheck:test       # tsc --noEmit (src + test)
bun run lint                 # biome check src/ test/
bun run format               # biome format --write src/
bun start                    # run from source (dev)
```

## Testing

```bash
bun test                     # all tests (unit + E2E)
bun test test/memory/        # all tests in a directory
bun test test/memory/txt-backend.test.ts          # single test file
bun test --test-name-pattern "stores an entry"    # single test by name
```

- **Unit tests** (`test/memory/*.test.ts`): Fast, no network, no OpenCode server
- **E2E tests** (`test/memory-plugin.e2e.test.ts`): Require a running OpenCode server with an LLM. Start with `bun x opencode server` before running. These take ~30s.
- Tests use `bun:test` (describe/test/expect). Test files can use Bun APIs.
- Test config: `tsconfig.test.json` extends base tsconfig, adds `"types": ["bun"]`

## TypeScript

- **Strict mode**: `strict: true`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`
- **Target**: ESNext, ESM (`"type": "module"` in package.json)
- **Module resolution**: `"bundler"` — import paths use `.js` extension even for `.ts` files
- **No `any`**: Biome enforces `noExplicitAny: "error"`. Never use `as any`, `@ts-ignore`, or `@ts-expect-error`.
- **No Bun APIs in `src/`**: Production code must use Node.js APIs only. The `src/compat.ts` module provides wrappers (`readTextFile`, `fileExists`, `readJsonFile`, `writeTextFile`, `createFileWriter`, `createHttpServer`). Import from `"../compat.js"`.
- **Bun APIs OK in `test/`**: Test files can use `Bun.file()`, `bun:test`, etc.
- **`src/memory/plugin-entry.ts`** is a special case — it runs inside OpenCode's Bun process, so Bun APIs are acceptable there.

## Code Style (Biome-enforced)

- **Indentation**: Tabs
- **Line width**: 100
- **Semicolons**: Only when required (ASI-safe)
- **Quotes**: Double quotes
- **Variables**: `const` by default, `let` when needed, never `var`
- **Imports**: Sorted by Biome. `type` imports use `import type { ... }` (separate statement).
- **Import paths**: Always end in `.js` — e.g., `import { foo } from "./bar.js"`

## Naming Conventions

- **Files**: kebab-case (`txt-backend.test.ts`, `plugin-entry.ts`)
- **Types**: PascalCase, defined with `type` keyword (not `interface`): `type MemoryBackend = { ... }`
- **Functions**: camelCase. Factory functions use `create` prefix: `createLogger()`, `createMemoryBackend()`, `createRouter()`
- **Constants**: UPPER_SNAKE_CASE for module-level constants: `DEFAULT_BASE_DELAY`, `CATEGORIES`
- **Variables**: camelCase, prefer single-word names when unambiguous
- **Type exports**: Co-locate with the type definition file. Re-export from `src/exports.ts` for public API.

## Architecture Patterns

- **Factory functions over classes**: Every module exports a `createXxx()` function returning a typed object literal (not a class instance). Infer the return type when useful: `type Logger = ReturnType<typeof createLogger>`
- **Config via Zod**: All config shapes defined in `src/config/schema.ts` with Zod schemas. Types derived in `src/config/types.ts` via `z.infer<>`.
- **Compat layer**: `src/compat.ts` wraps Node.js fs/http APIs. When you need file I/O or HTTP servers, use these wrappers — don't import Bun APIs directly.
- **Plugin system**: `src/memory/plugin.ts` creates an OpenCode plugin (tools + system prompt hook). `src/memory/plugin-entry.ts` is the entry point loaded by OpenCode's process.
- **Graceful shutdown**: Register cleanup via `onShutdown()` from `src/utils/shutdown.ts`. Main orchestration is in `src/index.ts`.
- **Error handling**: Use `err instanceof Error ? err.message : String(err)` pattern. No empty catch blocks. Reconnectable subsystems use `src/utils/reconnect.ts` (exponential backoff + jitter).

## Module Structure

```
src/
  index.ts              Main entry — wires all subsystems
  cli.ts                #!/usr/bin/env node CLI entry
  exports.ts            Public library API (re-exports)
  compat.ts             Node.js compatibility wrappers
  config/               Zod schema + loader (env var expansion)
  channels/             Adapters: telegram, slack, whatsapp + types
  memory/               Pluggable backends: txt, openviking + plugin
  sessions/             Session routing + file persistence
  cron/                 node-cron scheduler
  outbox/               File-based async delivery queue
  health/               HTTP health check server
  utils/                Logger, shutdown handler, reconnect
test/
  memory/               Unit tests (no server needed)
  memory-plugin.e2e.test.ts   E2E against real OpenCode
  helpers.ts            E2E setup/teardown utilities
```

## npm Package

- **CLI**: `npx opencode-claw` (entry: `dist/cli.js`)
- **Library**: `import { main, createMemoryBackend } from "opencode-claw"`
- **Plugin**: `import { memoryPlugin } from "opencode-claw/plugin"`
- **Exports map**: `.` → `dist/exports.js`, `./plugin` → `dist/memory/plugin-entry.js`
- **`prepublishOnly`** runs `tsc --build` automatically

## Key Constraints

- Minimize comments — only truly necessary ones (no "this function does X" JSDoc)
- Single-user design — no multi-tenancy, no auth layer
- OpenCode SDK is the agent runtime — never fork or modify OpenCode source
- `src/memory/plugin-entry.ts` runs in OpenCode's Bun process (separate from main process)
- Both processes read the same `opencode-claw.json` config and share memory files on disk

## Dependencies (don't add without reason)

| Package | Purpose |
|---------|---------|
| `@opencode-ai/sdk` | OpenCode client + server |
| `@opencode-ai/plugin` | Plugin SDK (tool registration) |
| `grammy` + `@grammyjs/runner` | Telegram bot |
| `@slack/bolt` | Slack bot |
| `@whiskeysockets/baileys` | WhatsApp (Baileys) |
| `node-cron` | Cron scheduling |
| `zod` | Config validation |

No other runtime dependencies. Keep it lean.

## Development Setup (from source)

```bash
git clone <repo-url> opencode-claw
cd opencode-claw
bun install

# Copy example config
cp opencode-claw.example.json opencode-claw.json
# Edit opencode-claw.json with your tokens

# Run from source
bun start
```

## Design Docs

- [`docs/investigation-report.md`](docs/investigation-report.md) — Research synthesis of OpenCode, OpenClaw, OpenViking, and MonClaw.
- [`docs/tech-design.md`](docs/tech-design.md) — Full technical design: interfaces, types, config schema, project structure, implementation phases.
