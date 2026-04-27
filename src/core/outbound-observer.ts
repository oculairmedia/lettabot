/**
 * Outbound observer — structured logging + near-duplicate detection at the
 * channel-send boundary.
 *
 * Tracking: lettabot-y4j (Doubled messages + LettaBot envelope leaking
 * into chat) — Phase 2.
 *
 * The bead's Phase 1 shipped the envelope-guard (see envelope-guard.ts).
 * The remaining symptom — *doubled* assistant messages reaching the chat —
 * is not visible in the gateway frame-level e2e matrix, which means the
 * doubling happens downstream of the gateway: somewhere between bot core
 * and the actual channel adapter `sendMessage` / `editMessage` call, or
 * via a retry/replay path inside the channel layer itself.
 *
 * To localise that without instrumenting every adapter, we add a tiny
 * observer at the LAST common boundary (the wrapped `sendMessage` /
 * `editMessage` installed by `Bot.registerChannel`). For every outbound
 * call we:
 *
 *   1. Emit a structured log line:
 *        [outbound] channel=<id> chat=<id> kind=<send|edit> len=<n>
 *                   text_hash=<sha1-hex16> [edit_msg=<id>]
 *      This lets ops grep logs and find duplicate hashes per chat in a
 *      single command — no bridge instrumentation, no UI capture needed.
 *
 *   2. Run an LRU near-duplicate detector keyed by
 *      `${channel}|${chatId}|${kind}|${text_hash}`. If we saw the same
 *      key within the configured window (default 5s), we emit a WARN
 *      with the time delta and a reference to lettabot-y4j. This makes
 *      the bug self-fingerprinting in the wild — the *next* time a user
 *      sees a doubled message, the warn is already in the logs.
 *
 * The observer never blocks or modifies the outbound payload; this is
 * pure observation. Behaviour-changing dedup (e.g. dropping the second
 * send) is intentionally NOT done here — root-causing first, mitigating
 * second, per the bead's investigation plan.
 *
 * Memory budget: bounded LRU of N entries (default 256) per process.
 * Each entry is ~100 bytes, so worst case ~25KB.
 */

import { createHash } from 'node:crypto';

export type OutboundKind = 'send' | 'edit';

export interface OutboundObservation {
  channel: string;
  chatId: string;
  text: string;
  kind: OutboundKind;
  /** Optional: target message ID for `edit` kind. Included in the log line
   *  but NOT part of the dedup key — an edit-with-same-text to the same
   *  chat is still a suspicious duplicate. */
  editMessageId?: string;
}

export interface OutboundObserverOptions {
  /** Window (ms) in which a repeat hash on the same chat is flagged as a
   *  duplicate. Default 5000ms. */
  windowMs?: number;
  /** Max LRU entries. Default 256. */
  maxEntries?: number;
  /** Logger hooks. Both default to no-op (silent). */
  logInfo?: (line: string) => void;
  logWarn?: (line: string) => void;
  /** Clock injection for tests. */
  now?: () => number;
}

export interface ObserveResult {
  /** SHA1-prefix hash of the outbound text (16 hex chars). */
  textHash: string;
  /** True if this exact (channel, chat, kind, hash) was seen within
   *  windowMs of the previous occurrence. */
  duplicate: boolean;
  /** ms since previous matching observation, or undefined if first. */
  sinceMs?: number;
}

interface Entry {
  key: string;
  ts: number;
}

/**
 * Stateful observer for outbound channel sends. One instance per Bot.
 */
export class OutboundObserver {
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly logInfo: (line: string) => void;
  private readonly logWarn: (line: string) => void;
  private readonly now: () => number;

  /** Insertion-ordered map = LRU when we delete on hit + re-insert. */
  private readonly seen = new Map<string, Entry>();

  constructor(opts: OutboundObserverOptions = {}) {
    this.windowMs = opts.windowMs ?? 5000;
    this.maxEntries = opts.maxEntries ?? 256;
    this.logInfo = opts.logInfo ?? (() => {});
    this.logWarn = opts.logWarn ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Record an outbound observation. Always emits a structured info log;
   * emits a warn log additionally when a near-duplicate is detected.
   * Pure observation — never throws, never mutates input.
   */
  observe(obs: OutboundObservation): ObserveResult {
    const text = obs.text ?? '';
    const textHash = hashText(text);
    const len = text.length;
    const key = `${obs.channel}|${obs.chatId}|${obs.kind}|${textHash}`;
    const ts = this.now();

    // Structured info line — easy to grep, single-line, stable field order.
    const editTail = obs.kind === 'edit' && obs.editMessageId
      ? ` edit_msg=${obs.editMessageId}`
      : '';
    this.logInfo(
      `[outbound] channel=${obs.channel} chat=${obs.chatId} ` +
        `kind=${obs.kind} len=${len} text_hash=${textHash}${editTail}`,
    );

    // Empty text is never a meaningful duplicate (channel adapters drop
    // empty sends anyway) — record but don't warn.
    if (len === 0) {
      this.touch(key, ts);
      return { textHash, duplicate: false };
    }

    const prev = this.seen.get(key);
    let duplicate = false;
    let sinceMs: number | undefined;
    if (prev !== undefined) {
      sinceMs = ts - prev.ts;
      if (sinceMs <= this.windowMs) {
        duplicate = true;
        this.logWarn(
          `[outbound-dup] suspected duplicate send within ${sinceMs}ms ` +
            `channel=${obs.channel} chat=${obs.chatId} kind=${obs.kind} ` +
            `len=${len} text_hash=${textHash}${editTail}. ` +
            `See lettabot-y4j (doubled-messages investigation).`,
        );
      }
    }

    this.touch(key, ts);
    return { textHash, duplicate, sinceMs };
  }

  /** Clear all state (test hook). */
  reset(): void {
    this.seen.clear();
  }

  /** Number of tracked entries (test hook). */
  size(): number {
    return this.seen.size;
  }

  private touch(key: string, ts: number): void {
    // LRU: delete-then-set so the entry is re-inserted at the tail.
    if (this.seen.has(key)) this.seen.delete(key);
    this.seen.set(key, { key, ts });

    // Evict from the head until under budget. Map iterates in insertion
    // order, so the first key is the oldest.
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}

/**
 * Stable, short, dependency-free hash for the structured log + dedup key.
 * sha1 truncated to 16 hex chars — good enough for collision avoidance
 * within a 256-entry sliding window without dragging in a hash crate.
 */
export function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}
