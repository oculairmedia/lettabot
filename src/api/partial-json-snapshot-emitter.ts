/**
 * PartialJsonSnapshotEmitter — drives progressive `tool_call` snapshot
 * emission from a stream of `rawArguments` text fragments.
 *
 * This is the outbound side of the partial-JSON tool_call flow
 * documented in docs/architecture/partial-json-tool-args.md §3. It is
 * deliberately decoupled from `WsGateway` so it can be unit-tested
 * without a live WebSocket.
 *
 * Lifecycle per `tool_call_id`:
 *
 *   1. `appendArgs(id, fragment)` is called for every SDK
 *      `tool_call` event with the `rawArguments` text of that event.
 *      The emitter merges the fragment into a per-id buffer (handling
 *      both delta and cumulative chunking), runs
 *      `parsePartialJsonObject(buffer)`, and if the parsed value is
 *      structurally distinct from the last emission, calls the
 *      `onSnapshot` callback with `status='running'`.
 *
 *   2. `finalize(id)` is called when a type boundary signals the call
 *      is complete. The emitter parses the final buffer once more and
 *      calls `onSnapshot` with `status='completed'`. The terminal
 *      frame is always emitted, even if the parsed value is identical
 *      to the last running emission — clients need the status
 *      transition.
 *
 *   3. `clear()` resets per-id state at end of stream.
 *
 * The BotStreamCoalescer's replace-by-id rule absorbs the per-byte
 * snapshot noise on the wire, so the emitter is free to call
 * `onSnapshot` liberally during streaming.
 */

import { parsePartialJsonObject } from './partial-json.js';

export type SnapshotStatus = 'running' | 'completed';

export interface SnapshotEmission {
  /** Tool call id. */
  id: string;
  /** Parsed args value at this snapshot. */
  value: Record<string, unknown>;
  /** Lifecycle marker. */
  status: SnapshotStatus;
  /**
   * Raw accumulated buffer at emission time. Lets the caller fall
   * back to `{raw: <string>}` if a downstream consumer cannot render
   * an empty parsed value.
   */
  rawArgs: string;
}

export type SnapshotCallback = (emission: SnapshotEmission) => void;

interface PerIdState {
  buffer: string;
  lastEmittedValue: Record<string, unknown> | null;
}

export class PartialJsonSnapshotEmitter {
  private readonly state = new Map<string, PerIdState>();
  private readonly onSnapshot: SnapshotCallback;
  private readonly logWarning: (msg: string) => void;

  constructor(opts: {
    onSnapshot: SnapshotCallback;
    /** Optional logger for terminal-buffer-incomplete warnings. */
    logWarning?: (msg: string) => void;
  }) {
    this.onSnapshot = opts.onSnapshot;
    this.logWarning = opts.logWarning ?? (() => {});
  }

  /**
   * Append a `rawArguments` fragment for `id` and (if the merged
   * buffer parses) emit a `running` snapshot if the parsed value is
   * structurally distinct from the previous emission.
   */
  appendArgs(id: string, fragment: string): void {
    const cur = this.state.get(id);
    if (cur) {
      cur.buffer = mergeArgs(cur.buffer, fragment);
    } else {
      this.state.set(id, { buffer: fragment, lastEmittedValue: null });
    }

    const st = this.state.get(id)!;
    if (!st.buffer) return;

    const parsed = parsePartialJsonObject(st.buffer);
    if (!parsed) return;

    if (
      st.lastEmittedValue !== null &&
      structuralEqual(st.lastEmittedValue, parsed.value)
    ) {
      return; // dedupe — buffer grew but parse didn't extend
    }

    st.lastEmittedValue = parsed.value;
    this.onSnapshot({
      id,
      value: parsed.value,
      status: 'running',
      rawArgs: st.buffer,
    });
  }

  /**
   * Mark the call complete. Emits a terminal `completed` snapshot
   * with the final parsed value (always emits, even on no-op
   * extension, so clients receive the lifecycle transition).
   * Returns true if a terminal snapshot was emitted, false if the
   * id was never seen.
   */
  finalize(id: string): boolean {
    const st = this.state.get(id);
    if (!st) return false;

    let finalValue: Record<string, unknown> = {};
    if (st.buffer) {
      const parsed = parsePartialJsonObject(st.buffer);
      if (parsed) {
        if (!parsed.complete) {
          this.logWarning(
            `[partial-json] terminal buffer for tool_call ${id.slice(0, 8)} did not parse complete; emitting partial value`,
          );
        }
        finalValue = parsed.value;
      }
    }

    this.onSnapshot({
      id,
      value: finalValue,
      status: 'completed',
      rawArgs: st.buffer,
    });

    return true;
  }

  /** Drop all per-id state (e.g. at stream end). */
  clear(): void {
    this.state.clear();
  }

  /** For diagnostics / testing. */
  has(id: string): boolean {
    return this.state.has(id);
  }
}

/**
 * Merge tool_call argument fragments. SDK chunking can be either:
 *   - cumulative (each fragment is prior + delta), or
 *   - delta (each fragment is just the new chars).
 * We detect by prefix and act accordingly. Identical fragments are
 * idempotent.
 */
function mergeArgs(existing: string, incoming: string): string {
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (incoming === existing) return existing;
  if (incoming.startsWith(existing)) return incoming; // cumulative
  if (existing.endsWith(incoming)) return existing; // duplicate tail
  return `${existing}${incoming}`; // delta
}

/**
 * Structural deep-equality on JSON-shaped values. Mirrors the helper
 * inlined in ws-gateway.ts; kept here as a private to keep this
 * module self-contained.
 */
function structuralEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!structuralEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!structuralEqual(ao[k], bo[k])) return false;
  }
  return true;
}
