# Handoff: letta-mobile opt-in for progressive tool_call snapshots

**Status:** Pending mobile-side change
**Date opened:** 2026-04-26
**Bead:** `lettabot-pgs.4` (lettabot side)
**Related epic:** `lettabot-pgs` (per-connection opt-in for progressive `tool_call` snapshots)

## Context

Until `lettabot-pgs`, the WS gateway emitted progressive `tool_call` snapshots (`status: 'running'` frames as JSON args streamed in) to **every** connected client whenever `LETTABOT_PARTIAL_JSON_ENABLED=true` (the server-wide default). Adapter authors had to honor a dedup-by-`tool_call_id` rule or render N stacked tool bubbles per call. That requirement was the most common adapter bug, documented in [`docs/channel-adapter-contract.md`](../channel-adapter-contract.md) §6.

In `lettabot-pgs.1`, the gateway gained a per-connection capability flag — clients now opt in to progressive snapshots via a query parameter on the WS URL:

```
wss://your-host/api/v1/agent-gateway?progressive_tool_calls=1
```

Connections that **do not** opt in see exactly one `tool_call` frame per id (the terminal `status: 'completed'` snapshot, with running snapshots dropped server-side before reaching the wire). This makes the contract correct-by-default for naive renderers.

## What letta-mobile needs to do

The Kotlin/Compose renderer in `AdminChatViewModel.kt` (around line 1283, `upsertClientModeLocalAssistantChunk`) already implements the dedup-by-`tool_call_id` rule correctly — see the §6 reference implementation note in the channel-adapter-contract doc. So the mobile UI continues to work either way:

- **Without opt-in:** mobile receives one `tool_call` frame per id (the final args). The dedup-by-id renderer collapses to a single bubble that appears with the final args at once. **Loses progressive UX** — tool cards no longer grow as args stream in. Functionally correct, visually less rich.
- **With opt-in:** mobile receives every progressive snapshot, the renderer's existing replace-by-id logic collapses to one growing bubble. **Preserves progressive UX.**

To preserve progressive UX, append `?progressive_tool_calls=1` to the WS URL when constructing the gateway connection. There should be exactly one place in the mobile codebase that builds this URL (the gateway client construction site).

### Suggested mobile change

Find the WS URL construction in the gateway client (likely in a class named something like `AgentGatewayClient`, `WsGatewayClient`, or similar):

```kotlin
// Before
val url = "wss://$host/api/v1/agent-gateway"

// After
val url = "wss://$host/api/v1/agent-gateway?progressive_tool_calls=1"
```

If the host already constructs URLs via a builder, prefer adding the query param via the builder API rather than string concatenation.

## Verification

Mirror the pattern from `lettabot-uww.5` (manual UI verification, 2026-04-26):

1. Build mobile against patched lettabot (this branch's gateway has the gate).
2. Send a message that triggers a tool with sizable args, e.g. "read /opt/stacks/lettabot/src/api/ws-gateway.ts".
3. **Without** the opt-in: the tool card should appear once with the final path, no growing animation.
4. **With** the opt-in: the tool card should grow progressively as the file_path streams in (this is the pre-`pgs` behavior).
5. Confirm exactly one bubble per tool call in both cases (no duplicates).

Run on Pixel 2XL to keep the test platform consistent with `uww.5`.

## Wire-additivity guarantees

The opt-in is wire-additive in both directions:

- **Old mobile build (no opt-in) connecting to new gateway:** sees one frame per call. Renders correctly via existing replace-by-id logic. Loses progressive UX but everything still works.
- **New mobile build (opted in) connecting to old gateway** (one without the `pgs.1` gate): the gateway ignores the query param and emits progressive snapshots as before — same as today's behavior. New mobile doesn't break against unpatched servers.

Coordination is therefore not strict. The lettabot gateway change can ship before mobile's URL flip without any window of incorrectness; mobile just temporarily loses the progressive-tool-card UX until it updates.

## Closing this bead

Close `lettabot-pgs.4` when:

1. Mobile PR with the opt-in lands and ships to a build a maintainer can run.
2. Manual Pixel 2XL verification confirms progressive UX returns when opted in.
3. Document the mobile commit hash + bead in this file's Status block.

## References

- Wire contract: [`docs/channel-adapter-contract.md`](../channel-adapter-contract.md) §1 (default contract) and §4 (opt-in)
- Operator-facing knobs: [`docs/configuration.md`](../configuration.md#ws-gateway-partial-json-tool_call-snapshots)
- Architecture rationale: [`docs/architecture/partial-json-tool-args.md`](../architecture/partial-json-tool-args.md) §6
- Gateway gate implementation: `src/api/ws-gateway.ts` (`onConnection` capability parse + `onSnapshot` callback gate)
- Test matrix proving both paths: `src/api/ws-gateway.e2e.test.ts` "flag matrix" describe block (8 cells)
