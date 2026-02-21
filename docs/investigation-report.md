# Investigation Report: OpenCode, OpenClaw, OpenViking, and MonClaw Reference Architecture

**Date**: February 2026
**Purpose**: Knowledge base for the opencode-claw tech design

---

## Executive Summary

This report consolidates research into four related systems: OpenCode (an AI coding assistant with a TypeScript SDK and plugin architecture), OpenClaw (a personal AI assistant with a multi-channel gateway), OpenViking (a Python memory library for AI agents), and MonClaw (a reference blog post describing a minimal personal assistant built on OpenCode). The goal is to understand each system well enough to design opencode-claw, which replaces OpenClaw's Pi-based agent runtime with OpenCode's SDK while preserving OpenClaw's battle-tested channel, routing, memory, and cron patterns.

The investigation focused on three questions. First, how does OpenCode's agent runtime actually work, and how is it intended to be embedded in other applications? Second, what patterns from OpenClaw are worth preserving versus what was specific to the Pi runtime? Third, what does OpenViking offer as a memory backend, and how does it compare to OpenClaw's built-in approach?

The findings support a clear architecture: use `createOpencode()` from `@opencode-ai/sdk` as the agent runtime, adapt OpenClaw's `ChannelPlugin` interface for channel integrations, adopt the session key scheme for multi-channel isolation, and use the outbox pattern from MonClaw for safe message delivery to external surfaces.

---

## OpenCode Architecture

### Overview

OpenCode is a TypeScript/Bun monorepo. The repository is organized as a set of packages under `packages/`, with the main packages being `opencode` (the server binary and core logic), `sdk/js` (the JavaScript SDK), `slack` (a reference Slack bot), and `plugin` (the plugin type definitions). The architecture follows a client/server split: a local HTTP server runs the AI agent logic, and clients communicate with it over HTTP and SSE.

The server is a Hono application. Hono is a fast web framework for Bun/Deno/Node that uses a router-first design. The server exposes a REST API for session management and a streaming endpoint for real-time events.

### SDK: `@opencode-ai/sdk`

The SDK's main entry point is `packages/sdk/js/src/index.ts`. The primary export is `createOpencode()`, which spawns the OpenCode server as a subprocess and returns both the subprocess handle and an HTTP client pointed at it.

```typescript
const { client, server } = await createOpencode({ port: 0 })
```

Passing `port: 0` lets the OS assign a free port. The server process is managed by the SDK and can be terminated by calling `server.kill()`. The subprocess wraps `packages/sdk/js/src/server.ts`, which handles the actual Bun subprocess spawn, port negotiation, and readiness signaling.

The HTTP client is defined in `packages/sdk/js/src/client.ts`. It is a typed wrapper around the REST API, generated from the server's OpenAPI schema. The client is organized into namespaces mirroring the API routes: `client.session`, `client.event`, `client.app`, and so on.

The synchronous prompt pattern sends a message and waits for the agent to finish:

```typescript
const session = await client.session.create({ body: { title: "my session" } })
await client.session.prompt({
  path: { id: session.data.id },
  body: { parts: [{ type: "text", text: "what files are in src/?" }] }
})
```

The asynchronous pattern fires the prompt without waiting, then subscribes to the event stream to receive incremental updates:

```typescript
await client.session.promptAsync({
  path: { id: session.data.id },
  body: { parts: [{ type: "text", text: "refactor this function" }] }
})
const stream = client.event.subscribe({ path: { id: session.data.id } })
for await (const event of stream) {
  // handle typed events
}
```

The async pattern is the right choice for external channels where message delivery happens asynchronously and the caller does not block.

### Session System

Sessions are the top-level unit of conversation. The REST API exposes full CRUD plus several operational endpoints:

- `POST /session` — create
- `GET /session` — list all sessions
- `GET /session/:id` — get one session
- `PATCH /session/:id` — update metadata (title, etc.)
- `DELETE /session/:id` — delete
- `POST /session/:id/fork` — fork a session at a given message
- `POST /session/:id/share` — generate a shareable link
- `POST /session/:id/abort` — cancel an in-progress agent turn

Session storage is handled in `packages/opencode/src/session/`. Each session holds a list of messages, associated metadata, and references to the agent and working directory. Sessions are persisted in SQLite via Drizzle ORM at `~/.local/share/opencode/`.

The `x-opencode-directory` request header scopes any session operation to a specific project directory. This is the multi-tenancy mechanism: a single running server can serve sessions for multiple projects by setting this header on each request.

### Agent System

The agent system lives in `packages/opencode/src/agent/agent.ts`. OpenCode ships seven built-in agents:

- `build`: the main coding agent, full filesystem and tool access
- `plan`: read-only, used for planning passes before making changes
- `general`: general-purpose subagent, used for delegation
- `explore`: specialized for code exploration and reading
- `compaction`: trims session context when it grows too large
- `title`: generates a title for a new session based on the first message
- `summary`: summarizes session content for compaction or sharing

Each agent has a fixed system prompt and a defined set of allowed tools. The `build` agent has the broadest permissions. Custom agents can be registered through the plugin system.

### Event Bus

The event bus is in `packages/opencode/src/bus/`. It defines over 30 typed event kinds. Examples include:

- `session.created`, `session.updated`, `session.deleted`
- `message.created`, `message.updated`, `message.part.updated`
- `tool.execute`, `tool.complete`
- `agent.turn.start`, `agent.turn.complete`, `agent.turn.error`
- `file.edited`, `file.created`

Events are delivered to clients via SSE. The route `GET /event` streams events for a specific session. The route `GET /global/event` streams all events across all sessions. Clients that need to react to agent output, for example to relay messages to an external chat platform, should subscribe to one of these streams after firing `promptAsync`.

### Plugin System

Plugins are defined using the `Plugin` type from `@opencode-ai/plugin` (`packages/opencode/src/plugin/index.ts`). A plugin is an async function that receives a `{ client }` object (the HTTP client for the running server) and returns a configuration object declaring tools, hooks, and transforms.

```typescript
import { type Plugin } from "@opencode-ai/plugin"

const plugin: Plugin = async ({ client }) => ({
  tool: {
    save_memory: {
      description: "Write a fact to MEMORY.md",
      args: { fact: z.string() },
      execute: async (args) => {
        // append args.fact to MEMORY.md
      }
    }
  },
  "experimental.chat.system.transform": async (input, output) => {
    output.system.push("Injected memory context here")
  }
})
```

There are 14 hook points:

- `tool.execute.before` / `tool.execute.after` — intercept any tool call
- `chat.params` — modify the parameters sent to the LLM
- `permission.ask` — handle permission prompts programmatically
- `experimental.chat.system.transform` — inject content into the system prompt
- Custom tool declarations (as shown above)
- Several additional lifecycle hooks for session and message events

Config injection works two ways. Setting the environment variable `OPENCODE_CONFIG_CONTENT` to a JSON string passes config without writing a file. Alternatively, an `opencode.json` file in the project directory is loaded automatically. Both approaches can specify the list of plugins to load.

### Tool System

Built-in tools are in `packages/opencode/src/tool/`. They cover filesystem operations (read, write, edit, glob, grep), shell execution, LSP integration, and browser control.

Custom tools can be added three ways: by placing a file in `.opencode/tool/` in the project directory, by declaring them in a plugin's `tool` map, or by pointing an MCP server at OpenCode. All three methods surface tools identically to the agent.

### Slack Bot Reference Implementation

`packages/slack/src/index.ts` is a complete, production-grade reference. It maps each Slack thread to an OpenCode session. When a message arrives in a thread, the bot creates or retrieves the session keyed by thread timestamp, calls `client.session.prompt()`, and posts the agent's reply back to the thread. This is the most concrete example of how to wire an external chat platform to an OpenCode session.

### Key Source Files

| File | Purpose |
|---|---|
| `packages/sdk/js/src/index.ts` | `createOpencode()` export |
| `packages/sdk/js/src/server.ts` | Subprocess spawn and port management |
| `packages/sdk/js/src/client.ts` | Typed HTTP client |
| `packages/opencode/src/session/` | Session CRUD and storage |
| `packages/opencode/src/agent/agent.ts` | Built-in agent definitions |
| `packages/opencode/src/tool/` | Built-in tool implementations |
| `packages/opencode/src/bus/` | Event bus types and delivery |
| `packages/opencode/src/server/server.ts` | Hono HTTP server setup |
| `packages/opencode/src/plugin/index.ts` | Plugin hook definitions |
| `packages/slack/src/index.ts` | Slack bot reference implementation |

---

## OpenClaw Architecture

### Overview

OpenClaw is a personal AI assistant runtime for a Raspberry Pi. Its central abstraction is a Gateway: a WebSocket control plane running on `ws://127.0.0.1:18789` that connects messaging channels to the Pi's agent runtime via RPC. External clients (a macOS menu bar app, a browser UI, mobile apps) connect to the Gateway to observe and control the agent.

The architecture separates concerns cleanly: channels handle platform-specific protocol details, routing resolves which session and agent to target, and the agent runtime handles actual LLM interaction. OpenClaw's agent runtime is its Pi integration, which is what opencode-claw replaces with OpenCode's SDK.

### Entry Points

`src/entry.ts` is the binary entry point. It handles Node respawning (relaunching the process with specific flags for memory limits or native module compatibility) and then delegates to `src/index.ts`.

`src/index.ts` is the package entry point. It calls `startGatewayServer()` with the loaded config and wires up any top-level signal handling.

### Gateway Server

The main initialization function is `startGatewayServer(port = 18789)` in `src/gateway/server.impl.ts`. It runs a 22-step startup sequence that covers every subsystem:

1. Config validation and legacy config migration from older schemas
2. Plugin auto-enable: any plugins whose prerequisites are met get enabled automatically, followed by a config write
3. `loadConfig()` to get the live, post-migration config object
4. Subagent registry initialization
5. Agent and workspace directory resolution (handles relative paths, `~` expansion, and creation if missing)
6. Gateway plugin loading and channel plugin loading, then merging their declared gateway methods into the dispatch table
7. Runtime config resolution: bind address, auth tokens, TLS certificates, Tailscale settings, canvas configuration
8. Control UI asset resolution (finds the built front-end assets to serve)
9. `createGatewayRuntimeState()`: creates the HTTP server, WebSocket server, broadcast function, and chat state container
10. NodeRegistry and NodeSubscriptionManager initialization (tracks connected WS clients and their subscriptions)
11. Gateway discovery via Bonjour/mDNS so local clients can find the Gateway without hardcoded addresses
12. Skills remote registry initialization (fetches available skills from a remote index)
13. Maintenance timers: periodic cleanup of stale sessions, expired tokens, etc.
14. Agent event handler: bridges agent output events to the WS broadcast system
15. Heartbeat subscription: listens for heartbeat responses from connected clients
16. Cron service startup via `buildGatewayCronService({cfg, deps, broadcast})`
17. `ExecApprovalManager` initialization: handles the approval flow for shell commands
18. `attachGatewayWsHandlers()`: registers all WS RPC handler functions
19. Tailscale exposure: optionally exposes the Gateway over Tailscale for remote access
20. Sidecar startup in order: browser automation, Gmail watcher, hooks runner, channel adapters, plugin sidecars, memory backend, restart sentinel
21. Plugin `gateway_start` lifecycle hook (plugins can run code after everything is ready)
22. Config hot-reload watcher: watches `openclaw.json` for changes and partially restarts affected subsystems

This startup order matters because later steps depend on earlier ones. The cron service (step 16) needs the agent runtime (step 4-5) and the channel sidecars (step 20). The WS handlers (step 18) need the runtime state (step 9) and the node registry (step 10).

---

## OpenClaw Memory System

### Core Interface

The memory subsystem is defined around the `MemorySearchManager` interface in `src/memory/types.ts`. Any memory backend must implement these seven methods:

- `search(query, opts)` — semantic or keyword search across stored memories
- `readFile(path)` — read a specific memory file by path
- `status()` — return backend health and index statistics
- `sync()` — force a re-index of the memory store
- `probeEmbeddingAvailability()` — check whether the configured embedding provider is reachable
- `probeVectorAvailability()` — check whether vector search (as distinct from keyword search) is functional
- `close()` — graceful shutdown

This interface means backends are swappable. The rest of the system calls `MemorySearchManager` methods without knowing which concrete implementation is running.

### Built-in Backends

`MemoryIndexManager` is the default backend. It uses SQLite with the `sqlite-vec` extension for vector search and FTS5 for full-text keyword search. Searches are hybrid: they compute a cosine similarity score from embeddings and a BM25 score from FTS5, then combine them with configurable weights. This means even without a working embedding provider, keyword search still functions.

`QmdMemoryManager` is an external CLI backend. It shells out to a `qmd` binary and falls back to keyword-only search if the binary is not installed. This backend exists for users who prefer a standalone memory tool with its own lifecycle.

The active backend is set in `~/.openclaw/openclaw.json` as `memory.backend: "builtin" | "qmd"`.

### LanceDB Plugin

The community extension in `extensions/memory-lancedb/` provides a third backend using LanceDB as the vector store. It exposes three agent tools: `memory_recall`, `memory_store`, and `memory_forget`. It also implements a lifecycle hook that auto-injects relevant memories into the agent's context before each turn, so the agent receives memories without having to explicitly call a tool.

### Storage Format

Memories are stored as Markdown files. The primary file is `MEMORY.md` in the workspace root. Longer-term or dated memories can be organized in a `memory/` subdirectory, with files named by date (`memory/YYYY-MM-DD.md`). Session transcripts are stored as JSONL files and are indexed as a secondary source category alongside the Markdown memory files.

The two source categories are `"memory"` (the Markdown files) and `"sessions"` (the JSONL transcript files). Search can target either or both categories.

### Context Injection Modes

Two modes exist for getting memories into agent context:

**Explicit**: The agent calls the `memory_search` tool during its turn. This is the most transparent approach: the agent's reasoning about what to search for is visible in the message history.

**Implicit**: A lifecycle hook fires before each agent turn and automatically searches for memories relevant to the incoming message. The results are injected into the system prompt without agent involvement. This is what the LanceDB plugin's lifecycle hook implements.

### Pre-compaction Flush

Before a session's context is compacted (trimmed to free token budget), OpenClaw fires a special agent turn whose sole purpose is to write durable memories. The agent identifies important facts from the session and writes them to `memory/YYYY-MM-DD.md`. This ensures that knowledge from long sessions survives compaction.

### Embedding Providers

The built-in backend supports five embedding providers: `openai`, `gemini`, `voyage`, `local` (a local model via an OpenAI-compatible endpoint), and `auto` (tries providers in order until one works). Batch API support is included for providers that support it, which matters for initial indexing of large memory stores.

---

## OpenClaw Channel System

### Architecture Flow

The channel system follows a linear pipeline:

```
Platform SDK (grammy, baileys, bolt)
  -> Channel Monitor (receives messages)
    -> Routing Layer (resolves session key, agent, target)
      -> Agent/Session (OpenClaw's Pi runtime, replaced by OpenCode in opencode-claw)
        -> Channel Send (delivers reply back to platform)
```

Each stage is decoupled. The routing layer does not know which platform the message came from. The agent runtime does not know which channel will deliver its response.

### ChannelPlugin Interface

`src/channels/plugins/types.plugin.ts` defines `ChannelPlugin`, an interface of roughly 30 optional adapter methods. Implementing a channel means providing whichever adapters make sense for that platform:

- `config` — declare config schema (validated at startup)
- `setup` — async initialization (connect to platform API)
- `pairing` — handle device pairing flows (WhatsApp QR code, etc.)
- `security` — allowlist/blocklist enforcement
- `groups` — group membership queries
- `mentions` — parse @mentions in messages
- `outbound` — send a message to the platform
- `streaming` — send a streaming/incremental update (for platforms that support it)
- `threading` — manage thread context
- `messaging` — message formatting and attachment handling
- `agentPrompt` — customize the prompt sent to the agent for this channel
- `agentTools` — declare additional tools available in this channel's sessions

Channels declare their capabilities via a `ChannelCapabilities` object. The capabilities cover: chat types (DM, group, channel), polls, reactions, message editing, unsending, replies, threads, media attachments, native commands, and block-level streaming. Routing and reply logic consult capabilities to avoid attempting operations the platform does not support.

### ChannelDock

`src/channels/dock.ts` defines static configuration for the eight built-in channels:

- `telegram`
- `whatsapp`
- `discord`
- `irc`
- `googlechat`
- `slack`
- `signal`
- `imessage`

Each entry in the dock specifies the channel's plugin module path, default config, and capability flags.

### Session Key System

`src/routing/session-key.ts` defines the session key format:

```
agent:<agentId>:<channel>:<peerKind>:<peerId>
```

The `dmScope` setting controls how tightly sessions are isolated:

- `main` — one global session for all inbound messages
- `per-peer` — one session per unique sender identity
- `per-channel-peer` — one session per (channel, sender) pair
- `per-account-channel-peer` — one session per (account, channel, sender) triple

This scheme lets the routing layer map any incoming message to the correct existing session or create a new one. It is the critical bridge between the stateless channel layer and the stateful agent layer.

### Routing

`src/routing/resolve-route.ts` implements priority-based binding resolution. When a message arrives, the router walks a priority chain to find the most specific matching binding:

```
peer > guild > team > account > channel > default
```

The most specific matching binding wins. This lets admins configure a special agent for a specific user (peer-level) while falling back to a default agent for everyone else (channel-level or default).

### MsgContext

`src/auto-reply/templating.ts` defines `MsgContext`, a normalized inbound message representation with over 50 fields. These cover: sender identity, channel identity, message content (text, media, attachments), thread context, reply-to references, timestamps, platform-specific metadata, and routing annotations added by the routing layer. Every channel adapter produces a `MsgContext` from its platform-native message format. Downstream logic only ever sees `MsgContext`.

### Platform Implementations

**Telegram** uses `grammy` with `@grammyjs/runner` for concurrent message processing. Messages are sequentialized per chat ID to prevent race conditions on the same session. Deduplication is applied using message IDs. Both polling and webhook modes are supported.

**Slack** uses `@slack/bolt` in either Socket Mode (no public URL needed) or HTTP mode (with a public endpoint). Allowlist resolution maps Slack user IDs to internal peer IDs. Slash commands are parsed and dispatched separately from regular messages.

**WhatsApp** uses `@whiskeysockets/baileys`, a reverse-engineered WhatsApp Web client. Inbound messages arrive via the `messages.upsert` event. Debouncing is applied to handle the rapid-fire delivery that WhatsApp does when reconnecting after downtime. Group metadata is cached locally to avoid redundant API calls.

### Session Recording

`recordInboundSession()` stores the `lastRoute` for each inbound message. When the agent produces a reply, the system looks up `lastRoute` to know which channel and which peer to deliver to. This decouples the delivery path from the routing logic: the agent does not need to know anything about the originating channel.

### Key Constraint

External messaging platforms should never receive streaming or partial replies. A half-written message appearing in a Telegram chat or Slack channel creates a poor user experience and cannot be retracted cleanly on all platforms. All channel adapters buffer the complete agent response before sending.

---

## OpenClaw Cron System

The cron system lives in `src/cron/` across 37 files. It is constructed at gateway startup by `buildGatewayCronService({cfg, deps, broadcast})`.

The cron service handles:

- **Scheduling**: CRON expression or interval-based triggers for recurring tasks
- **Delivery**: Routes triggered tasks to the correct agent session
- **Isolated agent execution**: Each cron run gets its own session context to prevent pollution between runs
- **Session reaper**: Cleans up abandoned or expired sessions created by cron tasks
- **Store management**: Persists schedule state across gateway restarts

A typical cron use case is pulling from an issue tracker on a schedule: every 30 minutes, create a new session, ask the agent to check for new issues, and route any notifications back through the appropriate channel. The cron service abstracts the scheduling and session lifecycle, leaving the prompt content to configuration.

The heartbeat mechanism (step 15 in gateway startup) is related: it periodically pings connected WS clients and purges those that do not respond. This prevents the node registry from accumulating stale connections.

---

## OpenViking Framework

### Overview

OpenViking is a Python library (`pip install openviking`) released under Apache 2.0 by Volcengine. It is a memory and context management system for AI agents, designed to be embedded in agent applications either as a library or as a standalone HTTP server. The core abstraction is a virtual filesystem called the Context Database.

### Context Database

The Context Database presents memory as a filesystem accessible via standard path operations. Top-level namespaces:

- `viking://resources/` — static resources (docs, code, data files)
- `viking://user/memories/` — memories about the user
- `viking://agent/memories/` — memories the agent has accumulated about tasks and patterns
- `viking://agent/skills/` — skill definitions the agent can draw on

This virtual filesystem is the agent's persistent world model. Agents navigate it with filesystem-style operations rather than opaque database queries.

### Memory Categories

Six memory categories exist, split by mutability:

**Mutable (mergeable)**:
- `profile` — user identity and background
- `preferences` — user preferences and settings
- `entities` — people, places, projects the user references

**Immutable (append-only)**:
- `events` — things that happened
- `cases` — problems and how they were resolved
- `patterns` — recurring behaviors and workflows

The distinction matters for deduplication. Profile and preferences entries are merged when new information conflicts with old. Events and cases are never mutated; new information creates new entries.

### Session API and Memory Extraction

```python
session = client.session(session_id)
session.add_message(role="user", content="...")
session.add_message(role="assistant", content="...")
session.commit()
```

Calling `commit()` triggers an async pipeline that runs an LLM extraction pass over the session messages and writes extracted memories to the appropriate categories. This is the only way to write memories. There is no direct write API. This constraint ensures memory quality: all stored memories have been processed and categorized by an LLM rather than being raw message dumps.

### Search Modes

Two search modes:

- `find(query)` — fast, no LLM, pure vector/keyword matching against stored memories
- `search(query)` — intent-aware, may issue multiple sub-queries, uses an LLM to interpret the query before searching

`find()` is appropriate for latency-sensitive paths (e.g., injecting context before each agent turn). `search()` is for deliberate recall where quality matters more than speed.

### Token Budget Layers

Memory content is served at three abstraction levels to fit different token budgets:

- `L0` (~100 tokens): abstract summary, suitable for scanning many memories
- `L1` (~2,000 tokens): overview with key details
- `L2`: full content, no token restriction

Agents can request memories at L0 to survey the landscape cheaply, then fetch specific entries at L2.

### Filesystem API

The Context Database supports: `ls`, `read`, `abstract`, `overview`, `tree`, `grep`, `glob`, `mv`, `mkdir`, `stat`, `link`. These map closely to shell commands, making it natural for an AI agent to explore and manage memory using the same mental model it uses for real filesystems.

### Deployment Modes

**Embedded**:
- `SyncOpenViking` — synchronous Python API
- `AsyncOpenViking` — async Python API (for asyncio applications)

**HTTP Server**:
- `SyncHTTPClient` — connects to a running OpenViking HTTP server synchronously
- `AsyncHTTPClient` — connects asynchronously

The HTTP server mode is useful when multiple processes or services need to share the same memory store. The embedded mode is simpler and appropriate when a single process owns the memory.

### Key Constraints and Configuration

There is no direct memory write endpoint. All memory creation goes through the `session.commit()` pipeline. This is intentional: it enforces that an LLM extraction step runs on all stored content.

Embedding providers are limited to OpenAI and Volcengine. There is no local embedding option. This is a notable limitation compared to OpenClaw's built-in backend, which supports local embeddings.

Configuration is stored at `~/.openviking/ov.conf` as JSON.

---

## MonClaw Reference Architecture

MonClaw is described in a blog post as a minimal personal AI assistant built entirely on top of OpenCode's SDK. It serves as the reference design for what opencode-claw aims to become. The key architectural choices from MonClaw are worth documenting precisely because they show what is sufficient for a working system.

### Agent Runtime

MonClaw calls `createOpencode()` directly:

```typescript
const oc = await createOpencode({ port: 0 })
const session = await oc.client.session.create({ body: { title: "main" } })
await oc.client.session.prompt({
  path: { id: session.data.id },
  body: { parts: [{ type: "text", text: userMessage }] }
})
```

No custom agent runtime, no separate process manager. The OpenCode SDK handles subprocess lifecycle.

### Heartbeat

MonClaw runs a separate OpenCode session on a schedule (a cron-style interval). Before each heartbeat turn, it injects a summary of recent activity. The agent then decides whether anything warrants a notification to the user. If so, it fires a channel message. This keeps the agent proactive without building a separate notification system.

### Memory

MonClaw uses a single `MEMORY.md` file in the workspace root. A `save_memory` tool plugin writes to it. Before each agent turn, the system prompt includes the current contents of `MEMORY.md`. There is no vector search. For a personal assistant with one user, this is sufficient and keeps the system simple.

### Channels

MonClaw connects two channels: Telegram (via `grammy`) and WhatsApp (via `@whiskeysockets/baileys`). Both channels route inbound messages to the same shared OpenCode session. The agent sees messages from both platforms in one context, which is appropriate for a single-user personal assistant.

### Outbox Pattern

The agent does not send messages directly. Instead, a `send_channel_message` tool writes a JSON record to `.data/outbox/`. Channel adapter processes poll the outbox directory and drain it, delivering each record to the appropriate platform. This decoupling means the agent is never blocked on network I/O during delivery, and retries can be implemented in the adapter without affecting the agent's session state.

### Skills

MonClaw's plugin performs sparse-checkouts of GitHub repositories to pull in skill folders. A skill is a directory containing prompts, tools, and instructions for a specific domain. Skills are mounted into the agent's context at session start. This is how domain-specific capabilities are added without modifying the core agent.

### Plugins

Plugins are stored in `.agents/plugins/` and loaded dynamically via Bun's `import()` at startup. Each plugin file exports a `Plugin` object as defined by `@opencode-ai/plugin`. This is standard OpenCode plugin loading, adapted to MonClaw's file layout.

### Session Switching

A `/new` command resets context by creating a new OpenCode session while preserving channel routing. The old session is abandoned (not deleted). This gives users a clean break when they want to start a fresh conversation without ending the assistant's operation.

### Pairing and Whitelist

Allowed user IDs are persisted on disk as a JSON file. On startup, the file is loaded. When a new user contacts the assistant, they are rejected unless their ID is in the whitelist. Pairing (adding a new allowed user) is done via a command sent from an already-allowed account.

---

## Comparative Analysis

| Capability | OpenCode | OpenClaw | MonClaw | opencode-claw (planned) |
|---|---|---|---|---|
| **Agent Runtime** | Hono HTTP server, spawned by `createOpencode()` | Pi integration, custom IPC | OpenCode SDK (`createOpencode()`) | OpenCode SDK (`createOpencode()`) |
| **Memory System** | Custom tool plugins, no built-in persistence | `MemoryIndexManager` (SQLite + sqlite-vec + FTS5), `QmdMemoryManager`, LanceDB plugin | Single `MEMORY.md` + `save_memory` tool | Simple `MEMORY.md` default, OpenViking as advanced backend |
| **Channel Support** | Slack bot reference only | 8 channels via `ChannelPlugin` interface (Telegram, WhatsApp, Discord, IRC, Google Chat, Slack, Signal, iMessage) | Telegram + WhatsApp directly | Adapted `ChannelPlugin` interface (Telegram, WhatsApp, Slack at minimum) |
| **Session Management** | Full REST CRUD + fork/share/abort, SQLite persistence | Session key scheme (`agent:<id>:<channel>:<peer>:<id>`), `dmScope` isolation levels | Single shared session + `/new` command | Session key scheme adapted for OpenCode session IDs |
| **Plugin System** | 14 hook points via `@opencode-ai/plugin`, MCP servers, `.opencode/tool/` | Plugin auto-enable, `gateway_start` hook, channel plugins, sidecar plugins | `.agents/plugins/` loaded via `import()`, skill sparse-checkouts | OpenCode's 14 hook points as the plugin API |
| **Cron/Scheduling** | None built-in | 37-file cron system, `buildGatewayCronService()`, session reaper | Heartbeat interval with OpenCode session | Cron system adapted from OpenClaw, sessions via OpenCode |
| **Configuration** | `opencode.json` or `OPENCODE_CONFIG_CONTENT` env var | `~/.openclaw/openclaw.json`, hot-reload watcher | Environment variables + disk files | `~/.opencode-claw/config.json`, hot-reload |
| **Deployment Model** | Local binary or subprocess | Always-on Gateway on Raspberry Pi, Tailscale for remote access | Local process with Bun | Local process, optionally exposed via Tailscale |

---

## Key Takeaways for opencode-claw Design

### 1. OpenCode SDK as the Agent Runtime

OpenClaw's Pi integration is the only major component that needs replacement. Everything else (channels, routing, memory, cron) operates independently of the specific agent runtime. Swapping Pi for `createOpencode()` means calling the SDK's session and prompt methods instead of the Pi RPC methods.

The `x-opencode-directory` header provides multi-tenancy: a single OpenCode server instance can serve sessions for multiple workspaces. This maps to OpenClaw's workspace directory resolution (step 5 in startup).

The async prompt pattern (`promptAsync` + `client.event.subscribe()`) is the right interface for channel delivery, since channel adapters operate asynchronously and must not block the gateway event loop.

### 2. OpenClaw's ChannelPlugin Pattern

The `ChannelPlugin` interface is worth preserving but can be simplified. For opencode-claw, the interface should require only three adapters to be viable: `setup`, `outbound`, and `security`. All other adapters are optional enhancements. This lowers the barrier for implementing a new channel while keeping the interface extensible.

The `ChannelCapabilities` object should be preserved as-is. It provides a clean way to gate features without per-channel conditional logic in the router.

### 3. Pluggable Memory with Simple Default

A single `MEMORY.md` file is sufficient for personal use and is zero-configuration. It should be the default. OpenViking is a viable advanced backend for users who want semantic search and automatic extraction, but it requires Python, OpenAI or Volcengine API access, and a running server process. It should be opt-in.

OpenClaw's `MemorySearchManager` interface is a good model for the backend abstraction. Implementing it for both the simple file backend and for OpenViking gives a clean swap path without changing the rest of the system.

### 4. Session Key Scheme

The session key format `agent:<agentId>:<channel>:<peerKind>:<peerId>` maps naturally onto OpenCode session IDs. The opencode-claw routing layer should maintain a map from session key to OpenCode session ID. When a message arrives, the router derives the session key, looks up the OpenCode session ID, and uses that ID for the `session.prompt()` call. If no entry exists, a new OpenCode session is created and the mapping is stored.

The `dmScope` setting controls how aggressively sessions are shared across peers and channels. The default should be `per-channel-peer` (one session per sender per channel), which matches most users' expectations while keeping the session count manageable.

### 5. Outbox Pattern for Channel Delivery

Direct delivery from the agent turn handler to the channel API is fragile. Network failures, rate limits, and platform outages should not corrupt session state or lose messages. The outbox pattern from MonClaw solves this: the agent writes to a local outbox, and a separate delivery worker drains the outbox with retry logic.

For opencode-claw, the outbox can be a simple SQLite table (since OpenCode already uses SQLite) or a directory of JSON files. The key is that the agent's `send_channel_message` tool is always fast and local. Delivery latency is the delivery worker's problem, not the agent's.

### 6. Plugin System via OpenCode Hooks

OpenCode's 14 hook points cover the extension needs for opencode-claw without building a separate plugin system. Custom tools, system prompt injection, and permission handling are all addressable through the existing API. The `experimental.chat.system.transform` hook is particularly useful for memory injection.

The MonClaw pattern of loading plugins from `.agents/plugins/` via `import()` is a clean directory convention. opencode-claw should adopt this, pointing Bun's dynamic import at a configured plugin directory.

### 7. No Streaming to External Channels

This constraint from OpenClaw applies directly. OpenCode's event stream delivers incremental message parts. The channel delivery layer must buffer all parts until the `agent.turn.complete` event fires, then send the complete response. Partial messages sent to Telegram, WhatsApp, or Slack would create a confusing experience and may trigger duplicate message errors on platforms that do not support message editing.

The one exception is Slack, which supports message updates via `chat.update`. For Slack, an optional streaming mode that posts a placeholder and updates it progressively is acceptable, but it must be gated by the channel's `ChannelCapabilities.blockStreaming` flag and disabled by default.

### 8. Startup Order

OpenClaw's 22-step startup sequence is thorough but reflects the complexity of running eight channels on a Pi with Tailscale, mDNS, and hot-reload. opencode-claw's startup sequence can be much simpler:

1. Load and validate config
2. Start OpenCode server subprocess via `createOpencode()`
3. Initialize memory backend (file or OpenViking)
4. Load and initialize channel plugins in parallel
5. Start cron service
6. Register WS/HTTP handlers for the control plane
7. Start config watcher

Eight steps. No Tailscale, no mDNS, no browser sidecar, no Gmail watcher. The complexity should be added only when needed.

---

*End of investigation report.*
