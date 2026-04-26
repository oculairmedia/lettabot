# Streaming partial JSON for tool_call arguments

**Status:** Proposed
**Date:** 2026-04-26
**Author:** PM - letta-mobile (Letta Code) + Emmanuel
**Related:** `bot-stream-coalescer.md`, paseo deep dive
**Bead epic:** `lb-pjsn` (lettabot)

## Context

Letta (and the underlying provider, e.g. Claude) streams tool_call arguments as **incremental JSON fragments**. Today our gateway buffers these fragments until the call is complete (or until the next semantic event arrives), then emits one `tool_call` frame with the fully-parsed args. The mobile UI sees nothing until the full call lands.

Paseo handles this with a small partial JSON parser — they parse the buffer *as it grows*, and any time the partial parse yields more keys than the previous attempt, they re-emit a `tool_call` snapshot with whatever's parsed so far. The user sees `Reading /opt/stacks/letta-mob…` mid-stream instead of a "thinking" spinner.

This document proposes the same upgrade for lettabot.

---

## Part 1: Problem statement

### Today

```
Provider stream:       {"file_  +  path":  +  "/opt/  +  stacks/  +  ...  +  ", "limit": 100}
                       └──── buffered server-side, no client visibility ─────┘
Gateway emits:                                                              └→ one tool_call snapshot
Mobile UI:             [tool card: "running… (no detail)"]               [tool card: "Read /opt/stacks/letta-mobile/...]
                       ←────────── multi-second silence ──────────────→
```

### Goal

```
Provider stream:       {"file_  +  path":  +  "/opt/  +  stacks/  +  ...  +  ", "limit": 100}
Parser progress:       (incomplete) (incomplete) → {file_path: "/opt/"} → {file_path: "/opt/stacks/"} → ... → {file_path: ".../X.kt", limit: 100}
Gateway emits:                                       tool_call snap     tool_call snap                    tool_call snap (final)
Mobile UI:             [tool card: "running…"]    [Read /opt/]      [Read /opt/stacks/]               [Read .../X.kt (limit 100)]
```

Each successive snapshot strictly extends the previous (more keys, longer string values). Combined with the **BotStreamCoalescer's tool_call replace-by-id** rule, only the latest snapshot per 200ms window is sent — so wire cost is bounded.

---

## Part 2: Partial JSON parser

### Specification

A pure function:

```ts
parsePartialJsonObject(input: string): { value: Record<string, unknown>; complete: boolean } | null
```

- Returns `null` if input cannot be coerced into a *partial* JSON object (e.g. doesn't start with `{`, malformed in a way that won't recover).
- Returns `{ value, complete: false }` if parse succeeded but ran off the end of input mid-string / mid-value / before closing brace.
- Returns `{ value, complete: true }` if the input is a complete, well-formed JSON object.

### Supported partial states

| Input fragment              | Returned value                | Complete? |
|-----------------------------|-------------------------------|-----------|
| `{`                         | `{}`                          | false     |
| `{"key`                     | `{}`                          | false     |
| `{"key":`                   | `{}` *(no value yet)*         | false     |
| `{"key": "val`              | `{ key: "val" }`              | false     |
| `{"key": "value",`          | `{ key: "value" }`            | false     |
| `{"key": "value", "k2":`    | `{ key: "value" }`            | false     |
| `{"key": "value", "k2": 4`  | `{ key: "value", k2: 4 }`     | false     |
| `{"key": "value"}`          | `{ key: "value" }`            | true      |
| `{"a": [1, 2,`              | `{ a: [1, 2] }`               | false     |
| `{"a": [1, 2, "p`           | `{ a: [1, 2, "p"] }`          | false     |
| `{"a": {"nested": tr`       | `{ a: { nested: true } }` *(coerced from `tr` → `true` if and only if the partial is unambiguous; otherwise omit)* | false |
| garbage                     | `null`                        | n/a       |

### Recovery rules

1. **Partial string**: take the chars seen so far as the value. Don't include the trailing unescaped `\` if the parse stopped on an escape.
2. **Partial number**: if the run of digits/sign/decimal/exponent forms a valid number prefix, include it. If the prefix is ambiguous (just `-`), drop the field.
3. **Partial keyword**: `true`, `false`, `null` only included when the prefix uniquely identifies them (`tr`, `fa`, `nu` all unique). Length-1 prefix (`t`, `f`, `n`) is ambiguous → drop.
4. **Partial key**: a key without its colon+value is dropped from the result.
5. **Trailing comma**: tolerated; drop and finish.
6. **Unclosed object/array**: tolerated; close implicitly.

### Why hand-roll vs. use a library

- **Determinism + tests**: partial JSON has no W3C spec; libraries differ on edge cases. We need byte-identical behaviour across provider migrations.
- **Size**: ~300 LOC, no runtime deps.
- **Already proven shape**: paseo's parser (we won't lift the code) demonstrates this is a tractable problem in that footprint.
- We do **not** need full JSON spec coverage; tool_call args are a narrow subset (objects with string/number/bool/array/object values).

---

## Part 3: Integration with the gateway

### Where the buffer lives today

`src/api/ws-gateway.ts` lines ~325–370 (the bespoke tool_call accumulator). It accumulates `event.tool_input_partial` chunks from the SDK into a per-`tool_call_id` buffer keyed string.

### New flow

```
Letta SDK emits:  tool_call_delta  { tool_call_id, partial_json: "{\"file_p" }
                                        │
                                        ▼
                          buffer.append(partial_json)
                                        │
                                        ▼
                  parsePartialJsonObject(buffer)
                                        │
                                        ▼
                      { value, complete } or null
                                        │
                          ┌─────────────┴──────────────┐
                          ▼                            ▼
                   value !== last value          (no change or null)
                          │                            │
                          ▼                            ▼
              emit tool_call snapshot              skip (debounce)
              with parsed args + status='running'
```

### Snapshot dedupe

We don't want to emit a new snapshot on every byte. Rule: only emit if the parsed JSON object is **structurally different** from the last emitted snapshot for that `tool_call_id` (deep equality on the parsed value). This handles cases where the buffer grew but didn't extend the parse (e.g. mid-escape).

### Coalescer interaction

With the BotStreamCoalescer's tool_call replace-by-id rule, even if we naïvely emit on every successful parse-extension, the wire only sees the latest snapshot per 200ms window. So we can be liberal about emitting — the coalescer absorbs the noise. Both pieces compose cleanly.

### Terminal status

When the SDK emits `tool_call_complete` (or whatever it's called — verify exact name in `letta-client`), we have the full args buffer. Run `parsePartialJsonObject` once more — must return `{ complete: true }` or we log a warning and emit the partial. Mark snapshot `status: 'completed'` and let the coalescer flush immediately.

---

## Part 4: Files

| File                                       | Change |
|--------------------------------------------|--------|
| `src/api/partial-json.ts` (new)            | Parser implementation |
| `src/api/partial-json.test.ts` (new)       | Unit tests covering every row in §2 plus fuzz cases |
| `src/api/ws-gateway.ts` (modify)           | Replace bespoke accumulator (lines ~325–370) with parser + per-id snapshot dedupe |
| `src/api/ws-gateway.test.ts` (modify)      | Add streaming tool_call test asserting progressive snapshots |
| `src/api/bot-stream-coalescer.ts`          | No changes — interface is event-shaped, agnostic to how snapshots are produced |

---

## Part 5: Test plan

### Parser unit tests

For each row in §2 spec table → assert exact `(value, complete)` output. Plus:

- **Fuzz**: 1000 random truncations of valid JSON objects. Every prefix of a valid object must parse to *some* `{ value, complete: false }` or `null`, never throw.
- **Idempotence under extension**: if `parse(s) = { value: V1 }` and `parse(s + delta) = { value: V2 }`, then `V1 ⊆ V2` (V2 has at least V1's keys with at least V1's values' content). Fuzz this property over 1000 random cases.
- **Real Letta traces**: capture 10 real tool_call streams from `:cli:run wsstream` on common tools (Read, Bash, Grep, Edit, Glob), pipe through parser frame-by-frame, assert progression.

### Gateway integration tests

- **Progressive emit**: feed a known sequence of partial_json chunks for a `Read` call, assert the exact sequence of `tool_call` snapshot emissions.
- **No regression**: existing tests asserting completed tool_call shapes still pass.

### Mobile-side verification (manual, pre-merge)

Run letta-mobile against patched lettabot, send "Read this file" instruction, verify tool card text grows progressively in <100ms steps instead of after a multi-second pause.

---

## Part 6: Rollout

Same shape as coalescer:

1. ✅ Land parser + integration behind `LETTABOT_PARTIAL_JSON_ENABLED=false` (`lettabot-uww.1`–`.4`).
2. ✅ Bake on Emmanuel's daemon — mobile UI verified on Pixel 2XL (`lettabot-uww.5`, 2026-04-26).
3. ✅ Default-on, kill switch retained for two releases (`lettabot-uww.6`).

Cleanup (kill-switch removal + dead legacy single-frame path) is scheduled for two release cycles after step 3, tracked by the follow-up bead filed alongside `uww.6`.

Order matters: **coalescer first** (otherwise progressive snapshots inflate frame count). The coalescer flipped on in `lettabot-aie.6` (commit `f3632ff`); partial-JSON flipped on in `uww.6`.

---

## Out of scope

- Streaming the *output* of tool_calls progressively (e.g. shell command stdout) — that's a different SDK event shape.
- Generalized partial parser for the assistant text channel (text deltas are already pass-through; no need).
- Partial parsing of tool *output* JSON (different event, same parser could be reused but defer until requested).

---

## Open questions

- **Letta SDK delta event name**: confirm exact field on the streaming event for tool_call argument deltas. Code refs to update when this lands.
- **Provider differences**: if Letta proxies multiple providers (Anthropic, OpenAI), do they all emit partial JSON the same way? Spot-check before shipping.
