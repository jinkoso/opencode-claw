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

- [Bun](https://bun.sh) >= 1.1
- [OpenCode](https://opencode.ai) installed and configured (`opencode` binary in `PATH`)
- At least one channel configured (Telegram bot token, Slack app token, or WhatsApp)

## Quick Start

```bash
# Clone and install
git clone <repo-url> opencode-claw
cd opencode-claw
bun install

# Copy example config and edit
cp opencode-claw.example.json opencode-claw.json
# Edit opencode-claw.json with your tokens and preferences

# Run
bun start
```

## Configuration

All configuration lives in `opencode-claw.json` at the project root. Environment variables can be referenced with `${VAR_NAME}` syntax and will be expanded at load time.

See [`opencode-claw.example.json`](opencode-claw.example.json) for a fully annotated example.

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

Memory is injected into OpenCode sessions via a plugin. The agent can call `memory_search`, `memory_store`, and `memory_delete` tools during any conversation.

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
    "timeoutMs": 300000
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `timeoutMs` | number | `300000` (5 min) | Max time to wait for an agent response before timing out |

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

## Project Structure

```
src/
  index.ts              Entry point — wires all subsystems
  config/
    schema.ts           Zod config schema
    types.ts            TypeScript types derived from schema
    loader.ts           Config loader with env var expansion
  channels/
    types.ts            ChannelAdapter interface
    router.ts           Message router + command handler
    telegram.ts         Telegram adapter (grammy)
    slack.ts            Slack adapter (@slack/bolt)
    whatsapp.ts         WhatsApp adapter (baileys)
  memory/
    types.ts            MemoryBackend interface
    txt.ts              Text file memory backend
    openviking.ts       OpenViking HTTP backend
    factory.ts          Backend factory
    plugin.ts           OpenCode plugin for memory tools
    plugin-entry.ts     Plugin entry file loaded by OpenCode
  sessions/
    manager.ts          Session routing + lifecycle
    persistence.ts      Session map file persistence
  cron/
    scheduler.ts        Cron job scheduler (node-cron)
  outbox/
    writer.ts           File-based message queue writer
    drainer.ts          Queue drainer + dead-letter handling
  health/
    server.ts           HTTP health check server
  utils/
    logger.ts           Structured logger
    shutdown.ts         Graceful shutdown handler
    reconnect.ts        Exponential backoff reconnection
```

## Inspiration

- **[OpenClaw](https://github.com/nichochar/openclaw)** -- Channel plugin architecture, session key routing, memory system design.
- **[MonClaw](https://cefboud.com/posts/monclaw-a-light-openclaw-with-opencode-sdk/)** -- Outbox pattern, plugin-based memory injection, wrapping OpenCode SDK.

## Design Docs

- [`docs/investigation-report.md`](docs/investigation-report.md) -- Research synthesis of OpenCode, OpenClaw, OpenViking, and MonClaw.
- [`docs/tech-design.md`](docs/tech-design.md) -- Full technical design: interfaces, types, config schema, project structure, implementation phases.

## License

[MIT](LICENSE)
