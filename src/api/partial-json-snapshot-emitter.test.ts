/**
 * Integration test for PartialJsonSnapshotEmitter (lettabot-uww.4).
 *
 * Drives the emitter with realistic SDK-shaped fragment streams and
 * asserts:
 *   - Progressive `running` snapshots are emitted with strictly
 *     growing parsed values.
 *   - Dedupe: identical-extension buffers do not re-emit.
 *   - Final `completed` snapshot is always emitted on finalize().
 *   - Multiple concurrent tool_call_ids interleave correctly.
 *   - Cumulative + delta SDK chunking shapes both work.
 */

import { describe, expect, it } from 'vitest';
import {
  PartialJsonSnapshotEmitter,
  type SnapshotEmission,
} from './partial-json-snapshot-emitter.js';

function collect(): {
  emissions: SnapshotEmission[];
  emitter: PartialJsonSnapshotEmitter;
  warnings: string[];
} {
  const emissions: SnapshotEmission[] = [];
  const warnings: string[] = [];
  const emitter = new PartialJsonSnapshotEmitter({
    onSnapshot: (e) => emissions.push(e),
    logWarning: (m) => warnings.push(m),
  });
  return { emissions, emitter, warnings };
}

describe('PartialJsonSnapshotEmitter — progressive snapshots', () => {
  it('emits running snapshots that grow as args stream in', () => {
    const { emitter, emissions } = collect();
    const id = 'tc_1';

    // Fragment 1: incomplete key — should not emit anything (parses to {}).
    // Actually it does parse to {}, but lastEmittedValue is null so we
    // emit one running({}) frame.
    emitter.appendArgs(id, '{"file_p');
    // Fragment 2: complete first key+value, partial second key.
    emitter.appendArgs(id, 'ath": "/tmp/x');
    // Fragment 3: complete first value, start of second.
    emitter.appendArgs(id, '.txt", "content');
    // Fragment 4: partial second value.
    emitter.appendArgs(id, '": "hello');
    // Fragment 5: full close.
    emitter.appendArgs(id, ' world"}');
    // Finalize: terminal completed frame.
    emitter.finalize(id);

    const values = emissions.map((e) => e.value);
    const statuses = emissions.map((e) => e.status);

    // First emission: empty parse (just `{`) — value === {}
    expect(values[0]).toEqual({});
    // Each subsequent running emission must extend (≥ keys of previous).
    for (let i = 1; i < emissions.length - 1; i++) {
      const prev = values[i - 1] as Record<string, unknown>;
      const cur = values[i] as Record<string, unknown>;
      for (const k of Object.keys(prev)) {
        // Either the key is still present (possibly with extended value),
        // or it dropped because the parser couldn't reconfirm — in
        // practice for forward-extending streams this never happens.
        expect(Object.prototype.hasOwnProperty.call(cur, k)).toBe(true);
      }
    }
    // Last emission must be completed.
    expect(statuses[statuses.length - 1]).toBe('completed');
    // Every other emission must be running.
    for (let i = 0; i < statuses.length - 1; i++) {
      expect(statuses[i]).toBe('running');
    }
    // Final value must be the full args object.
    expect(values[values.length - 1]).toEqual({
      file_path: '/tmp/x.txt',
      content: 'hello world',
    });
  });

  it('dedupes identical-extension fragments (no parse-extension → no emit)', () => {
    const { emitter, emissions } = collect();
    const id = 'tc_dup';

    // First parse: emits running({}).
    emitter.appendArgs(id, '{');
    // Whitespace doesn't extend the parse — should NOT re-emit.
    emitter.appendArgs(id, '  ');
    emitter.appendArgs(id, '\n');
    // Now actually extend.
    emitter.appendArgs(id, '"a": 1}');
    emitter.finalize(id);

    // We expect at most: running({}) then running({a:1}) then completed({a:1}).
    // The whitespace-only appends must NOT add any frame.
    const running = emissions.filter((e) => e.status === 'running');
    expect(running.length).toBeLessThanOrEqual(2);
    // Specifically: no two consecutive running frames have the same value.
    for (let i = 1; i < running.length; i++) {
      expect(running[i].value).not.toEqual(running[i - 1].value);
    }
    expect(emissions[emissions.length - 1].status).toBe('completed');
    expect(emissions[emissions.length - 1].value).toEqual({ a: 1 });
  });

  it('emits terminal completed even if buffer never extended past empty', () => {
    const { emitter, emissions, warnings } = collect();
    const id = 'tc_empty';

    emitter.appendArgs(id, '{');
    emitter.finalize(id);

    // running({}) + completed({}) — and the partial-not-complete warning.
    expect(emissions.map((e) => e.status)).toEqual(['running', 'completed']);
    expect(emissions[1].value).toEqual({});
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('did not parse complete');
  });

  it('handles cumulative SDK chunking (each fragment includes prior text)', () => {
    const { emitter, emissions } = collect();
    const id = 'tc_cum';

    emitter.appendArgs(id, '{"k": ');
    emitter.appendArgs(id, '{"k": "v');
    emitter.appendArgs(id, '{"k": "value"}');
    emitter.finalize(id);

    const last = emissions[emissions.length - 1];
    expect(last.status).toBe('completed');
    expect(last.value).toEqual({ k: 'value' });
  });

  it('handles delta SDK chunking (each fragment is appended)', () => {
    const { emitter, emissions } = collect();
    const id = 'tc_delta';

    emitter.appendArgs(id, '{"k": ');
    emitter.appendArgs(id, '"v');
    emitter.appendArgs(id, 'alue"}');
    emitter.finalize(id);

    const last = emissions[emissions.length - 1];
    expect(last.status).toBe('completed');
    expect(last.value).toEqual({ k: 'value' });
  });

  it('interleaves multiple concurrent tool_call_ids correctly', () => {
    const { emitter, emissions } = collect();

    emitter.appendArgs('a', '{"x": 1');
    emitter.appendArgs('b', '{"y": 2');
    emitter.appendArgs('a', ', "x2": 11');
    emitter.appendArgs('b', ', "y2": 22');
    emitter.appendArgs('a', '}');
    emitter.appendArgs('b', '}');
    emitter.finalize('a');
    emitter.finalize('b');

    const aFrames = emissions.filter((e) => e.id === 'a');
    const bFrames = emissions.filter((e) => e.id === 'b');

    expect(aFrames[aFrames.length - 1]).toMatchObject({
      status: 'completed',
      value: { x: 1, x2: 11 },
    });
    expect(bFrames[bFrames.length - 1]).toMatchObject({
      status: 'completed',
      value: { y: 2, y2: 22 },
    });
  });

  it('finalize on never-seen id is a no-op and returns false', () => {
    const { emitter, emissions } = collect();
    const ok = emitter.finalize('ghost');
    expect(ok).toBe(false);
    expect(emissions).toEqual([]);
  });

  it('clear() drops per-id state', () => {
    const { emitter } = collect();
    emitter.appendArgs('x', '{"a": 1}');
    expect(emitter.has('x')).toBe(true);
    emitter.clear();
    expect(emitter.has('x')).toBe(false);
  });

  it('logs warning when terminal buffer parses incomplete', () => {
    const { emitter, warnings } = collect();
    emitter.appendArgs('id', '{"a": "unclosed');
    emitter.finalize('id');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('did not parse complete');
  });

  it('does not log warning when terminal buffer parses complete', () => {
    const { emitter, warnings } = collect();
    emitter.appendArgs('id', '{"a": "closed"}');
    emitter.finalize('id');
    expect(warnings).toEqual([]);
  });

  it('rawArgs on emission carries the buffer (lets caller fallback to {raw})', () => {
    const { emitter, emissions } = collect();
    emitter.appendArgs('id', '{"a": "x"}');
    emitter.finalize('id');
    const last = emissions[emissions.length - 1];
    expect(last.rawArgs).toBe('{"a": "x"}');
  });
});

describe('PartialJsonSnapshotEmitter — coalescer interaction', () => {
  it('progressive snapshots have monotonically-extending content for typical streams', () => {
    // Drive a realistic 30-fragment stream and assert the emitter
    // produces N snapshots where each snapshot's tool_input is a
    // structural superset of the previous one.
    const { emitter, emissions } = collect();
    const id = 'realistic';

    // Build a complete JSON object incrementally, character by character.
    const complete = '{"file_path": "/tmp/test.txt", "content": "Hello, world!\\n", "mode": "w"}';
    let pos = 0;
    while (pos < complete.length) {
      // Random-ish chunk size 1-8 chars
      const chunk = complete.slice(pos, pos + 1 + (pos % 7));
      emitter.appendArgs(id, chunk);
      pos += chunk.length;
    }
    emitter.finalize(id);

    const running = emissions.filter((e) => e.status === 'running');
    // For each consecutive pair of running emissions, the parsed value
    // of the later one must contain at least the keys of the earlier
    // one (note: values may grow but keys never disappear in a forward
    // extending stream).
    for (let i = 1; i < running.length; i++) {
      const prevKeys = Object.keys(running[i - 1].value);
      const curKeys = Object.keys(running[i].value);
      for (const k of prevKeys) {
        expect(curKeys).toContain(k);
      }
    }
    // Final completed frame must have all three keys.
    const last = emissions[emissions.length - 1];
    expect(last.status).toBe('completed');
    expect(last.value).toEqual({
      file_path: '/tmp/test.txt',
      content: 'Hello, world!\n',
      mode: 'w',
    });
  });
});
