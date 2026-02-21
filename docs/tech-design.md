# opencode-claw Technical Design Document

**Status**: Proposal  
**Date**: 2026-02-22  
**Author**: Engineering

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [System Architecture Overview](#2-system-architecture-overview)
3. [Pluggable Memory System](#3-pluggable-memory-system)
4. [Channel System](#4-channel-system)
5. [Cron Job System](#5-cron-job-system)
6. [Configuration Schema](#6-configuration-schema)
7. [Project Structure](#7-project-structure)
8. [Implementation Phases](#8-implementation-phases)
9. [Key Design Decisions](#9-key-design-decisions)
10. [Open Questions and Future Considerations](#10-open-questions-and-future-considerations)

---

## 1. Introduction

### 1.1 Project Name

**opencode-claw**

### 1.2 Vision

Transform OpenCode into a personal AI assistant accessible via messaging platforms (Slack, Telegram, WhatsApp), with persistent memory across sessions and automated task processing via cron jobs.

Most AI coding assistants are ephemeral. You open a session, get help, close it, and all context evaporates. opencode-claw fixes this by wrapping OpenCode with three capabilities that make it feel like a persistent collaborator:

1. **Channels** — reach your assistant from wherever you already communicate
2. **Memory** — context that survives across sessions, projects, and days
3. **Cron** — proactive check-ins that bring information to you, not the other way around

### 1.3 Foundation

Built on `@opencode-ai/sdk`. OpenCode already handles the hard parts: LLM routing, tool execution, session state, file editing, MCP server management, and the plugin system. opencode-claw is the glue layer on top.

We do not fork or modify OpenCode. We wrap it.

### 1.4 Inspiration

- **OpenClaw**: architecture patterns for channels, memory backends, and cron scheduling
- **MonClaw**: practical patterns for OpenCode SDK integration, the outbox delivery model, and the single-file MEMORY.md approach

### 1.5 Key Constraints

- **TypeScript (ESM)** with strict typing. No `any`.
- **Bun** as runtime, matching OpenCode's own runtime.
- **Never stream partial replies** to external messaging channels. Wait for completion, then send the full response.
- **OpenCode SDK is the agent runtime.** We do not fork or modify OpenCode source.
- **Single-user by design** in v1. Multi-user is a future consideration, not a current target.

---

## 2. System Architecture Overview

### 2.1 High-Level Architecture

```
[Slack]  [Telegram]  [WhatsApp]
    \         |          /
     Channel Adapters
              |
        Message Router
         /    |     \
    Session  Memory  Cron
    Manager  System  Scheduler
         \    |     /
       OpenCode SDK
       (agent runtime)
              |
      [LLMs]  [MCP Servers]  [Tools]
```

The system wraps OpenCode SDK. Each component communicates through clearly defined interfaces. There is no WebSocket control plane or distributed message bus at this stage. Everything runs in a single Bun process.

The design is intentionally simple. A single process with well-separated concerns is easier to debug, deploy, and reason about than a distributed system.

### 2.2 Core Components

**Channel Adapters**

Platform-specific listeners that normalize inbound messages into a common `InboundMessage` shape and expose a `send()` method for outbound delivery. One adapter per platform.

**Message Router**

Receives normalized `InboundMessage` events from all active adapters. Intercepts session management commands (`/new`, `/switch`, etc.), then routes regular messages to the correct OpenCode session via the Session Manager.

**Session Manager**

Maps channel conversations to OpenCode sessions. The key insight: a channel conversation (identified by platform + peer ID + optional thread ID) maps to exactly one OpenCode session at a time. The manager handles creating, switching, and persisting this mapping.

**Memory System**

Pluggable backends for long-term memory. The agent can search and store memories as explicit tool calls. Memories are also injected automatically into the system prompt via an OpenCode plugin. Two backends: `TxtMemoryBackend` (default, zero dependencies) and `OpenVikingMemoryBackend` (advanced, semantic search).

**Cron Scheduler**

Runs scheduled jobs by creating a fresh OpenCode session, sending a configured prompt, and optionally routing the result to a channel via the Outbox. Jobs are configured in `opencode-claw.json`.

**Outbox**

A file-based async delivery queue. The agent (or cron scheduler) writes messages to `./data/outbox/`. A background drainer polls this directory and delivers messages via the appropriate channel adapter. This decouples agent execution from channel delivery and survives process restarts.

**Config Manager**

Loads and validates `opencode-claw.json` at startup using Zod schemas. Fails fast on invalid configuration.

**Plugin Host**

Uses OpenCode's plugin system to inject memory tools and system prompt context into every session. Plugins are registered once at startup and apply to all sessions.

### 2.3 Process Lifecycle

**Startup sequence:**

1. Load and validate `opencode-claw.json` (fail fast on errors)
2. Initialize OpenCode SDK: `const { client, server } = await createOpencode({ port: 0 })`
3. Initialize the memory backend (connect to OpenViking or prepare txt directory)
4. Register the memory plugin with the OpenCode client
5. Start enabled channel adapters (each connects to its platform)
6. Start the cron scheduler (schedule all enabled jobs)
7. Start the outbox drainer (poll loop begins)
8. Register shutdown handlers (SIGTERM, SIGINT)

**Shutdown sequence:**

1. Signal received (SIGTERM or SIGINT)
2. Stop accepting new inbound messages (pause channel adapters)
3. Wait for in-flight sessions to complete (with timeout)
4. Drain remaining outbox entries
5. Stop channel adapters
6. Stop cron scheduler
7. Close memory backend
8. Shut down OpenCode server
9. Persist session map to disk
10. Exit

---

## 3. Pluggable Memory System

### 3.1 Memory Interface

All memory backends implement this interface. Adding a new backend means implementing these six methods.

```typescript
interface MemoryBackend {
  /** Initialize the backend (connect, create directories, etc.) */
  initialize(): Promise<void>

  /** Search memories relevant to a query */
  search(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]>

  /** Store a new memory */
  store(entry: MemoryInput): Promise<void>

  /** Delete a memory by ID */
  delete(id: string): Promise<void>

  /** Get backend status */
  status(): Promise<MemoryStatus>

  /** Graceful shutdown */
  close(): Promise<void>
}

interface MemorySearchOptions {
  limit?: number
  sessionId?: string
  category?: MemoryCategory
  minRelevance?: number
}

interface MemoryEntry {
  id: string
  content: string
  category: MemoryCategory
  source: string          // e.g., "session:abc123", "manual", "cron:linear-check"
  createdAt: Date
  relevance?: number      // search score (0-1, higher is more relevant)
  metadata?: Record<string, unknown>
}

interface MemoryInput {
  content: string
  category: MemoryCategory
  source: string
  metadata?: Record<string, unknown>
}

type MemoryCategory =
  | "project"      // project structure, tech stack, architecture decisions
  | "experience"   // lessons learned, debugging patterns, what went wrong
  | "preference"   // user preferences, coding style, communication style
  | "entity"       // people, services, tools, teams
  | "event"        // incidents, deployments, meetings, milestones
  | "knowledge"    // domain knowledge, how things work, concepts

type MemoryStatus = {
  backend: string
  initialized: boolean
  entryCount: number
  lastSync?: Date
}
```

### 3.2 TxtMemoryBackend (Default)

The simplest possible backend. Memories are markdown-formatted text files on disk.

**Storage layout:**

```
data/memory/
├── MEMORY.md              # Main memory file (all entries)
└── archive/
    ├── 2024-03-01.md      # Daily archives (created by compaction)
    └── 2024-03-02.md
```

**File format** (`MEMORY.md`):

```markdown
## [project] 2024-03-15T10:30:00Z | source:session:abc123

The citronetic project uses a Bun + TypeScript monorepo. The opencode-claw
subpackage lives at opencode-claw/. Shared utilities go in packages/core/.

---

## [experience] 2024-03-15T11:00:00Z | source:session:abc123

When debugging SQLite locks, always check for unclosed transactions first.
The most common cause in this codebase is forgetting to await db.close().

---

## [preference] 2024-03-16T09:15:00Z | source:manual

Prefers short function names, explicit return types, and no barrel files.
Test files live next to source files, not in a separate __tests__ directory.

---
```

**Search implementation:**

Full-text grep with basic relevance scoring. Relevance is computed as the number of query tokens that appear in the memory entry divided by the total query tokens. Entries scoring below `minRelevance` (default: 0.1) are excluded. Results are sorted by score descending.

This is not semantic search. It works well for specific terminology (function names, service names, technology names) and less well for conceptual queries. That's fine for a default backend.

**Store implementation:**

Append a new section to `MEMORY.md`. Each entry gets a unique ID (timestamp + random suffix).

**Advantages:**
- Zero dependencies beyond Node.js/Bun file APIs
- Human-readable and directly editable
- Git-trackable (memory becomes part of project history)
- Works offline, no external services
- Sufficient for personal use with moderate memory volume

**Limitations:**
- No semantic search (keyword overlap only)
- Linear scan (performance degrades with thousands of entries)
- No deduplication (similar memories accumulate)
- No automatic compaction (MEMORY.md grows unbounded without intervention)

### 3.3 OpenVikingMemoryBackend (Advanced)

OpenViking is a Python memory library with semantic search, intent-aware query expansion, and a structured category system. It offers substantially better recall for conceptual queries.

**Integration strategy:**

OpenViking is Python-only. Two modes are supported:

*HTTP mode (recommended for production):*  
Run OpenViking as a separate HTTP server (`python -m openviking.server --port 8100`). opencode-claw connects as an HTTP client. Clean process separation, independent lifecycle management.

*Subprocess mode (for development):*  
Spawn the OpenViking server as a child process. opencode-claw manages its lifecycle. Simpler setup, but harder to debug and creates tighter coupling.

Recommendation: HTTP mode for production. Subprocess mode for local development where you want a single `bun run start` to bring everything up.

**Category mapping:**

OpenViking uses its own category taxonomy. The mapping to opencode-claw's categories:

| opencode-claw | OpenViking |
|---------------|------------|
| `project` | `patterns` |
| `experience` | `cases` |
| `preference` | `preferences` |
| `entity` | `entities` |
| `event` | `events` |
| `knowledge` | `patterns` |

**Implementation sketch:**

```typescript
class OpenVikingMemoryBackend implements MemoryBackend {
  private client: OpenVikingHttpClient

  constructor(private config: OpenVikingConfig) {
    this.client = new OpenVikingHttpClient(config.url)
  }

  async search(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]> {
    const results = await this.client.search({
      query,
      limit: options?.limit ?? 10,
      session_id: options?.sessionId,
      category: options?.category ? mapToVikingCategory(options.category) : undefined,
    })
    return results.map(r => ({
      id: r.id,
      content: r.content,
      category: mapFromVikingCategory(r.category),
      source: r.source ?? "openviking",
      createdAt: new Date(r.created_at),
      relevance: r.score,
      metadata: r.metadata,
    }))
  }

  async store(entry: MemoryInput): Promise<void> {
    await this.client.store({
      content: entry.content,
      category: mapToVikingCategory(entry.category),
      source: entry.source,
      metadata: entry.metadata,
    })
  }

  async status(): Promise<MemoryStatus> {
    const info = await this.client.info()
    return {
      backend: "openviking",
      initialized: true,
      entryCount: info.total_entries,
      lastSync: info.last_sync ? new Date(info.last_sync) : undefined,
    }
  }
}
```

**Fallback behavior:**

If OpenViking is unavailable at startup and `fallback: true` is set in config, opencode-claw falls back to `TxtMemoryBackend`. This allows the service to start even when OpenViking is down.

### 3.4 Memory Integration with OpenCode

Memory is wired into OpenCode via the plugin system. The plugin does two things: registers memory tools the agent can call explicitly, and injects relevant memories into the system prompt automatically.

```typescript
const memoryPlugin: Plugin = async ({ client }) => ({
  // Explicit tools: agent can call these directly
  tool: {
    memory_search: {
      description: "Search long-term memory for relevant context about projects, experiences, preferences, or entities",
      args: {
        query: z.string().describe("What to search for"),
        category: z.enum(["project", "experience", "preference", "entity", "event", "knowledge"]).optional(),
        limit: z.number().int().min(1).max(20).optional().default(5),
      },
      execute: async ({ query, category, limit }) => {
        const results = await memoryBackend.search(query, { category, limit })
        if (results.length === 0) return "No relevant memories found."
        return results.map(r => `[${r.category}] ${r.content}`).join("\n\n---\n\n")
      },
    },
    memory_store: {
      description: "Store important information in long-term memory for future sessions",
      args: {
        content: z.string().describe("The information to remember"),
        category: z.enum(["project", "experience", "preference", "entity", "event", "knowledge"]),
      },
      execute: async ({ content, category }) => {
        await memoryBackend.store({ content, category, source: `session:${sessionId}` })
        return "Stored in memory."
      },
    },
  },

  // Implicit injection: auto-inject relevant memories into every session's system prompt
  "experimental.chat.system.transform": async (input, output) => {
    const queryText = input.parts
      .map(p => (p.type === "text" ? p.text : ""))
      .join(" ")
      .slice(0, 500)  // Don't blow up on huge messages

    const memories = await memoryBackend.search(queryText, { limit: 5 })
    if (memories.length === 0) return

    const memoryBlock = memories
      .map(m => `- [${m.category}] ${m.content}`)
      .join("\n")

    output.system.push(`\n\n## Relevant Context from Memory\n${memoryBlock}`)
  },
})
```

The agent receives memory context without having to ask for it. If it needs more specific context, it can call `memory_search` directly.

### 3.5 Memory Backend Selection

Backend is chosen by the `memory.backend` field in config:

```json
{
  "memory": {
    "backend": "txt",
    "txt": {
      "directory": "./data/memory"
    },
    "openviking": {
      "mode": "http",
      "url": "http://localhost:8100",
      "embedding": "openai",
      "fallback": true
    }
  }
}
```

The backend is instantiated once at startup and shared across all sessions and cron jobs.

---

## 4. Channel System

### 4.1 Channel Adapter Interface

All channel adapters implement this interface:

```typescript
interface ChannelAdapter {
  /** Unique channel identifier */
  readonly id: ChannelId

  /** Human-readable display name */
  readonly name: string

  /** Start listening for inbound messages */
  start(handler: InboundMessageHandler): Promise<void>

  /** Stop listening */
  stop(): Promise<void>

  /** Send a message to a specific peer */
  send(peerId: string, message: OutboundMessage): Promise<void>

  /** Get current connection status */
  status(): ChannelStatus
}

type ChannelId = "slack" | "telegram" | "whatsapp"

interface InboundMessage {
  channel: ChannelId
  peerId: string          // unique user identifier on this platform
  peerName?: string       // display name (best-effort)
  groupId?: string        // group or channel ID if message is from a group
  threadId?: string       // thread identifier if applicable
  text: string
  mediaUrl?: string       // URL of attached media, if any
  replyToId?: string      // message ID being replied to
  raw: unknown            // platform-specific raw event, for debugging
}

interface OutboundMessage {
  text: string
  threadId?: string       // reply into this thread
  replyToId?: string      // reply to this specific message
}

type InboundMessageHandler = (msg: InboundMessage) => Promise<void>

type ChannelStatus = "connected" | "disconnected" | "connecting" | "error"
```

### 4.2 Session Routing

The Session Manager maps every channel conversation to exactly one OpenCode session at a time.

**Session key scheme:**

```
opencode-claw:<channel>:<peerId>[:thread:<threadId>]
```

Examples:
- `opencode-claw:telegram:12345` — DM with Telegram user 12345
- `opencode-claw:slack:U0123ABC:thread:T456DEF` — Slack thread
- `opencode-claw:whatsapp:5511999887766` — WhatsApp DM

Keys are human-readable, deterministic, and durable. If an OpenCode session gets deleted, the key still works by creating a new one.

**Session Manager:**

```typescript
class SessionManager {
  // sessionKey -> opencode sessionId
  private sessionMap: Map<string, string> = new Map()
  private client: OpencodeClient

  /** Get the OpenCode session for a conversation, creating one if needed */
  async resolveSession(key: string, title?: string): Promise<string> {
    if (this.sessionMap.has(key)) {
      return this.sessionMap.get(key)!
    }
    const session = await this.client.session.create({
      body: { title: title ?? key },
    })
    this.sessionMap.set(key, session.data.id)
    await this.persist()
    return session.data.id
  }

  /** Switch a conversation to a different OpenCode session */
  async switchSession(key: string, targetSessionId: string): Promise<void> {
    this.sessionMap.set(key, targetSessionId)
    await this.persist()
  }

  /** Create a new session for a conversation */
  async newSession(key: string, title?: string): Promise<string> {
    const session = await this.client.session.create({
      body: { title: title ?? `New session ${new Date().toISOString()}` },
    })
    this.sessionMap.set(key, session.data.id)
    await this.persist()
    return session.data.id
  }

  /** List all sessions associated with a peer prefix */
  async listSessions(channelPeerPrefix: string): Promise<SessionInfo[]> {
    const allSessions = await this.client.session.list()
    const peerKeys = [...this.sessionMap.entries()]
      .filter(([key]) => key.includes(channelPeerPrefix))
      .map(([key, id]) => ({ key, id }))

    return peerKeys.map(({ key, id }) => {
      const session = allSessions.data.find(s => s.id === id)
      return {
        id,
        key,
        title: session?.title ?? "(deleted)",
        createdAt: session?.createdAt,
        active: this.sessionMap.get(key) === id,
      }
    })
  }

  /** Persist session map to disk */
  private async persist(): Promise<void> {
    const data = Object.fromEntries(this.sessionMap)
    await Bun.write(this.config.persistPath, JSON.stringify(data, null, 2))
  }

  /** Load session map from disk */
  async load(): Promise<void> {
    const file = Bun.file(this.config.persistPath)
    if (await file.exists()) {
      const data = await file.json()
      for (const [key, id] of Object.entries(data)) {
        this.sessionMap.set(key, id as string)
      }
    }
  }
}
```

### 4.3 Session Switching Commands

Users control their sessions via commands sent in chat. Commands are intercepted by the Message Router before reaching OpenCode.

| Command | Description |
|---------|-------------|
| `/new [title]` | Create a new session and switch to it. Accepts optional title. |
| `/switch <id>` | Switch to an existing OpenCode session by ID. |
| `/sessions` | List sessions associated with this conversation. |
| `/current` | Show the current session ID and title. |
| `/fork` | Duplicate the current session into a new one and switch. |
| `/help` | Show available commands. |

Command responses are sent directly back to the channel without going through OpenCode.

### 4.4 Message Flow

The complete path from platform message to agent response:

```
1. Platform SDK delivers event (grammy Update, Bolt message event, baileys messages.upsert)
2. Channel Adapter normalizes into InboundMessage
3. Message Router receives InboundMessage

4. Router checks allowlist
   - Peer not in allowlist -> silent drop or configured rejection message, stop

5. Router checks for commands
   - Message starts with "/" -> parse as command, handle internally, send response, stop
   - Regular message -> continue

6. Router computes session key from (channel, peerId, threadId)
7. SessionManager.resolveSession(key) -> opencodeSessionId

8. Router sends prompt to OpenCode:
   client.session.prompt({
     path: { id: opencodeSessionId },
     body: { parts: [{ type: "text", text: message.text }] }
   })

9. Router subscribes to events for this session:
   client.event.subscribe({ query: { sessionId: opencodeSessionId } })

10. Wait for completion event (message.completed or similar terminal event)
    - Do NOT stream partial tokens to the channel
    - Apply configurable timeout (default: 5 minutes)

11. Extract final assistant message text from event stream

12. Send reply:
    - For reply-to-inbound flows: channel.send(peerId, { text: reply, replyToId: message.id })
    - For agent-initiated: outbox.enqueue({ channel, peerId, text: reply })
```

### 4.5 Outbox Pattern

The outbox decouples agent execution from channel delivery. This is especially useful for cron jobs, which have no inbound message to reply to.

**Write side (agent tool or cron scheduler):**

```typescript
// Outbox entry format
interface OutboxEntry {
  id: string
  channel: ChannelId
  peerId: string
  text: string
  threadId?: string
  enqueuedAt: string  // ISO timestamp
  attempts: number
}

class OutboxWriter {
  async enqueue(entry: Omit<OutboxEntry, "id" | "enqueuedAt" | "attempts">): Promise<void> {
    const full: OutboxEntry = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
    }
    const path = `${this.config.directory}/${entry.channel}/${entry.peerId}/${full.id}.json`
    await Bun.write(path, JSON.stringify(full, null, 2))
  }
}
```

**Read side (drainer):**

```typescript
class OutboxDrainer {
  private interval: Timer | null = null

  start(): void {
    this.interval = setInterval(() => this.drain(), this.config.pollIntervalMs)
  }

  private async drain(): Promise<void> {
    const entries = await this.readPendingEntries()
    for (const entry of entries) {
      try {
        const adapter = this.channelAdapters.get(entry.channel)
        if (!adapter || adapter.status() !== "connected") continue

        await adapter.send(entry.peerId, { text: entry.text, threadId: entry.threadId })
        await Bun.file(entry.filePath).remove()
      } catch (err) {
        entry.attempts++
        if (entry.attempts >= this.config.maxAttempts) {
          // Move to dead letter directory
          await this.moveToDead(entry)
        } else {
          await Bun.write(entry.filePath, JSON.stringify(entry, null, 2))
        }
      }
    }
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
  }
}
```

Directory layout:
```
data/outbox/
├── telegram/
│   └── 12345/
│       └── 1234567890-abc123.json
├── slack/
│   └── U0123ABC/
│       └── 1234567890-def456.json
└── dead/                          # failed deliveries
    └── telegram/
        └── 12345/
            └── 1234567890-ghi789.json
```

### 4.6 Platform Implementations

#### Telegram Adapter

**Library:** `grammy` + `@grammyjs/runner`

**Authentication:** Bot token from config, set as `BOT_TOKEN` or directly in config.

**Message normalization:**
```typescript
// ctx.message -> InboundMessage
{
  channel: "telegram",
  peerId: String(ctx.from.id),
  peerName: ctx.from.first_name,
  groupId: ctx.chat.type !== "private" ? String(ctx.chat.id) : undefined,
  threadId: ctx.message.message_thread_id ? String(ctx.message.message_thread_id) : undefined,
  text: ctx.message.text ?? "",
  raw: ctx.message,
}
```

**Threading:** Telegram DMs don't have threads. Group topics (forum groups) map to `threadId`. Each DM is a single continuous session.

**Reply:** `ctx.reply(text)` for inline replies; `bot.api.sendMessage(chatId, text)` for outbox-triggered messages.

**Pairing:** Allowlist of Telegram user IDs (numbers as strings). Unknown users are silently ignored by default.

**Polling vs webhook:** Polling for development, webhook for production. Configured via `mode` field.

#### Slack Adapter

**Library:** `@slack/bolt`

**Authentication:** Bot token + App token (Socket Mode) or signing secret (HTTP mode).

**Message normalization:**
```typescript
// event -> InboundMessage
{
  channel: "slack",
  peerId: event.user,
  groupId: event.channel,
  threadId: event.thread_ts,
  text: event.text,
  raw: event,
}
```

**Threading:** Slack threads map naturally to session `threadId`. A user can have multiple parallel sessions (one per thread). The session key `opencode-claw:slack:U0123:thread:T456` gives each thread its own conversation history.

**Reply:** `say({ text, thread_ts })` to reply in the same thread; `client.chat.postMessage()` for outbox-triggered messages.

**Allowlist:** Either a list of user IDs, or omit to allow all workspace members. The latter is only appropriate for single-user Slack workspaces.

**Socket Mode vs HTTP:** Socket Mode for development (no public URL needed). HTTP for production (configure a webhook URL).

#### WhatsApp Adapter

**Library:** `@whiskeysockets/baileys`

**Authentication:** QR code scan on first run. Auth state persisted to `./data/whatsapp/auth/`. Reconnects automatically on subsequent starts.

**Message normalization:**
```typescript
// messages.upsert event -> InboundMessage
{
  channel: "whatsapp",
  peerId: message.key.remoteJid?.split("@")[0] ?? "",
  groupId: message.key.remoteJid?.endsWith("@g.us") ? message.key.remoteJid : undefined,
  text: message.message?.conversation ?? message.message?.extendedTextMessage?.text ?? "",
  raw: message,
}
```

**Threading:** No native thread concept. Each DM is one session. Groups use `groupId` to namespace sessions.

**Debouncing:** Mobile users often send messages as multiple rapid-fire texts. A 1-second debounce window collects all messages from the same peer within the window and concatenates them into a single prompt. Configurable via `debounceMs`.

**Allowlist:** Phone numbers in E.164 format (e.g., `15551234567`). Essential for WhatsApp adapters since the bot is accessible to anyone who has the number.

**Privacy note:** Messages are forwarded to the configured LLM provider. WhatsApp end-to-end encryption protects messages in transit, but the content is visible to this service and to the LLM. Users should understand this.

### 4.7 Security and Pairing

Every channel adapter enforces an allowlist. The allowlist is a list of platform-specific identifiers (user IDs, phone numbers) that are permitted to interact with the assistant.

**Rejection behavior** (configurable per channel):
- `"ignore"` — silently drop messages from unknown users (default, avoids confirming the bot exists)
- `"reject"` — send a rejection message: "This assistant is private."

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "7123456789:AAF...",
      "allowlist": ["12345678", "87654321"],
      "rejectionBehavior": "ignore"
    },
    "slack": {
      "enabled": true,
      "botToken": "xoxb-...",
      "appToken": "xapp-...",
      "allowlist": ["U0123ABCD"]
    },
    "whatsapp": {
      "enabled": false,
      "allowlist": ["15551234567"],
      "authDir": "./data/whatsapp/auth",
      "debounceMs": 1000
    }
  }
}
```

No tokens or credentials are logged. The `raw` field in `InboundMessage` is only accessible internally and never written to persistent storage.

---

## 5. Cron Job System

### 5.1 Cron Interface

```typescript
interface CronJob {
  /** Unique job identifier (used in session titles, logs, memory source) */
  id: string

  /** Cron expression in standard 5-field format */
  schedule: string

  /** Human-readable description */
  description: string

  /**
   * The prompt sent to OpenCode when this job fires.
   * The agent has full tool access (MCP servers, file system, memory tools).
   */
  prompt: string

  /**
   * If set, the agent's final response is routed to this channel/peer
   * via the Outbox after the session completes.
   */
  reportTo?: {
    channel: ChannelId
    peerId: string
    threadId?: string
  }

  /** Skip this job if set to false. Useful for temporarily disabling. */
  enabled: boolean

  /**
   * Timeout in milliseconds for this job's session.
   * Default: 300000 (5 minutes)
   */
  timeoutMs?: number
}
```

### 5.2 Cron Scheduler

```typescript
class CronScheduler {
  private jobs: Map<string, { job: CronJob; handle: CronHandle }> = new Map()
  private client: OpencodeClient
  private outbox: OutboxWriter
  private logger: Logger

  async start(jobs: CronJob[]): Promise<void> {
    for (const job of jobs) {
      if (!job.enabled) {
        this.logger.info(`cron: skipping disabled job "${job.id}"`)
        continue
      }
      const handle = cron(job.schedule, async () => {
        this.logger.info(`cron: firing job "${job.id}"`)
        await this.executeJob(job)
      })
      this.jobs.set(job.id, { job, handle })
      this.logger.info(`cron: scheduled "${job.id}" (${job.schedule})`)
    }
  }

  private async executeJob(job: CronJob): Promise<void> {
    const sessionTitle = `cron:${job.id}:${new Date().toISOString()}`
    const session = await this.client.session.create({
      body: { title: sessionTitle },
    })

    const sessionId = session.data.id
    let timedOut = false

    const timeoutHandle = setTimeout(() => {
      timedOut = true
      this.logger.warn(`cron: job "${job.id}" timed out after ${job.timeoutMs ?? 300000}ms`)
    }, job.timeoutMs ?? 300000)

    try {
      // Send the job prompt. The memory plugin auto-injects relevant context.
      await this.client.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text: job.prompt }] },
      })

      // Wait for session completion
      const finalMessage = await this.waitForCompletion(sessionId, job.timeoutMs ?? 300000)

      if (timedOut || !finalMessage) return

      // Route result to channel if configured
      if (job.reportTo && finalMessage.trim()) {
        await this.outbox.enqueue({
          channel: job.reportTo.channel,
          peerId: job.reportTo.peerId,
          text: finalMessage,
          threadId: job.reportTo.threadId,
        })
        this.logger.info(`cron: job "${job.id}" result enqueued to ${job.reportTo.channel}:${job.reportTo.peerId}`)
      }
    } catch (err) {
      this.logger.error(`cron: job "${job.id}" failed`, { error: err })
    } finally {
      clearTimeout(timeoutHandle)
    }
  }

  private async waitForCompletion(sessionId: string, timeoutMs: number): Promise<string | null> {
    // Subscribe to session events, collect messages, return last assistant text on completion
    // Implementation uses client.event.subscribe() and resolves on terminal event
    return null // placeholder
  }

  async stop(): Promise<void> {
    for (const { handle } of this.jobs.values()) {
      handle.stop()
    }
    this.jobs.clear()
  }
}
```

### 5.3 Built-in Cron Job Examples

These are configuration examples, not hardcoded jobs. The behavior is entirely determined by the prompt and whatever MCP servers are configured in OpenCode.

**Linear check-in (weekday mornings):**
```json
{
  "id": "linear-check",
  "schedule": "0 9 * * 1-5",
  "description": "Check Linear for new assigned issues",
  "prompt": "Check my Linear workspace for any issues assigned to me that were created or updated in the last 24 hours. For each one, summarize the issue and suggest a starting approach based on any relevant context in memory. Format the summary as a short briefing I can read in under 2 minutes.",
  "reportTo": { "channel": "slack", "peerId": "U0123ABCD" },
  "enabled": true
}
```

**Jira standup preparation:**
```json
{
  "id": "jira-standup",
  "schedule": "0 8 * * 1-5",
  "description": "Generate standup from Jira activity",
  "prompt": "Review my Jira board. Summarize what I completed yesterday, what I'm working on today, and any blockers. Format it as a standup update that I can paste directly into Slack. Keep it under 150 words.",
  "reportTo": { "channel": "telegram", "peerId": "12345678" },
  "enabled": false
}
```

**End-of-day memory consolidation:**
```json
{
  "id": "eod-consolidation",
  "schedule": "0 18 * * 1-5",
  "description": "Consolidate learnings from today's sessions into memory",
  "prompt": "Review today's session history. Identify any new patterns, debugging insights, or decisions worth preserving. Use the memory_store tool to save anything important. Focus on things that would be useful to know in a future session on the same projects.",
  "enabled": true
}
```

Note: Linear and Jira access requires the corresponding MCP servers to be configured in OpenCode's `opencode.json`. The cron job just sends a prompt. The agent uses whatever tools it has available.

### 5.4 Session Lifecycle for Cron Jobs

Cron sessions are ephemeral by default. They're not mapped to a channel conversation in the session map, so they don't accumulate in the user's session list.

Optional: A `keepSession: true` flag on a job would preserve the session in the session map under a key like `opencode-claw:cron:linear-check`. This would allow users to manually browse the session history in OpenCode's TUI.

### 5.5 Cron Scheduling Library

Use `node-cron` or Bun's built-in timers with a cron expression parser. The schedule field follows standard 5-field cron syntax:

```
* * * * *
| | | | |
| | | | day of week (0-7, Sunday = 0 or 7)
| | | month (1-12)
| | day of month (1-31)
| hour (0-23)
minute (0-59)
```

All schedules run in the server's local timezone unless an IANA timezone is specified in the job config.

---

## 6. Configuration Schema

### 6.1 Full Config Schema (TypeScript)

```typescript
interface OpenCodeClawConfig {
  /** OpenCode configuration overrides */
  opencode?: {
    /** Path to opencode.json. Default: auto-detect from cwd. */
    configPath?: string
    /** Port for the OpenCode HTTP server. Default: 0 (random available port). */
    port?: number
    /** Working directory passed to OpenCode. Default: process.cwd(). */
    directory?: string
  }

  /** Memory system configuration */
  memory: {
    backend: "txt" | "openviking"
    txt?: {
      /** Directory for memory files. Default: "./data/memory". */
      directory?: string
    }
    openviking?: {
      /** How to connect to OpenViking. */
      mode: "http" | "subprocess"
      /** URL for http mode. Default: "http://localhost:8100". */
      url?: string
      /** Data directory for subprocess mode. */
      path?: string
      /** Embedding provider. */
      embedding?: "openai" | "volcengine"
      /** Fall back to TxtMemoryBackend if OpenViking is unavailable. Default: true. */
      fallback?: boolean
    }
  }

  /** Channel configurations */
  channels: {
    telegram?: {
      enabled: boolean
      botToken: string
      allowlist: string[]
      mode?: "polling" | "webhook"
      webhookUrl?: string
      rejectionBehavior?: "ignore" | "reject"
    }
    slack?: {
      enabled: boolean
      botToken: string
      appToken: string
      allowlist?: string[]
      mode?: "socket" | "http"
      signingSecret?: string
      rejectionBehavior?: "ignore" | "reject"
    }
    whatsapp?: {
      enabled: boolean
      allowlist: string[]
      authDir?: string
      debounceMs?: number
      rejectionBehavior?: "ignore" | "reject"
    }
  }

  /** Cron job configurations */
  cron?: {
    enabled?: boolean
    /** Default timeout for all jobs in milliseconds. Default: 300000. */
    defaultTimeoutMs?: number
    jobs: CronJob[]
  }

  /** Session management */
  sessions?: {
    /** Template for auto-generated session titles. Default: "{{channel}}:{{peerId}}". */
    titleTemplate?: string
    /** Path to persist session map. Default: "./data/sessions.json". */
    persistPath?: string
  }

  /** Outbox configuration */
  outbox?: {
    /** Outbox directory. Default: "./data/outbox". */
    directory?: string
    /** Poll interval in milliseconds. Default: 500. */
    pollIntervalMs?: number
    /** Max delivery attempts before moving to dead letter. Default: 3. */
    maxAttempts?: number
  }

  /** Logging configuration */
  log?: {
    level?: "debug" | "info" | "warn" | "error"
    /** Path to write log file. Logs to stdout if omitted. */
    file?: string
  }
}
```

### 6.2 Config File Location and Loading

**Search order:**

1. Path set in `OPENCODE_CLAW_CONFIG` environment variable
2. `./opencode-claw.json` in the current working directory
3. `~/.config/opencode-claw/config.json`

First match wins. If no config file is found, startup fails with a clear error message pointing to the example config.

**Validation:**

Config is validated with Zod at startup. On validation failure, all errors are printed together (not just the first), and the process exits. This prevents silent misconfiguration.

**Sensitive values:**

Tokens and credentials can be provided via environment variables instead of directly in the config file:

```json
{
  "channels": {
    "telegram": {
      "botToken": "${TELEGRAM_BOT_TOKEN}"
    }
  }
}
```

The loader expands `${VAR_NAME}` patterns from environment variables before validation.

### 6.3 Example Config File

The repository ships with `opencode-claw.example.json` containing all fields with comments (as a JSON5 or annotated JSON). Users copy this to `opencode-claw.json` and fill in their values.

---

## 7. Project Structure

```
opencode-claw/
├── src/
│   ├── index.ts                   # Entry point: startup and wiring
│   ├── config/
│   │   ├── schema.ts              # Zod validation schema
│   │   ├── loader.ts              # Config loading, env expansion, validation
│   │   └── types.ts               # TypeScript types derived from Zod schema
│   ├── channels/
│   │   ├── types.ts               # ChannelAdapter interface and message types
│   │   ├── router.ts              # Message router: dispatch, commands, allowlist
│   │   ├── telegram.ts            # Telegram adapter (grammy)
│   │   ├── slack.ts               # Slack adapter (@slack/bolt)
│   │   └── whatsapp.ts            # WhatsApp adapter (baileys)
│   ├── memory/
│   │   ├── types.ts               # MemoryBackend interface and data types
│   │   ├── factory.ts             # Backend selection and instantiation
│   │   ├── txt.ts                 # TxtMemoryBackend implementation
│   │   ├── openviking.ts          # OpenVikingMemoryBackend implementation
│   │   └── plugin.ts              # OpenCode plugin: memory tools + system prompt injection
│   ├── sessions/
│   │   ├── manager.ts             # SessionManager: key->id mapping
│   │   └── persistence.ts         # Load/save session map to disk
│   ├── cron/
│   │   ├── scheduler.ts           # CronScheduler: schedule, execute, report
│   │   └── types.ts               # CronJob type definition
│   ├── outbox/
│   │   ├── writer.ts              # OutboxWriter: enqueue messages to disk
│   │   └── drainer.ts             # OutboxDrainer: poll + deliver + dead letter
│   └── utils/
│       ├── logger.ts              # Structured logger (wraps consola or pino)
│       └── shutdown.ts            # Graceful shutdown handler
├── data/                          # Runtime data directory (gitignored)
│   ├── memory/                    # TxtMemoryBackend files
│   │   └── MEMORY.md
│   ├── outbox/                    # Pending outbound messages
│   ├── sessions.json              # Session key -> ID persistence
│   └── whatsapp/
│       └── auth/                  # WhatsApp authentication state
├── docs/
│   ├── investigation-report.md    # Research and findings
│   └── tech-design.md             # This document
├── opencode-claw.example.json     # Annotated example configuration
├── package.json
├── tsconfig.json
├── biome.json                     # Linting and formatting (matches OpenCode)
├── .gitignore
└── README.md
```

**Dependencies:**

Runtime:
- `@opencode-ai/sdk` — OpenCode agent runtime
- `grammy`, `@grammyjs/runner` — Telegram
- `@slack/bolt` — Slack
- `@whiskeysockets/baileys` — WhatsApp
- `node-cron` — Cron scheduling
- `zod` — Config validation

Dev:
- `typescript`
- `@types/bun`
- `biome` — lint and format

No ORM or database dependencies. All persistence is plain JSON files or markdown. This is intentional: it keeps the setup simple and the data human-readable.

---

## 8. Implementation Phases

### Phase 1: Core Foundation (Week 1-2)

Get the skeleton running before adding any features.

- Project scaffolding: `package.json`, `tsconfig.json`, `biome.json`, directory structure
- Config schema (Zod) and loader with env variable expansion
- OpenCode SDK integration: call `createOpencode()`, verify session CRUD works
- Session Manager: key scheme, create/resolve/persist
- Logger (structured, level-filtered)
- Graceful shutdown handler

**Exit criteria:** Can create and send a prompt to an OpenCode session programmatically from a Bun script.

### Phase 2: First Channel (Week 2-3)

Get end-to-end message flow working before adding more channels.

- Channel adapter interface and base types
- Telegram adapter (grammy, polling mode)
- Message Router: inbound -> session -> prompt -> wait -> response
- Session commands: `/new`, `/switch`, `/sessions`, `/current`
- Allowlist enforcement

**Exit criteria:** Can send a message in Telegram and get a response from OpenCode.

### Phase 3: Memory System (Week 3-4)

Add persistence across sessions.

- Memory backend interface
- TxtMemoryBackend: store, search, basic relevance scoring
- OpenCode plugin: `memory_search` and `memory_store` tools
- System prompt injection (auto-search on every inbound message)
- Manual test: store a fact, start new session, verify it's recalled

**Exit criteria:** Agent recalls information from previous sessions without being explicitly prompted to look it up.

### Phase 4: Additional Channels (Week 4-5)

- Slack adapter (Socket Mode)
- WhatsApp adapter (baileys, QR auth)
- Outbox writer and drainer
- WhatsApp debouncing
- Slack threading support

**Exit criteria:** All three channels work. Cron-style messages can be delivered via outbox without an inbound message context.

### Phase 5: Cron System (Week 5-6)

- `CronScheduler` with `node-cron`
- Session creation and prompt execution for jobs
- Wait-for-completion logic (event subscription)
- Outbox delivery for `reportTo` jobs
- Config-driven job definitions

**Exit criteria:** A configured cron job fires on schedule, the agent runs with full tool access, and the result arrives in the configured channel.

### Phase 6: OpenViking Integration (Week 6-7)

- `OpenVikingMemoryBackend` (HTTP client mode)
- Category mapping
- Fallback to TxtMemoryBackend on unavailability
- Memory factory: selects backend from config
- Compare recall quality against TxtMemoryBackend

**Exit criteria:** OpenViking backend works as a drop-in replacement for TxtMemoryBackend, with improved recall on semantic queries.

### Phase 7: Hardening and Polish (Week 7-8)

- Channel reconnection logic (exponential backoff)
- Timeout handling for long-running sessions
- Dead letter queue for failed outbox deliveries
- Health check endpoint (optional HTTP server on a debug port)
- Outbox dead letter alerting (log warning if dead letters accumulate)
- Config validation error messages (clear, actionable)
- Integration test suite (mock channel adapters, in-memory outbox)
- README and setup documentation

**Exit criteria:** Service runs stably for 72 hours without manual intervention. All integration tests pass.

---

## 9. Key Design Decisions

### 9.1 Why Wrap OpenCode SDK Instead of Forking

The appeal of forking is control. But the cost is ongoing maintenance: every OpenCode update becomes a merge exercise. OpenCode handles the genuinely hard parts: LLM provider routing, tool execution sandboxing, session state, file system tools, and MCP server management. We don't need to understand or maintain any of that.

The plugin system gives us enough extension points for everything we need: injecting memory into system prompts, adding custom tools, transforming session behavior. If a capability isn't reachable through plugins, that's a signal to upstream a plugin hook rather than fork.

### 9.2 Why the Outbox Pattern for Message Delivery

The naive approach is to call `channel.send()` directly after getting a response. This works for synchronous request-response flows, but breaks down in two scenarios:

1. **Cron jobs**: There's no inbound message and no channel context. The agent needs to send a message to a channel it wasn't contacted from.
2. **Process restarts**: If the process dies after the agent generates a response but before sending it, the response is lost.

The outbox solves both. Messages are durably written to disk before delivery. The drainer is a simple poll loop that delivers and deletes. Failed deliveries are retried and eventually quarantined in a dead letter directory.

The tradeoff is latency: the drainer polls every 500ms, so there's up to a 500ms additional delay. For a chat assistant, this is imperceptible.

### 9.3 Why Session Keys Instead of Direct Session ID Storage

Session IDs from OpenCode are opaque identifiers (`ses_abc123`). We need to map a channel conversation to one of these IDs.

The key scheme (`opencode-claw:telegram:12345`) encodes the full conversation context in a readable string. Benefits:

- **Idempotent**: the same user always produces the same key, regardless of when they first message
- **Debuggable**: reading `sessions.json` immediately tells you which session belongs to which user on which platform
- **Resilient**: if a session ID becomes stale (session deleted), the key still resolves by creating a new session
- **Composable**: thread IDs, group IDs, and channel IDs all compose naturally into the key

### 9.4 Why TxtMemoryBackend is the Default

The ideal memory system for a personal assistant is one you can actually inspect and edit. TxtMemoryBackend stores memories in `MEMORY.md`, a plain markdown file. You can open it in any text editor, add entries manually, delete entries that are wrong, and commit it to git alongside your code.

Semantic search sounds better until you realize that for a single-user personal assistant, you usually know what you're looking for. Keyword search on a well-organized memory file gets you most of the way there. OpenViking is there when you need it, but it shouldn't be required.

### 9.5 Why Cron Uses Prompts Rather Than Code

The alternative to prompt-driven cron jobs is code-driven jobs: each job is a TypeScript function that implements its own logic. This seems more powerful until you realize the agent already has all the tools: MCP servers for Linear, Jira, GitHub, file system access, web browsing.

A prompt is more flexible than code in this context. You can change what a job does by editing a string in `opencode-claw.json`, without touching or redeploying any code. You can be vague ("check if there's anything I should know about") or specific ("list all P1 issues created in the last 24 hours sorted by urgency"). The agent figures out the mechanics.

The main limitation is that prompts don't compose as cleanly as code. A prompt can't easily branch on conditions or iterate over a list with different handling per item. This is acceptable for the current use cases (briefings, summaries, check-ins).

### 9.6 Why Single Process

Running everything in a single Bun process keeps deployment simple. No Docker Compose, no service mesh, no inter-process communication protocols to debug. The tradeoff is that a crash in one component can affect others.

Mitigation: use structured error handling throughout, isolate channel adapters so a crash in one doesn't affect the others, and implement the graceful shutdown handler carefully.

When the scale or reliability requirements change, the architecture can be split: channels as separate processes communicating via the outbox, cron scheduler as a separate process. The file-based outbox makes this split straightforward.

---

## 10. Open Questions and Future Considerations

### Multi-user Support

The current design is explicitly single-user. Each channel conversation maps to a single OpenCode instance. Multi-user support would require either separate OpenCode instances per user (high resource cost) or tenant isolation within a single instance (complex session namespacing). This is intentionally deferred.

### Memory Compaction

`TxtMemoryBackend` grows unbounded. After months of use, `MEMORY.md` could become very large and slow to search. A compaction strategy is needed: either periodic summarization ("consolidate these 100 entries into 10 key insights"), TTL-based expiry, or a manual cleanup command. The `eod-consolidation` cron job pattern is a first step, but automatic compaction is a real need.

### Media Handling

Channel messages can include images, audio, documents, and video. The current design only handles text. Adding media support requires: (1) downloading the media from the platform, (2) storing it temporarily, (3) passing it to OpenCode as a file attachment or base64 data. The complexity varies by media type and platform.

### Voice Channels

A speech-to-text adapter (using Whisper or a cloud provider) could normalize voice messages to text before routing through the standard message flow. This would make the assistant accessible from voice-first interfaces without any special handling downstream.

### Agent Switching

OpenClaw supports multiple named agents per route (different system prompts, different tool configurations). opencode-claw could support this by allowing users to specify an agent profile in the session key or as a command (`/agent coding`, `/agent research`). Each agent profile would map to a different OpenCode config or system prompt override.

### Rate Limiting

Messaging platforms impose rate limits on outbound messages. Exceeding them triggers temporary bans. The outbox drainer should respect platform-specific rate limits: Telegram allows up to 30 messages per second (1 per chat per second is safer), WhatsApp is stricter. A token bucket or leaky bucket per channel adapter would prevent accidental bans.

### Web UI

OpenCode ships with a terminal UI. opencode-claw could expose a web chat interface on a local port, giving users a browser-based way to interact with the same agent and session history. This would be a separate adapter alongside the messaging channel adapters.

### End-to-End Encryption Considerations

WhatsApp messages are E2E encrypted between devices. When baileys receives a message, it decrypts it. From that point, the message is in plaintext and forwarded to the LLM provider. Users should be aware that their WhatsApp messages are sent to a third-party LLM API. This should be prominently documented, not buried in technical notes.

### Config Hot-Reload

Changing a cron schedule or adding a new allowlisted user currently requires restarting the process. A SIGHUP handler that reloads config and reconciles the running state (add/remove jobs, update allowlists) would improve operational ergonomics.

### Health Checks

A lightweight HTTP server on a configurable debug port could expose:
- `GET /health` — overall status (up/degraded/down)
- `GET /channels` — status of each channel adapter
- `GET /memory` — memory backend status and entry count
- `GET /cron` — list of scheduled jobs with next run times
- `GET /outbox` — pending and dead letter counts

This makes the service observable without requiring access to logs.
