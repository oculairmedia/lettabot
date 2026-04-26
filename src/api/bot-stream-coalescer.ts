/**
 * BotStreamCoalescer — server-side WS stream coalescing.
 *
 * Sits between the gateway's per-event emission and the WebSocket send.
 * Reduces wire frame count by:
 *   1. Concatenating consecutive text deltas (assistant, reasoning) of the
 *      same request_id within a 200ms window.
 *   2. Replacing tool_call snapshots by tool_call_id (latest wins), with
 *      immediate flush on terminal status.
 *   3. Pass-through for all other event types (tool_result, result, errors,
 *      system events) — these always trigger a full flush of pending
 *      entries first to preserve order.
 *
 * Wire contract is unchanged: clients see the same frame shape, just fewer
 * and larger frames.
 *
 * Design doc: docs/architecture/bot-stream-coalescer.md
 *
 * NOTE: This module is a clean-room reimplementation of the pattern
 * described in getpaseo/paseo's AgentStreamCoalescer. It does not import
 * or copy any code from that AGPL project.
 */

/** A wire frame as emitted by the gateway's `this.send(ws, frame)`. */
export interface StreamFrame {
  type: 'stream';
  event: string;
  /** request_id used for per-request scoping; identical to ClientMessage.request_id. */
  request_id?: string;
  /** Free-form payload — the coalescer only inspects fields it knows about. */
  [key: string]: unknown;
}

/** Subset of frames the coalescer treats as text deltas (concat-able). */
type TextEvent = 'assistant' | 'reasoning';

/** Tool-call status as seen on the wire. May be absent on partial snapshots. */
type ToolCallStatus = 'running' | 'completed' | 'failed' | 'canceled' | undefined;

/** Internal buffered entry. Order is preserved within a request's buffer. */
type BufferedEntry =
  | { kind: 'text'; event: TextEvent; frame: StreamFrame }
  | { kind: 'tool'; tool_call_id: string; frame: StreamFrame }
  | { kind: 'other'; frame: StreamFrame };

interface RequestState {
  /** Insertion-ordered list of buffered entries. */
  buffer: BufferedEntry[];
  /** tool_call_id → index into `buffer` for replace-by-id semantics. */
  toolIndex: Map<string, number>;
  /** Pending flush timer; null when none scheduled. */
  timer: ReturnType<typeof setTimeout> | null;
}

/** Optional injectable timers — used by tests to drive fake timers. */
export interface CoalescerTimers {
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface BotStreamCoalescerOptions {
  /** Window in ms before a text-only buffer is flushed automatically. */
  windowMs?: number;
  /** Sink for flushed frames. Called once per frame in insertion order. */
  onFlush: (frame: StreamFrame) => void;
  /** Override timers (defaults to global setTimeout/clearTimeout). */
  timers?: CoalescerTimers;
}

/** Default flush window. Matches paseo's default; tunable per design doc. */
export const DEFAULT_COALESCE_WINDOW_MS = 200;

/** Frames that carry text-delta semantics (concat-able). */
const TEXT_EVENTS: ReadonlySet<string> = new Set(['assistant', 'reasoning']);

/** Tool-call statuses that should trigger an immediate flush when observed. */
const TERMINAL_TOOL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'canceled',
]);

/**
 * Resolve a request key. Coalescing is scoped per request_id, but legitimate
 * frames may omit it (system events, errors). Use a sentinel for those so
 * they share a single buffer rather than colliding with real requests.
 */
const NO_REQUEST_KEY = '__no_request__';

function requestKey(frame: StreamFrame): string {
  return typeof frame.request_id === 'string' && frame.request_id.length > 0
    ? frame.request_id
    : NO_REQUEST_KEY;
}

function isTextEvent(event: string): event is TextEvent {
  return TEXT_EVENTS.has(event);
}

function getToolCallId(frame: StreamFrame): string | null {
  const id = frame.tool_call_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function getToolStatus(frame: StreamFrame): ToolCallStatus {
  const status = frame.status;
  if (typeof status !== 'string') return undefined;
  if (status === 'running' || status === 'completed' || status === 'failed' || status === 'canceled') {
    return status;
  }
  return undefined;
}

/**
 * Concatenate the `content` field of two text frames into a new frame.
 * Preserves the *first* frame's metadata (event, uuid, request_id, etc.)
 * because that's what the client first saw arrive — keeping uuid stable
 * matters for downstream correlation.
 */
function concatTextFrame(prior: StreamFrame, incoming: StreamFrame): StreamFrame {
  const priorContent = typeof prior.content === 'string' ? prior.content : '';
  const incomingContent = typeof incoming.content === 'string' ? incoming.content : '';
  return {
    ...prior,
    content: priorContent + incomingContent,
  };
}

/**
 * Server-side stream coalescer. One instance per WS connection; events for
 * different request_ids on the same connection are isolated internally.
 *
 * Lifecycle per request:
 *   1. handle(frame) for each event in the stream.
 *   2. flushFor(requestId) when the request stream ends naturally.
 *   3. flushAndDiscard(requestId) on abort/cancel.
 *
 * Lifecycle on shutdown:
 *   - flushAll() to drain everything.
 */
export class BotStreamCoalescer {
  private readonly windowMs: number;
  private readonly onFlush: (frame: StreamFrame) => void;
  private readonly timers: CoalescerTimers;
  private readonly states = new Map<string, RequestState>();
  private disposed = false;

  constructor(options: BotStreamCoalescerOptions) {
    this.windowMs = options.windowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    this.onFlush = options.onFlush;
    this.timers = options.timers ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => clearTimeout(h),
    };
  }

  /**
   * Submit an outbound frame for coalescing. The coalescer decides whether
   * to buffer it, merge it with a buffered entry, or flush immediately.
   */
  handle(frame: StreamFrame): void {
    if (this.disposed) {
      // Disposed coalescer is best-effort: pass through so we don't drop
      // late-arriving frames after a connection close.
      this.onFlush(frame);
      return;
    }

    const key = requestKey(frame);
    const state = this.getOrCreateState(key);

    // Non-stream frames (errors, control) bypass coalescing but flush pending
    // first so order is preserved.
    if (frame.type !== 'stream') {
      this.flushState(key, state);
      this.onFlush(frame);
      return;
    }

    const event = typeof frame.event === 'string' ? frame.event : '';

    if (isTextEvent(event)) {
      this.handleTextDelta(key, state, event, frame);
      this.scheduleFlush(key, state);
      return;
    }

    if (event === 'tool_call') {
      const flushImmediately = this.handleToolCall(state, frame);
      if (flushImmediately) {
        this.flushState(key, state);
      } else {
        this.scheduleFlush(key, state);
      }
      return;
    }

    if (event === 'tool_result') {
      // Snapshot semantics: any pending entries for this request must flush
      // first (so the tool_result follows its tool_call snapshot in order),
      // then the tool_result itself flushes immediately.
      this.flushState(key, state);
      this.onFlush(frame);
      return;
    }

    // Other stream event types (e.g. unrecognized): pass-through after
    // flushing pending so insertion order is preserved.
    this.flushState(key, state);
    this.onFlush(frame);
  }

  /**
   * Flush any pending entries for a single request_id. Use when a request
   * stream ends naturally (terminal frame seen by the caller).
   */
  flushFor(requestId: string | undefined): void {
    const key = requestId && requestId.length > 0 ? requestId : NO_REQUEST_KEY;
    const state = this.states.get(key);
    if (!state) return;
    this.flushState(key, state);
  }

  /**
   * Drop all pending entries for a single request_id without flushing them.
   * Use when an abort/cancel makes the buffered output meaningless.
   */
  flushAndDiscard(requestId: string | undefined): void {
    const key = requestId && requestId.length > 0 ? requestId : NO_REQUEST_KEY;
    const state = this.states.get(key);
    if (!state) return;
    if (state.timer) {
      this.timers.clearTimeout(state.timer);
    }
    this.states.delete(key);
  }

  /**
   * Flush every pending request. Use on connection close / server shutdown.
   * Does *not* dispose; the coalescer can still accept new frames after.
   */
  flushAll(): void {
    for (const [key, state] of Array.from(this.states.entries())) {
      this.flushState(key, state);
    }
  }

  /**
   * Dispose: flush everything, mark disposed, prevent further buffering.
   * After this, handle() falls back to pass-through and timers are no-ops.
   */
  dispose(): void {
    if (this.disposed) return;
    this.flushAll();
    this.disposed = true;
  }

  /** Test-only: how many requests have buffered state right now. */
  pendingRequestCount(): number {
    return this.states.size;
  }

  // --- internals ---

  private getOrCreateState(key: string): RequestState {
    let state = this.states.get(key);
    if (!state) {
      state = { buffer: [], toolIndex: new Map(), timer: null };
      this.states.set(key, state);
    }
    return state;
  }

  /**
   * Append or merge a text delta. Merges when the previous *adjacent* entry
   * is a text entry of the same event type. A non-text entry between two
   * text deltas of the same event prevents merging — correct, since the
   * client must see the intervening tool/etc. between them.
   */
  private handleTextDelta(
    _key: string,
    state: RequestState,
    event: TextEvent,
    frame: StreamFrame,
  ): void {
    const last = state.buffer[state.buffer.length - 1];
    if (last && last.kind === 'text' && last.event === event) {
      last.frame = concatTextFrame(last.frame, frame);
      return;
    }
    state.buffer.push({ kind: 'text', event, frame });
  }

  /**
   * Handle a tool_call snapshot. Replaces any prior snapshot for the same
   * tool_call_id. Returns true if the caller should flush immediately
   * (terminal status seen).
   */
  private handleToolCall(state: RequestState, frame: StreamFrame): boolean {
    const id = getToolCallId(frame);
    if (!id) {
      // No id → can't dedupe. Treat as pass-through-with-order: append a
      // unique entry so order is preserved on the next flush.
      state.buffer.push({ kind: 'other', frame });
      return false;
    }

    const existingIndex = state.toolIndex.get(id);
    if (existingIndex !== undefined) {
      // Replace in place — keeps insertion order.
      state.buffer[existingIndex] = { kind: 'tool', tool_call_id: id, frame };
    } else {
      const newIndex = state.buffer.length;
      state.buffer.push({ kind: 'tool', tool_call_id: id, frame });
      state.toolIndex.set(id, newIndex);
    }

    const status = getToolStatus(frame);
    return status !== undefined && TERMINAL_TOOL_STATUSES.has(status);
  }

  private scheduleFlush(key: string, state: RequestState): void {
    if (state.timer) return;
    state.timer = this.timers.setTimeout(() => {
      // Re-fetch in case state was rebuilt; but normally it's the same.
      const current = this.states.get(key);
      if (!current) return;
      current.timer = null;
      this.flushState(key, current);
    }, this.windowMs);
  }

  private flushState(key: string, state: RequestState): void {
    if (state.timer) {
      this.timers.clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.buffer.length === 0) {
      // Empty: still drop the per-request slot so we don't leak Map entries.
      this.states.delete(key);
      return;
    }
    // Snapshot the buffer before draining so onFlush callbacks calling back
    // into handle() (re-entrancy) don't see stale state.
    const drained = state.buffer;
    state.buffer = [];
    state.toolIndex.clear();
    this.states.delete(key);
    for (const entry of drained) {
      this.onFlush(entry.frame);
    }
  }
}
