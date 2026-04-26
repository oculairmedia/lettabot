/**
 * Wire-level golden replay test for BotStreamCoalescer.
 *
 * Drives the coalescer with a recorded outbound-frame stream that mirrors
 * what the gateway emits during a chatty turn (many text deltas + several
 * tool calls with progressive snapshot updates) and asserts:
 *
 *   1. With the coalescer enabled, the on-wire frame count drops by the
 *      threshold described in docs/architecture/bot-stream-coalescer.md
 *      (≥4× reduction; the doc claims ~5×).
 *   2. The flattened content (all text concatenated, latest tool_call
 *      snapshot per id, all tool_results) is byte-identical to what the
 *      pass-through (coalescer-off) path produces.  No information is
 *      ever lost.
 *   3. Insertion ordering is preserved: every text-then-tool / tool-then-
 *      text adjacency in the fixture survives in the flushed sequence.
 *
 * The fixture is constructed programmatically rather than checked in as a
 * static JSON file because (a) it lets us tune the chattiness parameters
 * without re-recording, and (b) it documents the SDK's per-token streaming
 * shape inline.  Real-world streams are noisier; this is an idealized
 * model that captures the structural patterns the coalescer must handle.
 *
 * Spec: docs/architecture/bot-stream-coalescer.md §4 case 6 + §5 perf.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BotStreamCoalescer,
  type StreamFrame,
} from './bot-stream-coalescer.js';

// --- fixture builders ---

interface FixtureFrame extends StreamFrame {
  type: 'stream';
}

/**
 * Synthesize a chatty assistant turn at SDK-token granularity:
 *   - `prefixWords` text deltas of "thinking..." style before the first tool.
 *   - `toolCalls` tool calls; each tool call is preceded by a short text
 *     delta run, has `snapshotsPerCall` progressive `tool_call` frames
 *     (simulating the SDK streaming arguments), then a tool_result.
 *   - `suffixWords` text deltas after the last tool.
 *
 * Returns a flat array of wire frames in the exact order the gateway
 * would call `sendStream(...)` on them.
 */
function buildChattyTurn(opts: {
  requestId: string;
  prefixWords: number;
  toolCalls: number;
  snapshotsPerCall: number;
  midRunText: number;
  suffixWords: number;
}): FixtureFrame[] {
  const frames: FixtureFrame[] = [];
  const { requestId, prefixWords, toolCalls, snapshotsPerCall, midRunText, suffixWords } = opts;

  // Prefix text — many small assistant deltas (token-by-token).
  for (let i = 0; i < prefixWords; i++) {
    frames.push({
      type: 'stream',
      event: 'assistant',
      content: `tok${i} `,
      uuid: i === 0 ? 'msg-prefix' : undefined,
      request_id: requestId,
    });
  }

  for (let t = 0; t < toolCalls; t++) {
    const tcId = `tc-${t}`;
    const filePath = `/opt/stacks/letta-mobile/src/file-${t}.ts`;

    // A short text run before each tool ("Reading the file...")
    for (let i = 0; i < midRunText; i++) {
      frames.push({
        type: 'stream',
        event: 'assistant',
        content: `mid${t}-${i} `,
        request_id: requestId,
      });
    }

    // Progressive tool_call snapshots — paseo's pattern shows the path
    // string growing token by token. The coalescer must collapse these
    // to one snapshot.
    for (let s = 0; s < snapshotsPerCall; s++) {
      const partial = filePath.slice(0, Math.ceil((filePath.length * (s + 1)) / snapshotsPerCall));
      frames.push({
        type: 'stream',
        event: 'tool_call',
        tool_name: 'Read',
        tool_call_id: tcId,
        tool_input: { file_path: partial },
        uuid: s === 0 ? `tc-uuid-${t}` : undefined,
        request_id: requestId,
        // Final snapshot is "completed" — terminal status forces immediate flush.
        ...(s === snapshotsPerCall - 1 ? { status: 'completed' } : { status: 'running' }),
      });
    }

    // Tool result (single frame).
    frames.push({
      type: 'stream',
      event: 'tool_result',
      tool_call_id: tcId,
      tool_name: 'Read',
      content: `contents of ${filePath}`,
      is_error: false,
      request_id: requestId,
    });
  }

  // Suffix text.
  for (let i = 0; i < suffixWords; i++) {
    frames.push({
      type: 'stream',
      event: 'assistant',
      content: `end${i} `,
      uuid: i === 0 ? 'msg-suffix' : undefined,
      request_id: requestId,
    });
  }

  return frames;
}

// --- harness ---

interface ReplayResult {
  flushed: StreamFrame[];
  /** Pass-through count — equivalent to "coalescer disabled". */
  rawCount: number;
}

/**
 * Run the fixture through a fresh coalescer with the given window. Uses
 * vi.useFakeTimers internally so window expiries are deterministic.
 *
 * The fixture is fed in three "ticks" to simulate the bursts that arrive
 * inside one coalescer window: ~33% of frames per tick, advancing 50ms
 * between ticks (well under the 200ms window). At end of stream we
 * advance past the window so any remaining buffer drains.
 */
function replay(frames: FixtureFrame[], windowMs = 200): ReplayResult {
  const flushed: StreamFrame[] = [];
  const coalescer = new BotStreamCoalescer({
    windowMs,
    onFlush: (frame) => flushed.push(frame),
  });

  const third = Math.ceil(frames.length / 3);
  const chunks = [
    frames.slice(0, third),
    frames.slice(third, third * 2),
    frames.slice(third * 2),
  ];
  for (const chunk of chunks) {
    for (const f of chunk) coalescer.handle(f);
    vi.advanceTimersByTime(50);
  }
  // End of stream — flush whatever's left.
  vi.advanceTimersByTime(windowMs);
  // Cover defensive flushAll path used by the gateway at stream end.
  coalescer.flushAll();

  return { flushed, rawCount: frames.length };
}

/**
 * Reduce a stream of flushed frames to a canonical "logical content"
 * string. Two streams that produce equal canonical strings are
 * information-equivalent regardless of frame count.
 */
function canonicalize(frames: StreamFrame[]): string {
  // Latest tool_call wins per id (we record snapshots in insertion order
  // but only emit the last).
  const lines: string[] = [];
  const lastToolCallByIndex = new Map<string, number>();

  // First pass: collect text + tool_results in order; for tool_call mark
  // index of latest snapshot per id.
  const ordered: Array<{ kind: 'keep'; line: string } | { kind: 'tc'; id: string; frame: StreamFrame }> = [];
  for (const f of frames) {
    if (f.event === 'assistant' || f.event === 'reasoning') {
      ordered.push({ kind: 'keep', line: `${f.event}:${String(f.content ?? '')}` });
    } else if (f.event === 'tool_call') {
      const id = String(f.tool_call_id ?? '');
      lastToolCallByIndex.set(id, ordered.length);
      ordered.push({ kind: 'tc', id, frame: f });
    } else if (f.event === 'tool_result') {
      ordered.push({
        kind: 'keep',
        line: `tool_result:${String(f.tool_call_id ?? '')}:${String(f.content ?? '')}`,
      });
    }
  }

  // Second pass: emit only the LAST tool_call snapshot per id (this is
  // what the coalescer naturally produces; the raw stream gets reduced
  // the same way for fair comparison).
  for (let i = 0; i < ordered.length; i++) {
    const entry = ordered[i];
    if (entry.kind === 'keep') {
      lines.push(entry.line);
    } else {
      const latestIdx = lastToolCallByIndex.get(entry.id);
      if (latestIdx !== i) continue;
      const f = entry.frame;
      lines.push(`tool_call:${entry.id}:${JSON.stringify(f.tool_input ?? {})}`);
    }
  }

  // Concat consecutive same-event text lines (the canonical form does the
  // same coalescing the wire layer does, so equality holds across modes).
  const concatenated: string[] = [];
  for (const line of lines) {
    const last = concatenated[concatenated.length - 1];
    if (
      last &&
      ((last.startsWith('assistant:') && line.startsWith('assistant:')) ||
        (last.startsWith('reasoning:') && line.startsWith('reasoning:')))
    ) {
      const prefix = last.slice(0, last.indexOf(':') + 1);
      const merged = prefix + last.slice(prefix.length) + line.slice(prefix.length);
      concatenated[concatenated.length - 1] = merged;
    } else {
      concatenated.push(line);
    }
  }

  return concatenated.join('\n');
}

// --- tests ---

describe('BotStreamCoalescer wire-level golden replay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reduces frame count ≥4× on a chatty turn while preserving content', () => {
    const fixture = buildChattyTurn({
      requestId: 'golden-1',
      prefixWords: 60, // ~60 token deltas before tool use
      toolCalls: 3,
      snapshotsPerCall: 8, // 8 progressive snapshots per tool
      midRunText: 6, // 6 text deltas between tools
      suffixWords: 30,
    });

    // Sanity: total raw frames is what we'd send without the coalescer.
    // 60 + 3*(6 + 8 + 1) + 30 = 60 + 45 + 30 = 135 frames.
    expect(fixture).toHaveLength(135);

    const { flushed, rawCount } = replay(fixture, 200);

    // 1. Frame count reduction. The chattier run should compress to under
    //    rawCount/4. With these knobs we'd expect ~14 frames:
    //    - 1 prefix text frame
    //    - per tool: 1 mid-text frame + 1 collapsed tool_call + 1 tool_result = 3
    //    - 1 suffix text frame  →  1 + 3*3 + 1 = 11
    //    Allow some slack: assert ≤ rawCount/4 to give ≥4× reduction.
    expect(flushed.length).toBeLessThanOrEqual(Math.floor(rawCount / 4));
    expect(flushed.length).toBeGreaterThan(0);

    // 2. Information equivalence: the canonical form (latest tool_call
    //    per id, all text concatenated in order) must match what we'd
    //    get from the raw stream.
    expect(canonicalize(flushed)).toBe(canonicalize(fixture));
  });

  it('emits exactly one tool_call frame per tool_call_id (latest snapshot wins)', () => {
    const fixture = buildChattyTurn({
      requestId: 'golden-2',
      prefixWords: 4,
      toolCalls: 4,
      snapshotsPerCall: 10,
      midRunText: 2,
      suffixWords: 4,
    });

    const { flushed } = replay(fixture, 200);

    const toolFrames = flushed.filter((f) => f.event === 'tool_call');
    const toolIds = toolFrames.map((f) => f.tool_call_id);
    expect(new Set(toolIds).size).toBe(toolIds.length); // unique
    expect(toolIds).toHaveLength(4);

    // Each emitted tool_call should be the *terminal* snapshot — the
    // longest path string for its id.
    for (let i = 0; i < 4; i++) {
      const expected = `/opt/stacks/letta-mobile/src/file-${i}.ts`;
      const tc = toolFrames.find((f) => f.tool_call_id === `tc-${i}`)!;
      const got = (tc.tool_input as { file_path?: string }).file_path;
      expect(got).toBe(expected);
      expect(tc.status).toBe('completed');
    }
  });

  it('preserves text↔tool ordering across a turn with interleaving', () => {
    const fixture = buildChattyTurn({
      requestId: 'golden-3',
      prefixWords: 3,
      toolCalls: 2,
      snapshotsPerCall: 4,
      midRunText: 3,
      suffixWords: 2,
    });

    const { flushed } = replay(fixture, 200);

    // Build the *event-sequence* (drop content) for both raw and flushed.
    // Tool_call snapshots collapse to 1; consecutive text events collapse.
    const collapse = (xs: StreamFrame[]): string[] => {
      const out: string[] = [];
      const seenTC = new Set<string>();
      for (let i = xs.length - 1; i >= 0; i--) {
        const f = xs[i];
        if (f.event === 'tool_call') {
          const id = String(f.tool_call_id ?? '');
          if (seenTC.has(id)) continue;
          seenTC.add(id);
          out.unshift(`tool_call:${id}`);
        } else {
          const tag =
            f.event === 'assistant' || f.event === 'reasoning'
              ? f.event
              : `${f.event}:${String(f.tool_call_id ?? '')}`;
          if (out[0] !== tag || (f.event !== 'assistant' && f.event !== 'reasoning')) {
            out.unshift(tag);
          }
        }
      }
      // Re-collapse adjacent same-event text after the reverse pass.
      const collapsed: string[] = [];
      for (const tag of out) {
        if (
          collapsed.length > 0 &&
          collapsed[collapsed.length - 1] === tag &&
          (tag === 'assistant' || tag === 'reasoning')
        ) {
          continue;
        }
        collapsed.push(tag);
      }
      return collapsed;
    };

    expect(collapse(flushed)).toEqual(collapse(fixture));
  });

  it('two interleaved request_ids on one connection coalesce independently', () => {
    const reqA = buildChattyTurn({
      requestId: 'turn-A',
      prefixWords: 20,
      toolCalls: 1,
      snapshotsPerCall: 5,
      midRunText: 2,
      suffixWords: 5,
    });
    const reqB = buildChattyTurn({
      requestId: 'turn-B',
      prefixWords: 15,
      toolCalls: 1,
      snapshotsPerCall: 5,
      midRunText: 2,
      suffixWords: 5,
    });

    // Interleave: alternate one frame from each stream.
    const interleaved: FixtureFrame[] = [];
    const max = Math.max(reqA.length, reqB.length);
    for (let i = 0; i < max; i++) {
      if (i < reqA.length) interleaved.push(reqA[i]);
      if (i < reqB.length) interleaved.push(reqB[i]);
    }

    const { flushed } = replay(interleaved, 200);

    // Per-request canonical form must match per-request fixture canon.
    const aFrames = flushed.filter((f) => f.request_id === 'turn-A');
    const bFrames = flushed.filter((f) => f.request_id === 'turn-B');
    expect(canonicalize(aFrames)).toBe(canonicalize(reqA));
    expect(canonicalize(bFrames)).toBe(canonicalize(reqB));

    // And both saw real reduction.
    expect(aFrames.length).toBeLessThan(reqA.length);
    expect(bFrames.length).toBeLessThan(reqB.length);
  });

  it('reasoning deltas coalesce alongside assistant deltas without crossover', () => {
    const reqId = 'mixed-1';
    const frames: FixtureFrame[] = [];
    // 5 reasoning, 5 assistant, 5 reasoning — must NOT merge across the
    // assistant block.
    for (let i = 0; i < 5; i++)
      frames.push({ type: 'stream', event: 'reasoning', content: `r${i}-`, request_id: reqId });
    for (let i = 0; i < 5; i++)
      frames.push({ type: 'stream', event: 'assistant', content: `a${i}-`, request_id: reqId });
    for (let i = 0; i < 5; i++)
      frames.push({ type: 'stream', event: 'reasoning', content: `r${i + 5}-`, request_id: reqId });

    const { flushed } = replay(frames, 200);

    expect(flushed.map((f) => f.event)).toEqual(['reasoning', 'assistant', 'reasoning']);
    expect(flushed[0].content).toBe('r0-r1-r2-r3-r4-');
    expect(flushed[1].content).toBe('a0-a1-a2-a3-a4-');
    expect(flushed[2].content).toBe('r5-r6-r7-r8-r9-');
  });
});
