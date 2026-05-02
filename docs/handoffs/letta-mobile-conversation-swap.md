# Handoff: letta-mobile reaction to mid-stream conversation swap

**Status:** Lettabot side landed; pending mobile-side change
**Date opened:** 2026-04-27
**Bead:** `lettabot-flk.5` (lettabot side)
**Related epic:** `flk` (gateway conversation swap propagation)

## Context

The WS gateway has an automatic recovery path
([`agent-session-manager.ts::_doSendAndStream`](../../src/api/agent-session-manager.ts))
that opens a fresh conversation under the same connection when certain
failures hit before any user-visible content has streamed. Two trigger
branches:

1. The SDK returns a `result` with `success=false` on the first attempt
   and nothing has been delivered yet (`deliveredContent` guard from
   lettabot-y4j is false).
2. Letta returns a 404 for the conversation (`classifyError` →
   `conversation_missing`) and again, nothing has been delivered.

In both branches the manager closes the broken session, opens a new
one, and retries the same message under a fresh `conversationId`.

**Pre-flk.5 wire shape:** the gateway only echoed `conversation_id` on
the terminal `result` frame. So the mobile observer (keyed to the
original conversation id from `session_init`) ingested the retry's
assistant chunks under the **original** conversation. By the time the
final `result` arrived carrying the new `conversation_id`, the chunks
had already been written to the wrong timeline and the swap banner
fired too late to move them.

## What changed in lettabot

**Part 1: every stream frame now carries `conversation_id`.**

`assistant`, `reasoning`, `tool_call`, and `tool_result` frames now
include `conversation_id` matching the conversation the chunk belongs
to. The terminal `result` already carried it. So a client can detect
the swap on the **first** chunk of the retry rather than the
terminal frame.

**Part 2: explicit `conversation_swap` stream event.**

When the recovery branch fires, the manager yields a synthetic
`conversation_swap` event into its `sendAndStream` generator
([`agent-session-manager.ts:560–569`](../../src/api/agent-session-manager.ts) and
[`agent-session-manager.ts:691–700`](../../src/api/agent-session-manager.ts)).
The gateway forwards a wire frame:

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

This frame arrives **before** any retry stream events, so a client
can move pending optimistic state and re-anchor its observer
proactively.

Both contracts are documented in
[`docs/channel-adapter-contract.md`](../channel-adapter-contract.md) §3.4
and §3.5.

## What letta-mobile needs to do

### 1. `ClientModeChatSender.kt` — parse the new wire shape

The gateway frame parser needs three new field paths:

- `conversation_id` on assistant / reasoning / tool_call / tool_result
  chunks. The existing `chunk.conversationId` on `AdminChatViewModel`
  line ~1060 already reads this, but currently sees `null` for those
  events; after this lettabot deploy, it will be populated.
- `event = "conversation_swap"` as a new stream-event type.
- `old_conversation_id` / `new_conversation_id` on swap events.

Suggested data class:

```kotlin
data class ConversationSwapChunk(
    val oldConversationId: String?,
    val newConversationId: String,
    val requestId: String?,
)
```

…with parsing branched off `event` exactly the way the existing
`assistant` / `tool_call` branches work.

### 2. `AdminChatViewModel.kt` — react to the swap

The `swapEvaluated` block around line 1060 currently only fires once,
on the first chunk that carries a `conversationId`. After flk.5 it
will see populated `conversation_id` on the very first chunk of the
retry — the existing logic already handles "prior != current" and can
emit the banner there, instead of waiting for `result`.

For the explicit `conversation_swap` event, the cleaner path is:

1. Move any optimistic `Local` (the "sending..." bubble) onto the new
   conversation's timeline. The repo's existing `TimelineRepository`
   pattern around line 1100-ish has the relevant move helpers.
2. Switch the timeline observer's `conversationId` to
   `new_conversation_id`.
3. Update the navigation arg / route param so back-navigation lands
   on the new conversation, not the dead one.
4. Optionally surface the swap banner with both old and new ids
   (today's banner is already aware of "we recovered into a new
   conversation").

### 3. Order of fixes

The two changes are independently useful — landing them in either
order is fine:

- **Just §1+§2 (no §2-event handling):** mobile detects the swap on
  the first chunk via `conversation_id` mismatch, same banner UX as
  today's terminal-frame detection, just earlier.
- **§2 event handling:** cleaner separation between
  "ingest-as-normal" and "this is a transition signal." Recommended
  because the optimistic Local move is easier to reason about as a
  one-shot swap event handler.

Either way, mobile is wire-additive: a build that doesn't know
about the new `conversation_id` field or the `conversation_swap`
event keeps working — it just learns about the swap from the
terminal `result` like before.

## Verification recipe

1. Start a turn against an agent whose conversation has been corrupted
   (e.g. previously aborted mid-tool-call and never recovered). Easiest
   repro: edit `gateway-conversations.json` to point an agent at a
   bogus conversation id, then send a message.
2. Watch the journalctl logs for
   `Conversation failed for agent ... — Clearing stale conversation and retrying...`
   followed by `Recovery successful — new conversation ...`. That's
   the recovery path firing.
3. On the mobile client, confirm:
   - The swap banner appears at the **first chunk of the retry** (or
     on the explicit `conversation_swap` frame), not at the terminal
     `result`.
   - The retry assistant chunks render in the new conversation's
     timeline, not the old one.
   - On app restart / cold hydrate, the new conversation's history
     contains the agent's reply (it does today — Letta server is
     authoritative — but the live render no longer strands chunks).

## Wire-additivity guarantees

- A naive client that ignores `conversation_id` keeps working — it
  just doesn't learn about swaps until the terminal `result`.
- A client that ignores `event = "conversation_swap"` keeps working —
  it sees the new id on subsequent chunks via the per-frame
  `conversation_id` and can react there.
- Both fields are additive: nothing existing was renamed or removed.

## Reference points

- `src/api/ws-gateway.ts::forwardStreamEvent` — wire emission of
  `conversation_id` and the `conversation_swap` case.
- `src/api/agent-session-manager.ts::_doSendAndStream` — both
  recovery branches that yield the swap event.
- `src/api/ws-gateway.e2e.test.ts` — `conversation_id propagation
  (lettabot-flk.5)` describe block has a wire-shape fixture for both
  parts.
- `docs/channel-adapter-contract.md` §3.4 + §3.5 — the canonical wire
  contract.
