# opencode-claw

Transform [OpenCode](https://opencode.ai) into a personal AI assistant accessible via messaging platforms, with persistent memory and automated task processing.

## What is this?

opencode-claw wraps the `@opencode-ai/sdk` to add three capabilities that OpenCode doesn't have out of the box:

1. **Pluggable Memory** -- Persistent knowledge across projects and sessions. Ships with a simple text-file backend (Markdown files, zero dependencies) and an optional [OpenViking](https://github.com/volcengine/OpenViking) backend for semantic search.

2. **Paired Channels** -- Chat with your AI assistant from Slack, Telegram, or WhatsApp. Each conversation maps to an OpenCode session. Users can create new sessions, switch between them, and fork existing ones -- all from within the chat interface.

3. **Cron Jobs** -- Schedule periodic tasks that create OpenCode sessions and run prompts automatically. Pull Linear issues every morning, generate standup summaries from Jira, or run any recurring workflow. Results are delivered to your preferred channel.

## Architecture

```
[Slack] [Telegram] [WhatsApp]
    \       |        /
     Channel Adapters
           |
     Message Router
      /    |     \
  Session  Memory  Cron
  Manager  System  Scheduler
      \    |     /
     OpenCode SDK
     (agent runtime)
```

OpenCode handles the hard parts: LLM routing, tool execution, session state, file editing, MCP servers. opencode-claw adds the "glue" layer for channels, memory, and scheduling.

## Prerequisites

- [Node.js](https://nodejs.org) >= 20
- [OpenCode](https://opencode.ai) installed and configured (`opencode` binary in `PATH`)
- At least one channel configured (Telegram bot token, Slack app token, or WhatsApp)

## Installation

```bash
# Run directly (no install)
npx opencode-claw

# Or install globally
npm install -g opencode-claw
opencode-claw
```

No git clone needed. The package is published to npm and runs anywhere Node.js is available.

## Quick Start

```bash
# 1. Create a config file in your project directory
npx opencode-claw --init

# 2. Edit opencode-claw.json with your tokens and preferences
#    (see Configuration section below)

# 3. Run
npx opencode-claw
```

`--init` launches an interactive wizard that asks which channels to enable, prompts for bot tokens and allowlists, and writes an `opencode-claw.json` in the current directory. You can also copy the bundled example config directly:

```bash
# After global install
cp $(npm root -g)/opencode-claw/opencode-claw.example.json ./opencode-claw.json

# After npx run (example config also on GitHub)
# https://github.com/jinkoso/opencode-claw/blob/main/opencode-claw.example.json
```

## How It Works

When you run `opencode-claw`, it:

1. Reads `opencode-claw.json` from the current directory (or the path in `OPENCODE_CLAW_CONFIG`)
2. Starts an OpenCode server, **automatically registering the memory plugin** — no changes to `opencode.json` or any OpenCode config required
3. Connects your configured channel adapters (Telegram, Slack, WhatsApp)
4. Routes inbound messages to OpenCode sessions and streams responses back

### Automatic Memory Plugin Registration

The memory plugin is wired automatically. You do **not** need to modify OpenCode's own config files. Internally, opencode-claw resolves the plugin path relative to its own installed location and passes it to the OpenCode SDK:

```
opencode-claw starts
  → resolves plugin path from its own dist/ directory
  → passes plugin: ["file:///...path.../dist/memory/plugin-entry.js"] to createOpencode()
  → OpenCode server starts with the plugin loaded
  → memory_search, memory_store, memory_delete tools available in every session
```

This path resolution uses `import.meta.url` and works correctly whether you installed via `npm install -g`, `npx`, or as a local dependency — no hardcoded paths, no manual setup.

### Session Persistence

opencode-claw maps each channel peer (Telegram username, Slack user ID, phone number) to an OpenCode session ID, persisted in `./data/sessions.json` (relative to the config file). When you restart the service, existing sessions resume automatically.

### Config File Location

The config file is discovered in this order:

1. `OPENCODE_CLAW_CONFIG` environment variable (absolute path to the config file)
2. `./opencode-claw.json` in the current working directory
3. `../opencode-claw.json` in the parent directory

All relative paths inside `opencode-claw.json` (memory directory, session file, outbox, WhatsApp auth) are resolved relative to the **config file's directory**, not the current working directory. This means the service creates consistent data paths regardless of where you invoke it from.

**Data files created by default (relative to config file):**

| Path | Purpose |
|------|---------|
| `./data/memory/` | Memory files (txt backend) |
| `./data/sessions.json` | Session ID persistence |
| `./data/outbox/` | Async delivery queue for cron results |
| `./data/whatsapp/auth/` | WhatsApp multi-device credentials |

## Configuration

All configuration lives in `opencode-claw.json`. Environment variables can be referenced with `${VAR_NAME}` syntax and are expanded at load time.

### OpenCode

```json
{
  "opencode": {
    "port": 0,
    "directory": "/path/to/your/project"
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | number | `0` (random) | Port for the OpenCode server |
| `directory` | string | cwd | Working directory for OpenCode |
| `configPath` | string | — | Path to a custom OpenCode config file |

### Memory

```json
{
  "memory": {
    "backend": "txt",
    "txt": {
      "directory": "./data/memory"
    }
  }
}
```

**Text backend** (`txt`): Stores knowledge in Markdown files organized by category (`general.md`, `project.md`, `experience.md`, `architecture.md`). Supports keyword-based search. Zero external dependencies.

**OpenViking backend** (`openviking`): Connects to a running OpenViking instance for semantic vector search. Falls back to txt backend if OpenViking is unreachable (when `fallback: true`).

```json
{
  "memory": {
    "backend": "openviking",
    "openviking": {
      "url": "http://localhost:8100",
      "fallback": true
    }
  }
}
```

Memory is injected into OpenCode sessions automatically via the memory plugin. The agent can call `memory_search`, `memory_store`, and `memory_delete` tools during any conversation.

### Channels

#### Telegram

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "${TELEGRAM_BOT_TOKEN}",
      "allowlist": ["your_telegram_username"],
      "mode": "polling",
      "rejectionBehavior": "ignore"
    }
  }
}
```

Create a bot via [@BotFather](https://t.me/BotFather) and set the token. The `allowlist` restricts access to specific Telegram usernames. `rejectionBehavior` controls what happens when an unlisted user messages the bot: `"ignore"` silently drops the message, `"reject"` sends a "This assistant is private" reply.

#### Slack

```json
{
  "channels": {
    "slack": {
      "enabled": true,
      "botToken": "${SLACK_BOT_TOKEN}",
      "appToken": "${SLACK_APP_TOKEN}",
      "mode": "socket"
    }
  }
}
```

Requires a Slack app with Socket Mode enabled. The `appToken` is an app-level token (starts with `xapp-`), and `botToken` is the bot user OAuth token (starts with `xoxb-`). Optionally set `mode: "http"` with a `signingSecret` for HTTP-based event delivery.

#### WhatsApp

```json
{
  "channels": {
    "whatsapp": {
      "enabled": true,
      "allowlist": ["5511999887766"],
      "authDir": "./data/whatsapp/auth",
      "debounceMs": 1000
    }
  }
}
```

Uses the [Baileys](https://github.com/WhiskeySockets/Baileys) library for a multi-device WhatsApp Web connection. On first start, a QR code is printed to the terminal for authentication. The `allowlist` uses full phone numbers (with country code, no `+` prefix). `debounceMs` batches rapid messages into a single prompt.

### Cron Jobs

```json
{
  "cron": {
    "enabled": true,
    "defaultTimeoutMs": 300000,
    "jobs": [
      {
        "id": "daily-standup",
        "schedule": "0 9 * * 1-5",
        "description": "Morning standup briefing",
        "prompt": "Check my Linear board for P1 and P2 issues assigned to me. Summarize what needs attention today.",
        "reportTo": {
          "channel": "telegram",
          "peerId": "your_telegram_username"
        },
        "enabled": true,
        "timeoutMs": 300000
      }
    ]
  }
}
```

Jobs use standard [cron expressions](https://crontab.guru/). Each job creates a fresh OpenCode session, sends the `prompt`, waits for completion (with timeout), and optionally delivers the result to a channel via the outbox. Jobs run one at a time to avoid overwhelming the agent.

### Router

```json
{
  "router": {
    "timeoutMs": 300000,
    "progress": {
      "enabled": true,
      "toolThrottleMs": 5000,
      "heartbeatMs": 30000
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `timeoutMs` | number | `300000` (5 min) | Max time to wait for an agent response before timing out |
| `progress.enabled` | boolean | `true` | Forward tool-use notifications and heartbeats to the channel while the agent is working |
| `progress.toolThrottleMs` | number | `5000` | Minimum ms between tool-use progress messages (prevents flooding) |
| `progress.heartbeatMs` | number | `30000` | Interval for "still working…" heartbeat messages during long-running tasks |

When `progress.enabled` is true, the router sends intermediate updates to the channel while the agent is processing — tool call notifications (e.g. "Running: read_file"), todo list updates when the agent calls `TodoWrite`, and periodic heartbeats so you know it hasn't stalled.

### Health Server

```json
{
  "health": {
    "enabled": true,
    "port": 9090
  }
}
```

When enabled, exposes HTTP endpoints for monitoring:

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Overall status (`up`, `degraded`, `down`) + uptime |
| `GET /channels` | Connection status for each channel adapter |
| `GET /memory` | Memory backend status and stats |
| `GET /outbox` | Pending and dead-letter message counts |

### Outbox

```json
{
  "outbox": {
    "directory": "./data/outbox",
    "pollIntervalMs": 500,
    "maxAttempts": 3
  }
}
```

The outbox is a file-based async delivery queue for cron job results. Messages are written as JSON files, a drainer polls the directory and delivers via the appropriate channel adapter. Failed deliveries are retried up to `maxAttempts` times before being moved to a dead-letter directory.

## Chat Commands

These commands are available in any connected channel:

| Command | Description |
|---------|-------------|
| `/new [title]` | Create a new OpenCode session |
| `/switch <id>` | Switch to an existing session |
| `/sessions` | List all your sessions |
| `/current` | Show the active session ID |
| `/fork` | Fork the current session into a new one |
| `/help` | Show available commands |

Any non-command message is routed to the active OpenCode session as a prompt.

## Programmatic API

Use opencode-claw as a library in your own Node.js application:
```typescript
import { main, createMemoryBackend } from "opencode-claw/lib"
await main()
```

### Exports

| Export | Description |
|--------|-------------|
| `main()` | Start the full opencode-claw service |
| `createMemoryBackend(config)` | Create a memory backend (txt or openviking) from config |
| `createOutboxWriter(config)` | Create an outbox writer for queuing messages |
| `createOutboxDrainer(config, channels)` | Create an outbox drainer for delivering queued messages |

### Types

All configuration and domain types are exported for TypeScript consumers:

```typescript
import type {
  Config,
  MemoryConfig,
  MemoryBackend,
  MemoryEntry,
  ChannelAdapter,
  ChannelId,
  InboundMessage,
  OutboundMessage,
} from "opencode-claw/lib"
```

### Standalone Memory Plugin

The memory plugin can be used with a vanilla OpenCode installation (without the rest of opencode-claw). Add the package name to the `plugin` array in your `opencode.json`:

```json
{
  "plugin": ["opencode-claw"]
}
```

OpenCode will install the package automatically on next startup and load the memory plugin.

Or wire it programmatically via the SDK:

```typescript
import { createOpencode } from "@opencode-ai/sdk"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"
const dir = dirname(fileURLToPath(import.meta.url))
const pluginPath = `file://${resolve(dir, "node_modules/opencode-claw/dist/memory/plugin-entry.js")}`
const { client, server } = await createOpencode({
  config: { plugin: [pluginPath] },
})
```

The plugin registers `memory_search`, `memory_store`, and `memory_delete` tools, and injects relevant memories into the system prompt via a chat transform hook. It reads its config from `opencode-claw.json` in the working directory — only the `memory` section is required:

```json
{
  "memory": {
    "backend": "txt",
    "txt": {
      "directory": "./data/memory"
    }
  }
}
```

> **Note**: You do not need the standalone plugin wiring when using `opencode-claw` directly — it is registered automatically on startup.

## Inspiration

- **[OpenClaw](https://github.com/nichochar/openclaw)** -- Channel plugin architecture, session key routing, memory system design.
- **[MonClaw](https://cefboud.com/posts/monclaw-a-light-openclaw-with-opencode-sdk/)** -- Outbox pattern, plugin-based memory injection, wrapping OpenCode SDK.

## License

[MIT](LICENSE)
