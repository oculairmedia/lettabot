# BotStreamCoalescer — gateway-side stream coalescing

**Status:** Proposed
**Date:** 2026-04-26
**Author:** PM - letta-mobile (Letta Code) + Emmanuel
**Related:** [paseo deep dive](./paseo-research-notes.md), letta-mobile lv3e (closed)
**Bead epic:** `lb-coal` (lettabot)

## Context

After closing letta-mobile-lv3e we audited the lettabot ↔ letta-mobile WS streaming pipeline against `getpaseo/paseo`'s daemon. Paseo solves the *same* problem we have (multi-provider streaming → mobile client) and ships a small server-side primitive — `AgentStreamCoalescer` — that we don't have. It produces fewer, larger frames over the wire and makes per-tool replace semantics first-class.

This document specifies a clean-room reimplementation in lettabot's WS gateway. Code is **inspired by, not derived from**, paseo's AGPL implementation; we describe behaviour at the spec level and implement from scratch.

---

## Part 1: Today's gateway behaviour

`src/api/ws-gateway.ts` forwards every Letta SDK event to the WS channel as it arrives. Concretely (see `runStream`, line ~325 and `broadcastChannelMessage`, line ~477):

| Letta SDK event       | Wire frame             | Per-token frequency |
|-----------------------|------------------------|---------------------|
| `assistant` (delta)   | `{ event: "assistant", content: "Hel" }` | yes — one frame per delta |
| `reasoning` (delta)   | `{ event: "reasoning", content: "thi" }` | yes |
| `tool_call` (delta)   | accumulated server-side, emitted as one snapshot when next semantic event arrives | no |
| `tool_result`         | `{ event: "tool_result", content: ... }` | once |

Two problems:

1. **Frame inflation.** A 400-token assistant message becomes 400 WS frames, each with full `{ type, event, content, uuid, request_id }` envelope (~80 bytes overhead per frame ≈ 32KB of envelope vs. ~1.6KB of payload).
2. **No batching window.** On flaky cellular every frame can fragment, packet-loss, or stall independently. A coalescer with a 200ms window would dramatically reduce that pressure without hurting perceived latency.

The tool-call path *already* coalesces (it accumulates args until the next event), but it's bespoke to that branch. Generalizing the pattern lets us delete the ad-hoc tool-call accumulator and gain text-coalescing for free.

---

## Part 2: Target behaviour

### Wire contract (unchanged — this is purely additive on the server)

| Event type            | Shape    | Coalescer treatment |
|-----------------------|----------|---------------------|
| `assistant`           | DELTA    | concat consecutive deltas of same `request_id`, flush on window expiry |
| `reasoning`           | DELTA    | concat consecutive deltas of same `request_id`, flush on window expiry |
| `tool_call`           | SNAPSHOT | replace by `tool_call_id`, flush immediately on terminal status |
| `tool_result`         | SNAPSHOT | pass-through, flush immediately (also flushes any pending text/tool_call for the same request) |
| All others            | n/a      | pass-through, flush pending |

Clients (letta-mobile, Matrix bridge, openai-compat) keep their existing handlers — they already accept either pattern (the lv3e fix made the VM delta-aware; longer batched deltas are still deltas).

### Component shape

```
┌──────────────────────┐                ┌──────────────────────┐               ┌────────────┐
│ Letta SDK stream     │  ─per-event→   │ BotStreamCoalescer   │ ─per-flush→   │ ws.send()  │
│ (runStream)          │                │ (200ms window)       │               │            │
└──────────────────────┘                └──────────────────────┘               └────────────┘
```

`BotStreamCoalescer` is a single TypeScript class living in `src/api/bot-stream-coalescer.ts`. It owns no transport — it takes events in via `handle(requestId, event)` and emits via an `onFlush` callback supplied by the gateway.

### Algorithm

```
state per requestId:
  buffer: ordered list of pending entries
    text entry:    { kind: 'text', event: 'assistant'|'reasoning', text: string, uuid?, ... }
    tool entry:    { kind: 'tool', tool_call_id, snapshot: <full tool_call wire object> }
    other entry:   { kind: 'other', wire: <raw frame> }
  toolIndex: Map<tool_call_id, index in buffer>
  timer: NodeJS.Timeout | null

handle(requestId, event):
  if event is text-delta (assistant or reasoning):
    if last entry is text entry of same event-type and same request:
      append delta to its text
    else:
      push new text entry
  else if event is tool_call snapshot:
    if toolIndex.has(tool_call_id):
      replace entry at that index
    else:
      push new tool entry, record index
  else:
    push as-is (other entry)

  schedule flush in 200ms if not scheduled

  flush triggers (immediate, ahead of timer):
    - tool_call with terminal status (completed | failed | canceled)
    - tool_result event for any tool_call_id
    - turn_complete (or our equivalent stream-close marker)
    - request cancellation / abort
    - explicit flushAll() on server shutdown

flush(requestId):
  for each entry in order:
    onFlush(entry.wire)
  clear buffer + index + timer
```

### Why the rules look this way

- **Text concat preserves wire contract**: a coalesced delta is still a delta. Clients append. The lv3e regression test pins this.
- **Tool replace is correct**: each `tool_call` snapshot is a complete tool state at the moment it was emitted. Newer snapshot → strictly more information → safe to drop older.
- **Terminal-status flush** prevents the case where a tool finishes during the 200ms window and the client briefly sees a stale "running" state then jumps.
- **Per-request scoping**: two parallel turns (rare today, but happens with tool-using sub-agents) don't cross-contaminate.
- **No coalescing for other event types**: `tool_result`, `usage`, `error` etc. are infrequent and order-sensitive. Pass-through.

### Window default

200ms (matches paseo). Tunable via env var `LETTABOT_COALESCE_WINDOW_MS`. Bench mark before shipping; if 200ms feels laggy on desktop we can drop to 100ms for assistant deltas only.

---

## Part 3: Integration plan

### Files touched

| File                                       | Change |
|--------------------------------------------|--------|
| `src/api/bot-stream-coalescer.ts` (new)    | Coalescer class + types |
| `src/api/bot-stream-coalescer.test.ts` (new) | Unit tests for all flush rules |
| `src/api/ws-gateway.ts` (modify)           | Wrap `runStream` event loop + `broadcastChannelMessage` per-frame `this.send()` calls behind a coalescer instance keyed by `request_id` |
| `src/api/ws-gateway.test.ts` (modify)      | Add wire-level tests asserting coalesced output for a 50-frame stream |

### Gateway integration sketch

```ts
// ws-gateway.ts
private coalescers = new Map<string, BotStreamCoalescer>();

private getCoalescer(requestId: string): BotStreamCoalescer {
  let c = this.coalescers.get(requestId);
  if (!c) {
    c = new BotStreamCoalescer({
      windowMs: env.LETTABOT_COALESCE_WINDOW_MS ?? 200,
      onFlush: (wire) => this.send(ws, wire),  // ws closure captured at handler creation
    });
    this.coalescers.set(requestId, c);
  }
  return c;
}

// Inside runStream event loop, replace direct `this.send(...)` for stream events with:
this.getCoalescer(request_id).handle(event);

// On stream end / abort:
this.coalescers.get(request_id)?.flushAndDispose();
this.coalescers.delete(request_id);
```

The key invariant: **anything currently calling `this.send(ws, { type: 'stream', ... })` for a streaming turn goes through the coalescer**. Non-stream sends (acks, errors, system events) bypass it.

### Removing the bespoke tool-call accumulator

Lines ~325–370 of `ws-gateway.ts` today buffer tool_call args until the next semantic event. The coalescer's tool_call replace-by-id rule subsumes this. The accumulator becomes a single `handle(event)` call. The `// Mirror the SDK behaviour` comment block can be deleted.

Net change: probably -30 LOC of bespoke logic + 200 LOC of generalized coalescer.

---

## Part 4: Test plan

### Unit (BotStreamCoalescer in isolation)

1. **Text concat**: 10 assistant deltas in <200ms → 1 flushed frame whose `content` is the concatenation.
2. **Text split across windows**: 10 deltas, then 250ms gap, then 10 more → 2 flushed frames.
3. **Mixed text + tool**: assistant delta, tool_call (running), assistant delta → flushed in **insertion order** (assistant_concat, tool, assistant_concat). Tool does *not* split text adjacency if and only if the second text comes from the same request *after* the tool — in that case it's a separate text entry.
4. **Tool replace by id**: 5 running snapshots of the same `tool_call_id` → 1 flushed frame (the latest).
5. **Tool terminal flush**: running → completed snapshot triggers immediate flush, even with timer running.
6. **Tool result flushes pending**: pending text + pending tool, then tool_result → all three flushed in order, then tool_result.
7. **Per-request isolation**: events for `req-A` and `req-B` interleave; flushes are independent.
8. **Abort/cancel**: `flushAndDispose()` flushes pending and clears state.
9. **No-event timer no-op**: timer fires with empty buffer → no `onFlush` calls.

### Wire-level (gateway integration)

10. **Existing 58-frame golden replay** (`wsstream-golden-lv3e.json`): pipe through coalescer, assert concatenated output equals original message verbatim.
11. **Frame-count reduction**: same golden, assert `<10` flushed frames (down from 58) at default window.
12. **letta-mobile compatibility**: run lv3e wire-level test against coalesced output → still passes (deltas are still deltas, just bigger).

### E2E (manual, pre-merge)

13. Run lettabot locally + letta-mobile debug build, send a long markdown reply, verify text streams smoothly and tool_call cards render correctly. Look at network panel for frame count drop.

---

## Part 5: Rollout

1. Land coalescer + unit tests behind a feature flag (`LETTABOT_COALESCE_ENABLED=false` default).
2. Bake on Emmanuel's daemon for 48h with flag on. Watch for: stuck text (timer not firing), out-of-order frames, tool card flicker.
3. If clean, default-on in next lettabot release. Keep the kill switch for two releases.
4. Two releases later: delete the kill switch + bespoke tool accumulator.

### Compat callout — letta-mobile wucn heuristic (discovered during aie.5 audit)

`AdminChatViewModel.kt` line ~1404 has a `wucn-snapshot-recovery`
heuristic that interprets any incoming assistant delta of length ≥32
that fails the strict prefix check as a "snapshot rewrite" and
*replaces* the existing bubble content with the longer of the two
strings.

The original justification was server-side normalization on the
*timeline-sync* path (whitespace/quote rewrites). It does not apply to
the WS streaming path, but the same code path serves both.

With coalescing enabled this heuristic actively breaks: a coalescer
flush that batches ~20 token deltas into a single ~140-char delta
fails the prefix check (it's neither a prefix-of nor a prefix-from
existing content) and trips the heuristic, causing every batch after
the first to be silently dropped or to overwrite the bubble.

**Mitigation:** mobile-side fix in lettabot-aie.5b (new bead) to scope
the wucn heuristic to the timeline-sync path only, before flipping the
flag default-on in aie.6.

---

## Open questions

- **Reasoning + assistant interleaving**: when a model emits reasoning then assistant then more reasoning in the same turn, do clients want them coalesced separately (current proposal) or as one ordered stream? Current proposal is correct for our existing UI (separate reasoning bubble) but worth confirming.
- **Compaction events** (Letta runs background context compaction): currently bypass coalescing — should they? Probably fine to pass-through.
- **Tool_call args partial JSON**: orthogonal — this is the scope of the second design doc (`partial-json-tool-args.md`). Coalescer just sees whatever snapshots the SDK emits.

---

## Out of scope

- Client-side coalescing (letta-mobile already handles deltas correctly).
- Off-LAN relay (separate doc, `off-lan-relay.md`).
- Wire-format changes (envelope stays identical, only frame count drops).
