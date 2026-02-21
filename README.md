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

## Inspiration

- **[OpenClaw](https://github.com/nichochar/openclaw)** -- The channel plugin architecture, session key routing scheme, and memory system design are directly inspired by OpenClaw's battle-tested patterns.
- **[MonClaw](https://cefboud.com/posts/monclaw-a-light-openclaw-with-opencode-sdk/)** -- The outbox pattern for message delivery, the plugin-based memory injection, and the practical approach to wrapping OpenCode SDK come from this reference architecture.

## Project Status

**Design phase.** The `docs/` directory contains:

- [`docs/investigation-report.md`](docs/investigation-report.md) -- Deep-dive research into OpenCode, OpenClaw, OpenViking, and MonClaw architectures
- [`docs/tech-design.md`](docs/tech-design.md) -- Technical design proposal covering all three subsystems, interfaces, configuration, project structure, and implementation phases

No implementation code exists yet.

## Tech Stack (Planned)

- **Runtime**: Bun (matching OpenCode)
- **Language**: TypeScript (ESM, strict typing)
- **Agent Runtime**: `@opencode-ai/sdk`
- **Channels**: `grammy` (Telegram), `@slack/bolt` (Slack), `@whiskeysockets/baileys` (WhatsApp)
- **Memory**: Markdown files (default) or OpenViking (advanced)
- **Config**: Zod-validated JSON (`opencode-claw.json`)

## License

TBD
