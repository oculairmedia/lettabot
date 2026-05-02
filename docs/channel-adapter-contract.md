# Channel Adapter Contract

This document is for anyone consuming lettabot's streaming output:

- **Channel adapter authors** — building a new channel like Matrix, Telegram, Slack, or a custom integration that needs to render the agent's responses in real time.
- **WS gateway consumers** — building a UI client like letta-mobile that subscribes to the WebSocket gateway directly.

If you are an operator configuring an existing channel, you want [Configuration Reference](./configuration.md) instead.

The architecture rationale lives in `docs/architecture/bot-stream-coalescer.md` and `docs/architecture/partial-json-tool-args.md`. This doc covers the **wire contract** you must honor.

---

## 1. The default contract — what most adapters get

By default, every WS connection sees **exactly one `tool_call` frame per call**, with the fully-resolved arguments. You can render it with a naive push:

```ts
case "tool_call":
  messages.push({ kind: "tool", ...frame });
  break;
```

That is the entire tool_call rule for the default path. No dedup, no replace-by-id, no status tracking. Text events are deltas (concatenate as they arrive); tool_result is one per call. Most channel adapters — Matrix, Telegram, Slack, Discord, anything that posts a message per tool invocation — want this and nothing more.

If you want **progressive tool cards** that grow as the LLM streams the JSON arguments (the kind of UX letta-mobile shows on its tool bubbles), you opt in per-connection. See §4. Opting in is also where the dedup-by-`tool_call_id` rule kicks in — that rule is the cost of progressive UX, not a baseline requirement.

---

## 2. Frame types you'll see

The gateway emits stream frames with this top-level shape:

```jsonc
{
  "type": "stream",
  "event": "assistant" | "reasoning" | "tool_call" | "tool_result" | "conversation_swap",
  "content": "...",                    // text events only
  "tool_call_id": "tc-abc",            // tool_call / tool_result only
  "tool_name": "Read",                 // tool_call / tool_result only
  "tool_input": { ... },               // tool_call only — the parsed args object
  "status": "completed",               // tool_call only — see §3 / §4
  "conversation_id": "conv-...",       // every stream frame — see §3.4
  "old_conversation_id": "conv-...",   // conversation_swap only — see §3.5
  "new_conversation_id": "conv-...",   // conversation_swap only — see §3.5
  "uuid": "...",
  "request_id": "req-1"
}
```

Plus terminal frames:

```jsonc
{ "type": "result", "success": true, "conversation_id": "conv-...", "request_id": "req-1", ... }
{ "type": "error",  "code": "STREAM_ERROR", "message": "...", "request_id": "req-1" }
```

A turn always ends with **exactly one** of `result` (success or `aborted: true`) or `error`. Use that to terminate your stream loop.

---

## 3. Default behavior in detail

### Text events (`assistant`, `reasoning`)

Text events are deltas — concatenate the `content` strings in arrival order to reconstruct the full message. The coalescer (when on, which is the default) merges consecutive text deltas into larger frames before they hit the wire, so you'll see fewer-but-bigger chunks. This is invisible to your renderer either way: append-as-you-go works.

### Tool call events (`tool_call`)

By default, you see one `tool_call` frame per call, after the LLM has finished streaming the arguments. `tool_input` is the fully-resolved argument object. Push it to your renderer; you're done.

The frame may carry `status: "completed"` (when `LETTABOT_PARTIAL_JSON_ENABLED=true` server-side, the default) or no `status` field at all (when the server-wide kill switch is off). Either way, it's the final args — there is no follow-up snapshot you need to wait for.

### Tool result events (`tool_result`)

One per tool call, after the agent receives the tool's output. Match it against the open `tool_call` by `tool_call_id`.

### 3.4 Conversation id propagation

Every `stream` frame carries a `conversation_id` field equal to the conversation the chunk belongs to. The terminal `result` frame carries it too. **Use this to detect mid-stream conversation swaps at the very first chunk** rather than only at the terminal frame.

For most adapters that map one connection ⇄ one conversation, this is informational — you can safely ignore it. For adapters that observe a specific conversation's timeline (UI clients with a per-conversation observer), the rule is:

> **If `conversation_id` on an incoming frame doesn't match the conversation you're observing, the gateway has swapped the underlying conversation. Re-anchor before rendering.**

Why this exists: the gateway has an automatic recovery path (`agent-session-manager.ts::_doSendAndStream`) that, on certain failures, opens a fresh conversation under the same connection and retries the same message. Without per-frame `conversation_id` you'd render the retry chunks under the original conversation id and only learn about the swap from the terminal `result` frame — by which point the chunks are already stranded in the wrong timeline.

### 3.5 Conversation swap events

When the gateway recovers by swapping conversations mid-turn, it emits a single explicit signal **before** any retry events:

```jsonc
{
  "type": "stream",
  "event": "conversation_swap",
  "old_conversation_id": "conv-original",
  "new_conversation_id": "conv-recovered",
  "conversation_id": "conv-recovered",
  "request_id": "req-1"
}
```

Adapters that maintain a per-conversation timeline observer should:
1. Move any in-flight optimistic state (e.g. a "sending..." bubble) onto the new conversation's timeline.
2. Switch the observer to `new_conversation_id`.
3. Continue ingesting subsequent stream frames — they will all carry `conversation_id: new_conversation_id`.

Adapters that don't maintain a timeline observer (Matrix, Telegram, Slack, anything channel-side that just forwards chunks to a chat thread) can safely ignore `conversation_swap`. The retry chunks render in the same chat thread regardless of which Letta-side conversation backs them.

Wire-additivity: a client that doesn't know about `conversation_swap` will see the new `conversation_id` value on the very first retry chunk (per §3.4). The `conversation_swap` event is the *cleaner* way to react, but skipping it doesn't break correctness; the per-frame `conversation_id` is the load-bearing signal.

---

## 4. Opt-in: progressive tool_call snapshots

If you want the user to see tool args grow in real time — e.g. `Read /opt/` then `Read /opt/stacks/` then the final path — opt in per-connection by adding a query parameter to the WS URL:

```
wss://your-host/api/v1/agent-gateway?progressive_tool_calls=1
```

When this is set, the gateway will emit a fresh `tool_call` frame each time the streaming JSON parser yields a structurally distinct value, plus a final frame at the end of the call. To render this correctly you must follow one rule:

> **Dedup by `tool_call_id`. The latest snapshot for an id replaces any earlier ones.**

If you treat the snapshots as deltas, you will render N bubbles for one tool call — the most common adapter bug for progressive mode.

### 4.1 The status field

Each progressive `tool_call` frame carries a `status` field:

| Status | Meaning |
|---|---|
| `"running"` | Args still streaming. UI should render in a "loading" / "in progress" state. |
| `"completed"` | Final args, ready to display. |

You can ignore `status` entirely if you don't care about a visual lifecycle (spinner → checkmark) — the snapshot semantics handle the rendering correctly either way (latest replaces earlier).

### 4.2 The snapshot guarantee

A single tool call produces a sequence of frames that all share the same `tool_call_id`:

```
tool_call { tool_call_id: "tc-abc", tool_name: "Read", tool_input: {},                                status: "running" }
tool_call { tool_call_id: "tc-abc", tool_name: "Read", tool_input: { file_path: "/op" },             status: "running" }
tool_call { tool_call_id: "tc-abc", tool_name: "Read", tool_input: { file_path: "/opt/stacks/" },    status: "running" }
tool_call { tool_call_id: "tc-abc", tool_name: "Read", tool_input: { file_path: "/opt/stacks/.." }, status: "completed" }
```

Every snapshot strictly extends or refines the previous one. Newer = more information. Safe to drop older ones for the same id.

### 4.3 A correct progressive renderer (pseudocode)

```ts
// Per-conversation render state.
const messages: Array<{ kind: "text" | "tool"; ... }> = [];
const toolByCallId = new Map<string, ToolMessage>(); // dedup index

for await (const frame of streamFromGateway(requestId)) {
  if (frame.type === "result" || frame.type === "error") {
    // Terminate the stream loop.
    return;
  }
  if (frame.type !== "stream") continue;

  switch (frame.event) {
    case "assistant":
    case "reasoning": {
      // Append-as-you-go.
      const last = messages[messages.length - 1];
      if (last?.kind === "text" && last.role === frame.event) {
        last.text += frame.content;
      } else {
        messages.push({ kind: "text", role: frame.event, text: frame.content });
      }
      break;
    }

    case "tool_call": {
      const id = frame.tool_call_id;
      const existing = toolByCallId.get(id);
      if (existing) {
        // Replace in place — keeps insertion order.
        existing.toolInput = frame.tool_input;
        existing.status = frame.status; // optional
      } else {
        const tool: ToolMessage = {
          kind: "tool",
          toolCallId: id,
          toolName: frame.tool_name,
          toolInput: frame.tool_input,
          status: frame.status,
        };
        toolByCallId.set(id, tool);
        messages.push(tool);
      }
      break;
    }

    case "tool_result": {
      // Attach to the open tool_call.
      const tool = toolByCallId.get(frame.tool_call_id);
      if (tool) {
        tool.result = frame.content;
        tool.isError = frame.is_error;
      }
      break;
    }
  }
}
```

The crucial line is the `tool_call` branch: **the existing entry is mutated in place when an id is seen again, never appended.** That single invariant is the difference between "live tool card grows in real time" and "20 duplicate tool cards stack up".

### 4.4 Common pitfalls (progressive mode only)

#### ❌ Treating `tool_call` as deltas

```ts
// WRONG — produces N bubbles per tool call
case "tool_call":
  messages.push({ kind: "tool", ...frame });
  break;
```

Symptom: a single `Read` call renders as ~5–20 stacked bubbles, each showing a slightly more complete `tool_input`. (This pattern is *correct* in the default contract from §1; it is the bug in progressive mode.)

#### ❌ Concatenating `tool_input` across frames

```ts
// WRONG — tool_input is already the full snapshot, not a diff
existing.toolInput = { ...existing.toolInput, ...frame.tool_input };
```

Symptom: stale keys from earlier snapshots persist when the streaming JSON parser revises its parse on later chunks.

#### ❌ Falling back to `uuid` instead of `tool_call_id` for dedup

```ts
// WRONG — uuid changes per snapshot; tool_call_id is stable
const id = frame.uuid;
```

Symptom: every snapshot creates a new entry — same as treating snapshots as deltas.

#### ❌ Not handling `tool_call_id` collisions across turns

`tool_call_id` is unique within a turn but agents are free to reuse ids across turns. Scope your dedup map to the current `request_id` (or reset it on each `result` frame). The bundled coalescer already does this server-side; your client should too.

---

## 5. Server-side knobs (operator-facing)

These env vars control whether the progressive machinery runs at all on the server. They are independent of the per-connection opt-in:

| Env var | Effect |
|---|---|
| `LETTABOT_PARTIAL_JSON_ENABLED` | Default `true`. When `false`, the gateway never produces progressive snapshots even for opted-in connections — every client falls back to one `tool_call` frame per call with no `status` field. Server-wide kill switch. |
| `LETTABOT_COALESCE_ENABLED` | Default `true`. Runs the per-connection text-delta coalescer; orthogonal to tool_call semantics. |

When the server-wide kill switch is off (`LETTABOT_PARTIAL_JSON_ENABLED=0`), opting in via `?progressive_tool_calls=1` has no effect — there's nothing to opt in to. Adapter code that handles both modes correctly continues to work.

---

## 6. Reference implementations

These adapters honor the contract correctly and are good source material:

- **`src/api/partial-json-snapshot-emitter.ts`** — server-side per-id dedupe with structural-equal early-out. Same shape as a progressive-mode client renderer; just runs upstream of the wire.
- **`src/api/bot-stream-coalescer.ts`** — server-side coalescer. The `handleToolCall` method is essentially the renderer pseudocode in §4.3, in TypeScript.
- **`src/api/ws-gateway.e2e.test.ts`** — wire-level fixtures showing the exact frame sequence a client receives in each (COALESCE × PARTIAL_JSON × PROGRESSIVE) cell. Useful for cross-checking your renderer.
- **letta-mobile** `AdminChatViewModel.kt:1283` (`upsertClientModeLocalAssistantChunk`) — Kotlin/Compose renderer, keys by `localId = "cm-tool-$toolCallId"` with replace semantics. Opts in via the `?progressive_tool_calls=1` query param.

---

## 7. Related architecture docs

- [`docs/architecture/bot-stream-coalescer.md`](./architecture/bot-stream-coalescer.md) — server-side coalescer design rationale.
- [`docs/architecture/partial-json-tool-args.md`](./architecture/partial-json-tool-args.md) — partial-JSON snapshot emitter design.
- [Configuration Reference](./configuration.md#ws-gateway-stream-coalescing) — operator-facing env vars.
