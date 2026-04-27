/**
 * Envelope guard — defensive sanitizer for outbound channel text.
 *
 * The bot wraps every inbound user message in a `<system-reminder>...
 * </system-reminder>` envelope (see `formatMessageEnvelope`/
 * `formatGroupBatchEnvelope` in core/formatter.ts). That wrapper carries
 * agent-only context (channel hints, response directives, session info)
 * and is meant to be invisible to end users. If a code path ever echoes
 * inbound text back as outbound text (replay/retry queue, an agent
 * memorizing+regurgitating the prompt, a stringified envelope landing
 * on the channel-send call), the wrapper leaks into the chat as visible
 * noise.
 *
 * This module is the last line of defense before
 * `adapter.sendMessage` / `adapter.editMessage` actually hits the wire.
 * It runs after redaction and:
 *
 *   1. Strips any `<system-reminder>...</system-reminder>` blocks
 *      (greedy across the open/close tags, multi-line),
 *   2. Trims surrounding whitespace from the strip site so we don't
 *      leave a wedge of blank lines,
 *   3. Reports each strip via the supplied logger so we can spot
 *      regressions even if the text downstream looks clean.
 *
 * Tracking: lettabot-y4j (Doubled messages + LettaBot envelope leaking
 * into chat).
 */

import { SYSTEM_REMINDER_OPEN, SYSTEM_REMINDER_CLOSE } from './formatter.js';

/**
 * Matches a complete `<system-reminder>...</system-reminder>` block.
 * Multi-line / dot-all so the regex spans the metadata + chat-context
 * sections built by formatMessageEnvelope.
 */
const ENVELOPE_BLOCK_RE = new RegExp(
  `${escapeRegex(SYSTEM_REMINDER_OPEN)}[\\s\\S]*?${escapeRegex(SYSTEM_REMINDER_CLOSE)}`,
  'g',
);

/** Stand-alone open or close tags (no matching pair) — defensive sweep. */
const ENVELOPE_TAG_RE = new RegExp(
  `${escapeRegex(SYSTEM_REMINDER_OPEN)}|${escapeRegex(SYSTEM_REMINDER_CLOSE)}`,
  'g',
);

export interface EnvelopeGuardResult {
  /** Sanitized text, safe to send to the channel. */
  text: string;
  /** Number of complete envelope blocks stripped. */
  blockMatches: number;
  /** Number of orphan tag occurrences stripped (post-block sweep). */
  tagMatches: number;
}

/**
 * Strip system-reminder envelope blocks from outbound text.
 * Returns the cleaned text plus counts so the caller can decide
 * whether to log/alert.
 */
export function stripEnvelope(text: string): EnvelopeGuardResult {
  if (!text) return { text, blockMatches: 0, tagMatches: 0 };

  // Cheap pre-check: skip the regex entirely for the common case where
  // no envelope marker is present.
  if (!text.includes(SYSTEM_REMINDER_OPEN) && !text.includes(SYSTEM_REMINDER_CLOSE)) {
    return { text, blockMatches: 0, tagMatches: 0 };
  }

  let blockMatches = 0;
  let cleaned = text.replace(ENVELOPE_BLOCK_RE, () => {
    blockMatches += 1;
    return '';
  });

  let tagMatches = 0;
  cleaned = cleaned.replace(ENVELOPE_TAG_RE, () => {
    tagMatches += 1;
    return '';
  });

  // Collapse runs of 3+ newlines we may have created by removing a
  // block in the middle of the text.
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return { text: cleaned, blockMatches, tagMatches };
}

/**
 * Convenience wrapper: strip envelope blocks and emit a warning via
 * `logWarn` whenever something was stripped. Returns the cleaned text.
 *
 * Intended for use inside the outbound-adapter wrappers in
 * `Bot.registerChannel`, after `redactOutbound`.
 */
export function guardOutbound(
  text: string,
  logWarn?: (msg: string) => void,
): string {
  const result = stripEnvelope(text);
  if (logWarn && (result.blockMatches > 0 || result.tagMatches > 0)) {
    logWarn(
      `[envelope-guard] stripped system-reminder from outbound text ` +
        `(blocks=${result.blockMatches}, orphan_tags=${result.tagMatches}). ` +
        `This indicates an upstream bug — the agent's reply contained the ` +
        `inbound envelope. See lettabot-y4j.`,
    );
  }
  return result.text;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
