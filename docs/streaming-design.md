# Streaming & Progress Reporting — Technical Design

**Status**: Proposal  
**Date**: 2026-02-22  
**Author**: Engineering  
**Supersedes**: Section 1.5 constraint "Never stream partial replies" in `tech-design.md`

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Goals and Non-Goals](#2-goals-and-non-goals)
3. [Discovery: SDK Capabilities](#3-discovery-sdk-capabilities)
4. [Discovery: Channel Capabilities](#4-discovery-channel-capabilities)
5. [Design Overview](#5-design-overview)
6. [Type Changes](#6-type-changes)
7. [Router Rewrite: Event-Driven Prompting](#7-router-rewrite-event-driven-prompting)
8. [Channel Adapter Changes](#8-channel-adapter-changes)
9. [Cron Scheduler Changes](#9-cron-scheduler-changes)
10. [Configuration](#10-configuration)
11. [Error Handling](#11-error-handling)
12. [Implementation Phases](#12-implementation-phases)
13. [Open Questions](#13-open-questions)

---

## 1. Problem Statement

When a user sends a message through a channel (Telegram, Slack, WhatsApp), the current router calls `client.session.prompt()` — a blocking RPC that waits for the OpenCode agent to finish its entire reasoning + tool-use cycle before returning. This takes 10 seconds to 5 minutes depending on task complexity.

During this time the user sees **nothing**. No typing indicator, no progress signal, no partial output. The only outcomes today are:

1. Full response after N seconds/minutes of silence
2. "Request timed out" after 5 minutes
3. An internal error message

This is a poor experience. Users don't know if the system is working, stuck, or dead.

### Current Flow (Blocking)

```
User sends message
  │
  ├─ allowlist check (instant)
  ├─ parseCommand (instant)
  ├─ resolveSession (~100-500ms, first msg only)
  │
  ├─ await client.session.prompt(...)  ← BLOCKS 10s–300s
  │     (user sees nothing)
  │
  └─ adapter.send(reply)              ← user finally sees response
```

---

## 2. Goals and Non-Goals

### Goals

1. **Typing indicators** — Show platform-native "typing" or "composing" state immediately when processing begins
2. **Tool activity signals** — Notify users when the agent starts using a tool ("🔧 Searching codebase...", "📝 Editing file...")
3. **Streamed final response** — Deliver the agent's text response progressively by editing a placeholder message, rather than waiting for full completion
4. **Graceful degradation** — If a channel doesn't support editing (WhatsApp), fall back to typing indicators + single final message
5. **Cron visibility** — Extend the same mechanism to cron jobs, so job progress can be reported to the delivery channel

### Non-Goals

- Multi-user / concurrent session handling (still single-user)
- Streaming to channels that weren't configured (no new channel types)
- Modifying OpenCode SDK internals
- Real-time audio/video streaming
- Per-word streaming (we stream per text-part update, not per token)

---

## 3. Discovery: SDK Capabilities

Investigation of `@opencode-ai/sdk` revealed two APIs that change the architecture entirely:

### 3.1 `client.session.promptAsync()`

A non-blocking alternative to `prompt()`. Fires the prompt and returns immediately without waiting for completion.

```typescript
// Current (blocking — what we use today)
const result = await client.session.prompt({
  path: { id: sessionId },
  body: { parts: [{ type: "text", text: msg.text }] },
})

// New (non-blocking — returns immediately)
await client.session.promptAsync({
  path: { id: sessionId },
  body: { parts: [{ type: "text", text: msg.text }] },
})
```

### 3.2 `client.event.subscribe()`

Opens an SSE connection that streams typed events as an `AsyncGenerator`:

```typescript
const { stream } = await client.event.subscribe()
for await (const event of stream) {
  // event is a discriminated union on event.type
}
```

### 3.3 Event Types (Relevant Subset)

| Event Type | Payload | Use Case |
|---|---|---|
| `session.status` | `{ sessionID, status: "busy" \| "idle" \| { type: "retry", attempt, next } }` | Know when processing starts/ends |
| `session.idle` | `{ sessionID }` | Terminal signal — agent is done |
| `session.error` | `{ sessionID, error }` | Error handling |
| `message.part.updated` | `{ sessionID, part: Part }` | Text chunks, tool state changes |
| `message.part.delta` | `{ sessionID, messageID, partID, field, delta }` | Incremental text deltas (v2 only) |
| `todo.updated` | `{ sessionID, todos[] }` | Agent's internal task list changed |

### 3.4 Part Types (via `message.part.updated`)

| Part Type | What It Means |
|---|---|
| `TextPart` | Agent's text response — `{ type: "text", text: string }` |
| `ToolPart` | Tool invocation — `{ type: "tool", tool: string, state: pending \| running \| completed \| error }` |
| `ReasoningPart` | Internal reasoning (not shown to users) |
| `StepStartPart` / `StepFinishPart` | Agent execution steps |
| `AgentPart` | Sub-agent delegation |
| `RetryPart` | Provider retry in progress |

The `ToolPart.state` transitions are particularly useful:
```
pending → running (has title, e.g. "Reading file src/index.ts")
        → completed (has output, title)
        → error (has error string)
```

---

## 4. Discovery: Channel Capabilities

| Capability | Telegram | Slack | WhatsApp |
|---|---|---|---|
| **Typing indicator** | `bot.api.sendChatAction(peerId, "typing")` — 5s TTL, must re-send | `app.client.assistant.threads.setStatus(...)` or presence | `sock.sendPresenceUpdate("composing", jid)` |
| **Stop typing** | Expires automatically (5s) | `setStatus({ status: "" })` | `sock.sendPresenceUpdate("paused", jid)` |
| **Edit message** | `bot.api.editMessageText(peerId, msgId, text)` | `app.client.chat.update({ channel, ts, text })` | **Not supported** — protocol limitation |
| **Delete message** | `bot.api.deleteMessage(peerId, msgId)` | `app.client.chat.delete({ channel, ts })` | Delete-for-self only |
| **Reactions** | Bots cannot react | `app.client.reactions.add(...)` | `sock.sendMessage(jid, { react: { text, key } })` |

### Key Constraints

- **Telegram typing** has a 5-second TTL. Must be re-sent in a loop while the agent is working.
- **WhatsApp cannot edit messages**. Our streaming strategy must degrade gracefully: use typing indicators only, then deliver the full response as a single message.
- **Slack** has the richest API: editable messages, reactions, and thread status. It gets the best experience.

---

## 5. Design Overview

### 5.1 New Architecture

```
User sends message
  │
  ├─ allowlist check (instant)
  ├─ parseCommand (instant)
  ├─ resolveSession (~100-500ms)
  │
  ├─ adapter.sendTyping(peerId)            ← IMMEDIATE feedback
  ├─ client.event.subscribe()               ← open SSE stream
  ├─ client.session.promptAsync(...)         ← fire-and-forget
  │
  ├─ for await (event of stream)            ← STREAM events
  │     ├─ tool running  → adapter.sendProgress("🔧 Searching...") 
  │     ├─ text updated  → adapter.editMessage(handle, partialText)
  │     ├─ session.idle  → break
  │     └─ session.error → handle error, break
  │
  └─ adapter.stopTyping(peerId)             ← cleanup
```

### 5.2 Three Feedback Layers

The design provides three layers of feedback, each degrading gracefully per channel:

**Layer 1 — Typing Indicators (all channels)**
Platform-native "composing" signals. Started immediately, maintained on an interval, cleared on completion.

**Layer 2 — Tool Activity Messages (all channels)**
Short progress messages when the agent invokes a tool: "🔧 Reading file src/config.ts". Sent as new messages (not edits) so they work on WhatsApp. Rate-limited to avoid spam.

**Layer 3 — Streamed Text Response (Telegram + Slack only)**
A placeholder message ("⏳ Thinking...") is sent immediately. As `TextPart` updates arrive, the placeholder is edited in-place with the growing response. WhatsApp skips this layer (no message editing) and delivers the full response as a single message at the end.

---

## 6. Type Changes

### 6.1 `src/channels/types.ts`

```typescript
// New: handle returned from send/sendProgress for later editing
export type MessageHandle = {
  id: string       // platform message ID (message_id, ts, key.id)
  peerId: string
  channel: ChannelId
}

// Updated: send() returns a handle instead of void
export type ChannelAdapter = {
  readonly id: ChannelId
  readonly name: string
  start(handler: InboundMessageHandler): Promise<void>
  stop(): Promise<void>
  send(peerId: string, message: OutboundMessage): Promise<MessageHandle>
  status(): ChannelStatus

  // New optional methods — undefined means unsupported
  sendTyping?(peerId: string, threadId?: string): Promise<void>
  stopTyping?(peerId: string, threadId?: string): Promise<void>
  editMessage?(handle: MessageHandle, text: string): Promise<void>
}
```

**Breaking change**: `send()` returns `Promise<MessageHandle>` instead of `Promise<void>`. All existing call sites (router, outbox drainer, command handler) must be updated.

### 6.2 Event Filtering Types

```typescript
// src/channels/router.ts (internal to router module)
type SessionEventFilter = {
  sessionId: string
  onToolRunning: (toolName: string, title?: string) => void
  onTextUpdated: (text: string) => void
  onIdle: () => void
  onError: (error: string) => void
}
```

---

## 7. Router Rewrite: Event-Driven Prompting

### 7.1 Core Loop

The `routeMessage` function in `src/channels/router.ts` is the primary change site. The blocking `await client.session.prompt()` (lines 151–174) is replaced with:

```typescript
async function routeMessage(msg: InboundMessage, deps: RouterDeps): Promise<void> {
  const adapter = deps.adapters.get(msg.channel)
  if (!adapter) return

  // ... allowlist check, command interception (unchanged) ...

  const key = buildSessionKey(msg.channel, msg.peerId, msg.threadId)
  const sessionId = await deps.sessions.resolveSession(key)

  // Layer 1: Immediate typing indicator
  const typingInterval = startTypingLoop(adapter, msg.peerId, msg.threadId)

  // Open SSE event stream
  const { stream } = await deps.client.event.subscribe()

  // Fire prompt (non-blocking)
  await deps.client.session.promptAsync({
    path: { id: sessionId },
    body: { parts: [{ type: "text", text: msg.text }] },
  })

  // Layer 2 + 3: Process events until idle/error
  let placeholderHandle: MessageHandle | undefined
  let lastText = ""
  let lastProgressTime = 0

  try {
    const timeout = createTimeout(deps.timeoutMs)

    for await (const event of stream) {
      if (timeout.expired) {
        await adapter.send(msg.peerId, {
          text: "Request timed out. The agent took too long to respond.",
          replyToId: msg.replyToId,
        })
        break
      }

      // Filter: only events for our session
      if (!isOurSession(event, sessionId)) continue

      if (event.type === "message.part.updated") {
        const part = event.properties.part

        // Tool activity → progress message (rate-limited)
        if (part.type === "tool" && part.state.status === "running") {
          const now = Date.now()
          if (now - lastProgressTime >= deps.progressThrottleMs) {
            lastProgressTime = now
            const label = part.state.title ?? part.tool
            adapter.send(msg.peerId, { text: `🔧 ${label}` }).catch(() => {})
          }
        }

        // Text part → streamed response (edit placeholder)
        if (part.type === "text" && part.text !== lastText) {
          lastText = part.text
          if (adapter.editMessage && placeholderHandle) {
            await adapter.editMessage(placeholderHandle, part.text)
          } else if (!placeholderHandle) {
            // First text: send as new message (becomes placeholder on edit-capable channels)
            placeholderHandle = await adapter.send(msg.peerId, {
              text: part.text,
              replyToId: msg.replyToId,
            })
          }
          // If no editMessage support: do nothing until final
        }
      }

      if (event.type === "session.idle") break
      if (event.type === "session.error") {
        await adapter.send(msg.peerId, { text: "Error: agent encountered an issue." })
        break
      }
    }

    // Final delivery: send full text if we haven't been editing
    // or if channel doesn't support editing (WhatsApp)
    if (lastText && !adapter.editMessage) {
      await adapter.send(msg.peerId, { text: lastText, replyToId: msg.replyToId })
    } else if (lastText && placeholderHandle && adapter.editMessage) {
      // Ensure final state is synced
      await adapter.editMessage(placeholderHandle, lastText)
    } else if (!lastText) {
      await adapter.send(msg.peerId, { text: "(empty response)", replyToId: msg.replyToId })
    }
  } finally {
    clearTypingLoop(typingInterval)
    adapter.stopTyping?.(msg.peerId, msg.threadId).catch(() => {})
  }
}
```

### 7.2 Typing Loop Helper

```typescript
function startTypingLoop(
  adapter: ChannelAdapter,
  peerId: string,
  threadId?: string,
): ReturnType<typeof setInterval> | undefined {
  if (!adapter.sendTyping) return undefined
  // Send immediately, then every 4s (Telegram's indicator lasts 5s)
  adapter.sendTyping(peerId, threadId).catch(() => {})
  return setInterval(() => {
    adapter.sendTyping!(peerId, threadId).catch(() => {})
  }, 4_000)
}

function clearTypingLoop(interval: ReturnType<typeof setInterval> | undefined): void {
  if (interval) clearInterval(interval)
}
```

### 7.3 Session Event Filtering

Events from `client.event.subscribe()` are global — they include events from all sessions. The router must filter to only the relevant session:

```typescript
function isOurSession(event: Event, sessionId: string): boolean {
  if ("properties" in event && "sessionID" in event.properties) {
    return event.properties.sessionID === sessionId
  }
  return false
}
```

### 7.4 Timeout Handling

The current `AbortController + setTimeout` pattern doesn't apply to `for await`. Replace with a simple deadline check:

```typescript
function createTimeout(ms: number) {
  const deadline = Date.now() + ms
  return { get expired() { return Date.now() >= deadline } }
}
```

The stream itself is broken by returning from the loop. The SSE connection's cleanup is handled by the generator's `return()` method (called implicitly when the `for await` exits).

---

## 8. Channel Adapter Changes

### 8.1 Telegram (`src/channels/telegram.ts`)

```typescript
// send() — updated return type
async send(peerId: string, message: OutboundMessage): Promise<MessageHandle> {
  const result = await bot.api.sendMessage(Number(peerId), message.text, {
    reply_parameters: message.replyToId
      ? { message_id: Number(message.replyToId) }
      : undefined,
  })
  return { id: String(result.message_id), peerId, channel: "telegram" }
},

// sendTyping() — new
async sendTyping(peerId: string): Promise<void> {
  await bot.api.sendChatAction(Number(peerId), "typing")
},

// stopTyping() — Telegram auto-expires after 5s, explicit stop not needed
// (omit method — undefined means "auto")

// editMessage() — new
async editMessage(handle: MessageHandle, text: string): Promise<void> {
  await bot.api.editMessageText(Number(handle.peerId), Number(handle.id), text)
},
```

### 8.2 Slack (`src/channels/slack.ts`)

```typescript
// send() — updated return type
async send(peerId: string, message: OutboundMessage): Promise<MessageHandle> {
  const result = await app.client.chat.postMessage({
    channel: peerId,
    text: message.text,
    thread_ts: message.threadId,
  })
  return { id: result.ts ?? "", peerId, channel: "slack" }
},

// sendTyping() — uses Slack's typing indicator
async sendTyping(peerId: string, threadId?: string): Promise<void> {
  // If using assistant threads API:
  // await app.client.assistant.threads.setStatus({ channel_id: peerId, thread_ts: threadId, status: "is thinking..." })
  // Fallback: Slack doesn't have a general typing indicator for bots.
  // We rely on the placeholder message ("⏳ Thinking...") as a visual signal.
},

// editMessage() — new
async editMessage(handle: MessageHandle, text: string): Promise<void> {
  await app.client.chat.update({
    channel: handle.peerId,
    ts: handle.id,
    text,
  })
},
```

### 8.3 WhatsApp (`src/channels/whatsapp.ts`)

```typescript
// send() — updated return type
async send(peerId: string, message: OutboundMessage): Promise<MessageHandle> {
  const jid = `${peerId}@s.whatsapp.net`
  const result = await sock.sendMessage(jid, { text: message.text })
  return { id: result?.key?.id ?? "", peerId, channel: "whatsapp" }
},

// sendTyping() — new
async sendTyping(peerId: string): Promise<void> {
  const jid = `${peerId}@s.whatsapp.net`
  await sock.sendPresenceUpdate("composing", jid)
},

// stopTyping() — new
async stopTyping(peerId: string): Promise<void> {
  const jid = `${peerId}@s.whatsapp.net`
  await sock.sendPresenceUpdate("paused", jid)
},

// editMessage — NOT implemented (WhatsApp protocol limitation)
// Omitting the method signals the router to use send-once strategy
```

---

## 9. Cron Scheduler Changes

The cron scheduler (`src/cron/scheduler.ts`) has the same blocking `await client.session.prompt()` pattern. It benefits from the same streaming approach but with simpler requirements:

- **No typing indicators** (cron jobs don't have an active chat to type in)
- **No streamed editing** (results are enqueued to outbox, delivered once)
- **Progress logging** (log tool usage for observability, but don't message the user mid-job)

### Change: Replace `prompt()` with `promptAsync()` + event loop

```typescript
// Instead of:
result = await deps.client.session.prompt({ ... })

// Use:
const { stream } = await deps.client.event.subscribe()
await deps.client.session.promptAsync({ ... })

let responseText = ""
for await (const event of stream) {
  if (timeout.expired) break
  if (!isOurSession(event, sessionId)) continue

  if (event.type === "message.part.updated" && event.properties.part.type === "text") {
    responseText = event.properties.part.text
  }
  if (event.type === "session.idle") break
  if (event.type === "session.error") break
}

// Then enqueue responseText to outbox (same as today)
```

This gives cron jobs the same timeout safety without the `AbortController` workaround, and opens the door for future progress reporting to channels.

---

## 10. Configuration

### 10.1 New Config Schema (`src/config/schema.ts`)

```typescript
// Add to routerSchema:
router: z.object({
  timeoutMs: z.number().int().min(1000).default(300_000),
  streaming: z.object({
    enabled: z.boolean().default(true),
    showToolActivity: z.boolean().default(true),
    toolActivityThrottleMs: z.number().int().min(1000).default(5_000),
    editPlaceholder: z.boolean().default(true),
  }).default({}),
}).default({}),
```

| Field | Type | Default | Description |
|---|---|---|---|
| `streaming.enabled` | boolean | `true` | Master switch for event-driven prompting. When `false`, falls back to blocking `prompt()`. |
| `streaming.showToolActivity` | boolean | `true` | Send progress messages when agent uses tools |
| `streaming.toolActivityThrottleMs` | number | `5000` | Min ms between tool activity messages (prevent spam) |
| `streaming.editPlaceholder` | boolean | `true` | Edit placeholder message with streamed text (on supported channels) |

### 10.2 Fallback Mode

When `streaming.enabled: false`, the router uses the current blocking `client.session.prompt()` path. This is a safety valve for:
- SDK version incompatibility (if `promptAsync`/`event.subscribe` aren't available)
- Debugging (simpler to reason about)
- Users who prefer the current behavior

---

## 11. Error Handling

### 11.1 SSE Stream Errors

The SDK's SSE client supports `onSseError` and automatic retries (`sseDefaultRetryDelay: 3000ms`, `sseMaxRetryAttempts`). If the stream disconnects:

1. The SDK retries automatically (up to `sseMaxRetryAttempts`)
2. If retries exhaust, the `for await` exits normally
3. The router checks `lastText`: if non-empty, deliver what we have; if empty, send a timeout/error message

### 11.2 `promptAsync` Failures

If `promptAsync` itself fails (network error, invalid session), it throws immediately before the event loop starts. Catch it and report to the user — same as the current `prompt()` error path.

### 11.3 Event Stream Filtering Misses

If `session.idle` never arrives (agent process crash), the timeout deadline catches it. The stream loop exits, partial text (if any) is delivered, and the user gets a timeout message if no text was received.

### 11.4 Race: Events Arrive Before Stream Opens

There's a small window between `event.subscribe()` and `promptAsync()` where we might miss early events. Mitigation: subscribe **before** firing the prompt. The SSE connection buffers events, so as long as we subscribe first, no events are lost.

---

## 12. Implementation Phases

### Phase 1: Type Changes + Typing Indicators
**Effort**: Small  
**Risk**: Low

1. Add `MessageHandle` type to `types.ts`
2. Change `send()` return type to `Promise<MessageHandle>` across all adapters
3. Update all `send()` call sites (router, outbox drainer, command handler) to handle the return value
4. Add `sendTyping()` and `stopTyping()` to each adapter
5. Add typing loop to router (before the existing `prompt()` call) — no streaming yet
6. Test: verify typing indicators appear on each channel

**Deliverable**: Users see typing indicators while the agent thinks. No other behavior change.

### Phase 2: Event-Driven Prompting
**Effort**: Medium  
**Risk**: Medium (new async pattern)

1. Add `streaming` section to config schema
2. Replace `prompt()` with `promptAsync()` + `event.subscribe()` in router
3. Implement session event filtering
4. Implement timeout via deadline check
5. Add tool activity messages (rate-limited)
6. When `streaming.enabled: false`, preserve the old blocking path
7. Test: verify agent responses still arrive correctly; verify tool activity messages

**Deliverable**: Users see tool activity messages. Response delivery still happens once at the end (no editing yet).

### Phase 3: Streamed Text via Message Editing
**Effort**: Small  
**Risk**: Low (editing is additive)

1. Add `editMessage()` to Telegram and Slack adapters
2. Router sends first text chunk as a new message, subsequent chunks edit it
3. WhatsApp: no `editMessage`, router sends full text once at the end (graceful degradation)
4. Test: verify progressive text updates on Telegram and Slack

**Deliverable**: Full streaming experience. Users see text appear progressively on Telegram and Slack.

### Phase 4: Cron Scheduler Update
**Effort**: Small  
**Risk**: Low

1. Replace `prompt()` with `promptAsync()` + event loop in scheduler
2. Log tool activity for observability
3. Remove `AbortController` timeout in favor of deadline check
4. Test: verify cron jobs still complete and deliver results

**Deliverable**: Cron jobs use the same event-driven pattern. Consistent architecture.

---

## 13. Open Questions

1. **v1 vs v2 SDK API**: The v2 API adds `message.part.delta` for incremental text streaming. Should we target v2 from the start, or build on v1 and upgrade later? (v2 is at `@opencode-ai/sdk/v2`)

2. **Slack typing indicator**: Slack's `assistant.threads.setStatus` requires the bot to be configured as a Slack Assistant. If the bot is a regular Slack app, there's no general typing indicator API. Should we document this as a requirement, or skip Slack typing entirely?

3. **Tool activity message cleanup**: Should we delete tool activity messages after the final response is delivered (to avoid clutter)? Telegram and Slack support deletion. WhatsApp does not.

4. **SSE connection lifecycle**: Should we maintain a single long-lived SSE connection shared across all prompts, or open/close one per `routeMessage` call? Single connection is more efficient but adds session-filtering complexity.

5. **Rate limiting edits**: Telegram and Slack have rate limits on `editMessage`. How aggressively should we edit? Options:
   - Every `message.part.updated` (could hit rate limits on fast agents)
   - Throttled to once per N seconds (adds latency but is safe)
   - On `StepFinishPart` boundaries only (natural breakpoints)

6. **Partial text on timeout**: If the agent times out mid-response, should we deliver partial text? Current design says yes (deliver `lastText` if non-empty). But partial text might be mid-sentence or misleading.