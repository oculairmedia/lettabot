# Channel Adapter Contract

This document is for anyone consuming lettabot's streaming output:

- **Channel adapter authors** — building a new channel like Matrix, Telegram, Slack, or a custom integration that needs to render the agent's responses in real time.
- **WS gateway consumers** — building a UI client like letta-mobile that subscribes to the WebSocket gateway directly.

If you are an operator configuring an existing channel, you want [Configuration Reference](./configuration.md) instead.

The architecture rationale lives in `docs/architecture/bot-stream-coalescer.md` and `docs/architecture/partial-json-tool-args.md`. This doc covers the **wire contract** you must honor.

---

## 1. The single rule

> **`tool_call` frames are *snapshots*, not deltas. Dedup by `tool_call_id` — the latest snapshot for an id replaces any earlier ones.**

If you treat them as deltas, you will render N bubbles for one tool call. This is the most common adapter bug; the rest of this doc explains why and shows how to render correctly.

---

## 2. Frame types you'll see

The gateway emits stream frames with this top-level shape:

```jsonc
{
  "type": "stream",
  "event": "assistant" | "reasoning" | "tool_call" | "tool_result",
  "content": "...",          // text events only
  "tool_call_id": "tc-abc",  // tool_call / tool_result only
  "tool_name": "Read",       // tool_call / tool_result only
  "tool_input": { ... },     // tool_call only — the parsed args object
  "status": "running" | "completed", // tool_call only — see §4
  "uuid": "...",
  "request_id": "req-1"
}
```

Plus terminal frames:

```jsonc
{ "type": "result", "success": true, "request_id": "req-1", ... }
{ "type": "error",  "code": "STREAM_ERROR", "message": "...", "request_id": "req-1" }
```

A turn always ends with **exactly one** of `result` (success or `aborted: true`) or `error`. Use that to terminate your stream loop.

---

## 3. The snapshot semantics

### Text events (`assistant`, `reasoning`)

Text events are deltas — concatenate the `content` strings in arrival order to reconstruct the full message. The coalescer (when on, which is the default) merges consecutive text deltas into larger frames before they hit the wire, so you'll see fewer-but-bigger chunks. This is invisible to your renderer either way: append-as-you-go works.

### Tool call events (`tool_call`)

`tool_call` events are **snapshots of the tool's state at the moment they were emitted**. Each one is self-contained — `tool_input` is the parsed argument object as known so far, not a diff against the previous snapshot.

A single tool call produces a sequence of frames that all share the same `tool_call_id`:

```
turn N:
  tool_call { tool_call_id: "tc-abc", tool_name: "Read", tool_input: {},                                status: "running" }
  tool_call { tool_call_id: "tc-abc", tool_name: "Read", tool_input: { file_path: "/op" },             status: "running" }
  tool_call { tool_call_id: "tc-abc", tool_name: "Read", tool_input: { file_path: "/opt/stacks/" },    status: "running" }
  tool_call { tool_call_id: "tc-abc", tool_name: "Read", tool_input: { file_path: "/opt/stacks/.." }, status: "completed" }
```

**The contract**: every snapshot strictly extends or refines the previous one. Newer = more information. Safe to drop older ones for the same id.

### Tool result events (`tool_result`)

One per tool call, after the agent receives the tool's output. Match it against the open `tool_call` by `tool_call_id`.

---

## 4. The `status` field (partial-JSON path)

When `LETTABOT_PARTIAL_JSON_ENABLED=true` (the default since lettabot-uww.6), `tool_call` frames carry a `status` field:

| Status | Meaning |
|---|---|
| `"running"` | Args still streaming. UI should render in a "loading" / "in progress" state. |
| `"completed"` | Final args, ready to display. |

The field is **wire-additive** — clients that ignore it continue to work because the snapshot semantics handle the rendering correctly either way (latest replaces earlier). Honor it if you want a visual lifecycle (spinner → checkmark); ignore it if you don't.

When `LETTABOT_PARTIAL_JSON_ENABLED=false`, the `status` field is absent. You'll see exactly one `tool_call` frame per call, with the fully accumulated args. This is the legacy single-emit behavior; the dedup-by-id rule still applies (and is a no-op since N=1) so a renderer that honors the snapshot contract works in both modes.

---

## 5. A correct renderer (pseudocode)

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

---

## 6. Common pitfalls

### ❌ Treating `tool_call` as deltas

```ts
// WRONG — produces N bubbles per tool call
case "tool_call":
  messages.push({ kind: "tool", ...frame });
  break;
```

Symptom: with `LETTABOT_PARTIAL_JSON_ENABLED=true`, a single `Read` call renders as ~5–20 stacked bubbles, each showing a slightly more complete `tool_input`.

### ❌ Concatenating `tool_input` across frames

```ts
// WRONG — tool_input is already the full snapshot, not a diff
existing.toolInput = { ...existing.toolInput, ...frame.tool_input };
```

Symptom: stale keys from earlier snapshots persist when the streaming JSON parser revises its parse on later chunks.

### ❌ Falling back to `uuid` instead of `tool_call_id` for dedup

```ts
// WRONG — uuid changes per snapshot; tool_call_id is stable
const id = frame.uuid;
```

Symptom: every snapshot creates a new entry — same as treating snapshots as deltas.

### ❌ Not handling `tool_call_id` collisions across turns

`tool_call_id` is unique within a turn but agents are free to reuse ids across turns. Scope your dedup map to the current `request_id` (or reset it on each `result` frame). The bundled coalescer already does this server-side; your client should too.

---

## 7. Reference implementations

These adapters honor the contract correctly and are good source material:

- **`src/api/partial-json-snapshot-emitter.ts`** — server-side per-id dedupe with structural-equal early-out. Same shape as a client renderer; just runs upstream of the wire.
- **`src/api/bot-stream-coalescer.ts`** — server-side coalescer. The `handleToolCall` method is essentially the renderer pseudocode in §5, in TypeScript.
- **`src/api/ws-gateway.e2e.test.ts`** — wire-level fixtures showing the exact frame sequence a client receives. Useful for cross-checking your renderer.
- **letta-mobile** `AdminChatViewModel.kt:1283` (`upsertClientModeLocalAssistantChunk`) — Kotlin/Compose renderer, keys by `localId = "cm-tool-$toolCallId"` with replace semantics.

---

## 8. Related architecture docs

- [`docs/architecture/bot-stream-coalescer.md`](./architecture/bot-stream-coalescer.md) — server-side coalescer design rationale.
- [`docs/architecture/partial-json-tool-args.md`](./architecture/partial-json-tool-args.md) — partial-JSON snapshot emitter design.
- [Configuration Reference](./configuration.md#ws-gateway-stream-coalescing) — operator-facing env vars.
