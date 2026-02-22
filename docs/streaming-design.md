# Streaming & Progress Reporting — Technical Design

**Status**: Implemented  
**Date**: 2026-02-22  
**Author**: Engineering  
**Commit**: `ed382e6`  
**Supersedes**: Section 1.5 constraint "Never stream partial replies" in `tech-design.md`

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Goals and Non-Goals](#2-goals-and-non-goals)
3. [Discovery: SDK Capabilities](#3-discovery-sdk-capabilities)
4. [Discovery: Channel Capabilities](#4-discovery-channel-capabilities)
5. [Design Overview](#5-design-overview)
6. [Type Changes](#6-type-changes)
7. [New Module: `src/sessions/prompt.ts`](#7-new-module-srcsessionspromptts)
8. [Router Rewrite: `src/channels/router.ts`](#8-router-rewrite-srcchannelsrouterts)
9. [Channel Adapter Changes](#9-channel-adapter-changes)
10. [Configuration](#10-configuration)
11. [Error Handling](#11-error-handling)

---

## 1. Problem Statement

When a user sends a message through a channel (Telegram, Slack, WhatsApp), the original router called `client.session.prompt()` — a blocking RPC that waited for the OpenCode agent to finish its entire reasoning + tool-use cycle before returning. This takes 10 seconds to 5 minutes depending on task complexity.

During this time the user saw **nothing**. No typing indicator, no progress signal, no partial output. The only outcomes were:

1. Full response after N seconds/minutes of silence
2. "Request timed out" after 5 minutes
3. An internal error message

This is a poor experience. Users don't know if the system is working, stuck, or dead.

### Previous Flow (Blocking)

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
2. **Tool activity signals** — Notify users when the agent starts using a tool ("🔧 Searching codebase...", "🔧 Editing file...")
3. **Heartbeat** — Send a "still working" message after extended silence, so users know the agent hasn't stalled
4. **Question forwarding** — When the agent asks a clarifying question, send it to the user and wait for their reply before continuing
5. **Graceful degradation** — If a channel doesn't support a given capability (e.g. Slack has no bot typing API), silently skip it

### Non-Goals

- Multi-user / concurrent session handling (still single-user)
- Streaming or editing partial text responses (response is always a single complete message)
- Streaming to channels that weren't configured (no new channel types)
- Modifying OpenCode SDK internals
- Real-time audio/video streaming

---

## 3. Discovery: SDK Capabilities

Investigation of `@opencode-ai/sdk` revealed APIs that change the architecture entirely. All files now import from `@opencode-ai/sdk/v2`.

### 3.1 `client.session.promptAsync()`

A non-blocking alternative to `prompt()`. Fires the prompt and returns immediately without waiting for completion.

```typescript
// Previous (blocking)
const result = await client.session.prompt({
  path: { id: sessionId },
  body: { parts: [{ type: "text", text: msg.text }] },
})

// Current (non-blocking — returns immediately)
await client.session.promptAsync({
  sessionID: sessionId,
  parts: [{ type: "text", text: promptText }],
})
```

Note the v2 API shape: flat body fields, `sessionID` instead of `path: { id }`.

### 3.2 `client.event.subscribe()`

Opens an SSE connection that streams typed events as an `AsyncGenerator`:

```typescript
const { stream } = await client.event.subscribe()
for await (const raw of stream) {
  const event = raw as Event
  // event is a discriminated union on event.type
}
```

The stream must be explicitly closed after use: `await stream.return(undefined)`.

### 3.3 Event Types (Relevant Subset)

| Event Type | Payload | Use Case |
|---|---|---|
| `session.idle` | `{ sessionID }` | Terminal signal — agent is done |
| `session.error` | `{ sessionID, error }` | Error handling |
| `message.part.updated` | `{ part: Part }` | Tool state changes, text accumulation |
| `message.part.delta` | `{ sessionID, partID, delta }` | Incremental text deltas (v2) |
| `question.asked` | `QuestionRequest` | Agent needs a user answer before continuing |

### 3.4 Part Types (via `message.part.updated`)

| Part Type | What It Means |
|---|---|
| `TextPart` | Agent's text response — `{ type: "text", text: string, id: string }` |
| `ToolPart` | Tool invocation — `{ type: "tool", tool: string, callID: string, state: { status, title? } }` |

The `ToolPart.state.status` transitions are:
```
pending → running (has title, e.g. "Reading file src/index.ts")
        → completed
        → error
```

### 3.5 `client.question.reply()` and `client.question.reject()`

When a `question.asked` event arrives, the agent is paused waiting for an answer. Reply with:

```typescript
await client.question.reply({
  requestID: request.id,
  answers,   // Array<Array<string>> — one array per question
})

// Or reject (agent will continue without the answer):
await client.question.reject({ requestID: request.id })
```

---

## 4. Discovery: Channel Capabilities

| Capability | Telegram | Slack | WhatsApp |
|---|---|---|---|
| **Typing indicator** | `bot.api.sendChatAction(peerId, "typing")` — 5s TTL, must re-send | No bot typing API | `sock.sendPresenceUpdate("composing", jid)` |
| **Stop typing** | Expires automatically (5s) | N/A | `sock.sendPresenceUpdate("paused", jid)` |
| **Edit message** | Supported | Supported | **Not supported** — protocol limitation |

### Key Constraints

- **Telegram typing** has a 5-second TTL. The router re-sends it on the heartbeat callback to keep it alive during long operations.
- **Slack** has no general bot typing API. `sendTyping` is a no-op (method not implemented on the adapter, treated as unsupported). The heartbeat message ("⏳ Still working...") serves as the only progress signal.
- **WhatsApp** supports `composing`/`paused` presence updates via Baileys, but cannot edit messages.

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
  ├─ promptStreaming(client, sessionId, ...)
  │     ├─ client.event.subscribe()        ← open SSE stream
  │     ├─ client.session.promptAsync(...) ← fire-and-forget
  │     │
  │     └─ for await (event of stream)
  │           ├─ tool running  → onToolRunning() → "🔧 {title}..."
  │           ├─ question.asked → onQuestion() → send to user, wait for reply
  │           ├─ heartbeat timer → onHeartbeat() → "⏳ Still working..."
  │           ├─ session.idle  → break, return accumulated text
  │           └─ session.error → throw
  │
  ├─ adapter.send(reply)                   ← single complete message
  └─ adapter.stopTyping(peerId)            ← cleanup
```

### 5.2 Three Progress Mechanisms

**Typing indicators**
Platform-native "composing" signals. Sent immediately when processing starts, refreshed on heartbeat, cleared on completion. Slack has no equivalent and skips this silently.

**Tool activity messages**
Short progress messages when the agent invokes a tool: "🔧 Reading file src/config.ts...". Sent as new messages (works on all channels). Rate-limited to max one per `toolThrottleMs` (default 5 seconds). Each unique `callID` is only notified once, so a tool that updates its state multiple times doesn't spam.

**Heartbeat**
After `heartbeatMs` of silence (default 60 seconds), sends "⏳ Still working..." and re-sends the typing indicator. Resets every time tool activity is reported.

### 5.3 Question Forwarding

When the agent asks a clarifying question (`question.asked` event), the router:

1. Formats the question with options and sends it to the user
2. Suspends `promptStreaming` while waiting for the user's next message
3. The router's `pendingQuestions` map resolves the waiting promise when the next inbound message arrives
4. The answer is forwarded to `client.question.reply()`
5. If the user doesn't respond within `timeoutMs`, the question is rejected and the agent continues

The final response is always delivered as a single complete message after `session.idle`.

---

## 6. Type Changes

### 6.1 `src/channels/types.ts`

`send()` remains `Promise<void>` — no `MessageHandle` needed since we never edit messages.

Two optional methods were added to `ChannelAdapter`:

```typescript
export type ChannelAdapter = {
  readonly id: ChannelId
  readonly name: string
  start(handler: InboundMessageHandler): Promise<void>
  stop(): Promise<void>
  send(peerId: string, message: OutboundMessage): Promise<void>
  status(): ChannelStatus

  // Optional — undefined means unsupported on this channel
  sendTyping?(peerId: string): Promise<void>
  stopTyping?(peerId: string): Promise<void>
}
```

The router checks for presence before calling: `if (adapter.sendTyping) { ... }`.

---

## 7. New Module: `src/sessions/prompt.ts`

All event-loop logic is extracted into a single reusable function, keeping the router thin.

### 7.1 Types

```typescript
export type ToolProgressCallback = (tool: string, title: string) => Promise<void>
export type HeartbeatCallback = () => Promise<void>
export type QuestionCallback = (question: QuestionRequest) => Promise<Array<Array<string>>>

export type ProgressOptions = {
  onToolRunning?: ToolProgressCallback
  onHeartbeat?: HeartbeatCallback
  onQuestion?: QuestionCallback
  toolThrottleMs?: number
  heartbeatMs?: number
}
```

### 7.2 `promptStreaming()`

```typescript
export async function promptStreaming(
  client: OpencodeClient,
  sessionId: string,
  promptText: string,
  timeoutMs: number,
  logger: Logger,
  progress?: ProgressOptions,
): Promise<string>
```

Returns the full agent response text as a single string. The caller sends it as one message.

**Internals:**

- Opens `client.event.subscribe()` **before** firing `promptAsync`, so no events are missed
- Accumulates `TextPart` text via `message.part.delta` (incremental deltas) and `message.part.updated` (full snapshots). Multiple text parts are joined in order
- Tool notifications: checks `!notifiedTools.has(part.callID)` to deduplicate, then checks `now - lastToolNotifyTime >= toolThrottleMs` for rate limiting
- Heartbeat: a `setInterval` fires every `heartbeatMs`. It checks elapsed time since last activity — if over the threshold, calls `onHeartbeat()` and resets the clock
- Question handling: calls `onQuestion(request)` and `await`s the result before calling `client.question.reply()`. On any error, calls `client.question.reject()`
- Timeout: `AbortController` + `setTimeout(abort, timeoutMs)`. Checked on each event loop iteration
- Cleanup in `finally`: clears timeout, clears heartbeat interval, calls `stream.return(undefined)`

### 7.3 Event Filtering

All events are global across all sessions. Every handler checks `sessionID` before processing:

```typescript
if (part.sessionID !== sessionId) continue
if (event.properties.sessionID !== sessionId) continue
```

---

## 8. Router Rewrite: `src/channels/router.ts`

### 8.1 Active Streams and Pending Questions

The router maintains two module-level maps:

```typescript
// sessionId currently streaming for each channel:peerId pair
const activeStreams = new Map<string, string>()

// pending question resolvers — user's next message resolves the promise
const pendingQuestions = new Map<string, QuestionResolver>()
```

`peerKey(channel, peerId)` returns `"telegram:12345"` etc. as the map key.

### 8.2 Inbound Message Routing

Before routing any message to the agent, the handler checks `pendingQuestions`:

```typescript
const pk = peerKey(msg.channel, msg.peerId)
const pending = pendingQuestions.get(pk)
if (pending) {
  clearTimeout(pending.timeout)
  pendingQuestions.delete(pk)
  pending.resolve(msg.text)
  return   // this message was an answer, not a new prompt
}
```

This intercepts the user's reply to an agent question before it reaches `routeMessage`.

### 8.3 Core Prompt Flow

```typescript
// 1. Typing indicator — immediate feedback
if (adapter.sendTyping) {
  await adapter.sendTyping(msg.peerId).catch(() => {})
}

// 2. Build progress options (if enabled)
const progress: ProgressOptions | undefined = progressEnabled ? {
  onToolRunning: (_tool, title) =>
    adapter.send(msg.peerId, { text: `🔧 ${title}...` }),
  onHeartbeat: async () => {
    if (adapter.sendTyping) await adapter.sendTyping(msg.peerId).catch(() => {})
    await adapter.send(msg.peerId, { text: "⏳ Still working..." })
  },
  onQuestion: async (request) => {
    await adapter.send(msg.peerId, { text: formatQuestion(request) })
    const userReply = await waitForUserReply(deps.timeoutMs)
    return request.questions.map(() => [userReply])
  },
  toolThrottleMs: deps.config.router.progress.toolThrottleMs,
  heartbeatMs: deps.config.router.progress.heartbeatMs,
} : undefined

// 3. Run
const reply = await promptStreaming(deps.client, sessionId, msg.text, deps.timeoutMs, deps.logger, progress)

// 4. Deliver complete response
await adapter.send(msg.peerId, { text: reply, replyToId: msg.replyToId })
```

Cleanup runs in `finally`: removes from `activeStreams`, removes from `pendingQuestions`, calls `adapter.stopTyping`.

### 8.4 Question Formatting

```typescript
function formatQuestion(request: QuestionRequest): string {
  const lines: string[] = ["❓ The agent has a question:"]
  for (const q of request.questions) {
    lines.push("")
    if (q.header) lines.push(`**${q.header}**`)
    lines.push(q.question)
    if (q.options && q.options.length > 0) {
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i]
        if (opt) {
          lines.push(`  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}`)
        }
      }
    }
    if (q.multiple) lines.push("(You can pick multiple — separate with commas)")
  }
  lines.push("")
  lines.push("Reply with your answer:")
  return lines.join("\n")
}
```

### 8.5 `/cancel` Command

`/cancel` calls `client.session.abort({ sessionID })` using the session ID from `activeStreams`. If the agent was mid-stream, `promptStreaming` throws `"aborted"` (from `MessageAbortedError` in `session.error`). The router catches this and returns silently — the `/cancel` command reply was already sent.

---

## 9. Channel Adapter Changes

### 9.1 Telegram (`src/channels/telegram.ts`)

`sendTyping` sends `sendChatAction("typing")`. The 5-second TTL is refreshed by the heartbeat callback in the router. No `stopTyping` is needed — the indicator expires on its own.

```typescript
async sendTyping(peerId: string): Promise<void> {
  await bot.api.sendChatAction(Number(peerId), "typing")
},
```

`send()` remains `Promise<void>`.

### 9.2 Slack (`src/channels/slack.ts`)

No `sendTyping` or `stopTyping` methods. Slack has no bot typing API for regular apps. Progress is communicated via tool activity messages and the heartbeat message only.

### 9.3 WhatsApp (`src/channels/whatsapp.ts`)

Both `sendTyping` and `stopTyping` are implemented using Baileys presence updates:

```typescript
async sendTyping(peerId: string): Promise<void> {
  if (!sock) return
  const jid = `${peerId}@s.whatsapp.net`
  await sock.sendPresenceUpdate("composing", jid)
},

async stopTyping(peerId: string): Promise<void> {
  if (!sock) return
  const jid = `${peerId}@s.whatsapp.net`
  await sock.sendPresenceUpdate("paused", jid)
},
```

`stopTyping` is called in the router's `finally` block after the response is delivered.

---

## 10. Configuration

### 10.1 Schema (`src/config/schema.ts`)

```typescript
router: z.object({
  timeoutMs: z.number().int().min(1000).default(300_000),
  progress: z.object({
    enabled: z.boolean().default(true),
    toolThrottleMs: z.number().int().min(1000).default(5_000),
    heartbeatMs: z.number().int().min(10_000).default(60_000),
  }).default({}),
}).default({}),
```

### 10.2 Config Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `router.progress.enabled` | boolean | `true` | Master switch. When `false`, `promptStreaming` is called without progress options — no tool messages, no heartbeat, no question forwarding. |
| `router.progress.toolThrottleMs` | number | `5000` | Min milliseconds between tool activity messages. Prevents spam on agents that use many tools quickly. |
| `router.progress.heartbeatMs` | number | `60000` | Milliseconds of silence before sending "⏳ Still working..." and refreshing the typing indicator. |

### 10.3 Example Config

```json
{
  "router": {
    "timeoutMs": 300000,
    "progress": {
      "enabled": true,
      "toolThrottleMs": 5000,
      "heartbeatMs": 60000
    }
  }
}
```

---

## 11. Error Handling

### 11.1 Timeout

`promptStreaming` uses `AbortController` + `setTimeout`. On abort, it throws `new Error("timeout")`. The router catches this and sends "Request timed out. The agent took too long to respond."

### 11.2 `session.error`

`MessageAbortedError` (from `/cancel`) throws `"aborted"` — router catches and returns silently. Other errors throw the error message string — router re-throws, the outer catch sends a generic error message.

### 11.3 SSE Stream Disconnect

If the stream exits without `session.idle` (agent crash, network drop), the `for await` loop ends naturally. `promptStreaming` returns whatever text was accumulated. If empty, the router sends `"(empty response)"`.

### 11.4 Question Timeout

If the user doesn't reply to an agent question within `timeoutMs`, `waitForUserReply` rejects with `"question_timeout"`. `promptStreaming` catches this and calls `client.question.reject()`, allowing the agent to continue or fail on its own.

### 11.5 Race: Events Before Stream Opens

`client.event.subscribe()` is called **before** `client.session.promptAsync()`. This ensures no events are emitted before the stream is listening.
