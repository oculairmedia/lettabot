/**
 * Streaming partial JSON parser for tool_call argument buffers.
 *
 * The Letta SDK emits tool_call argument deltas as raw text fragments —
 * concatenated, those fragments form a complete JSON object only at the end
 * of the tool call. To render progressive tool cards (filename appears,
 * then path, then content) we need to parse what we have so far and return
 * the longest well-formed prefix.
 *
 * This is a hand-rolled recovery parser, not a JSON spec parser:
 *   - Tolerates partial strings (returns chars seen so far).
 *   - Tolerates partial numbers (only if the prefix is unambiguous; bare
 *     `-` is dropped).
 *   - Tolerates partial keywords (`tr` → true, `fa` → false, `nu` → null;
 *     bare `t` / `f` / `n` is ambiguous → drop).
 *   - Drops keys that don't yet have a colon+value.
 *   - Tolerates trailing commas.
 *   - Closes unclosed objects / arrays implicitly.
 *
 * Returns `null` if the input cannot be coerced into a partial JSON object
 * (must start with `{` after whitespace).
 *
 * See docs/architecture/partial-json-tool-args.md §2 for the full
 * specification table.
 */

export type ParseResult = {
  value: Record<string, unknown>;
  complete: boolean;
} | null;

class Cursor {
  constructor(public readonly src: string, public pos: number = 0) {}

  /** Consume whitespace; returns true if any was consumed. */
  skipWs(): void {
    while (this.pos < this.src.length) {
      const c = this.src.charCodeAt(this.pos);
      // space, \t, \n, \r
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
      else break;
    }
  }

  done(): boolean {
    return this.pos >= this.src.length;
  }

  peek(): string {
    return this.src[this.pos] ?? '';
  }
}

/** Parse-result envelope used by internal recursive parsers. */
type Inner =
  | { ok: true; value: unknown; complete: boolean }
  | { ok: false };

const FAIL: Inner = { ok: false };
const NEED_MORE_OBJ: Inner = { ok: true, value: undefined, complete: false };

/**
 * Public entry point.
 */
export function parsePartialJsonObject(input: string): ParseResult {
  if (typeof input !== 'string') return null;

  const cur = new Cursor(input, 0);
  cur.skipWs();
  if (cur.done() || cur.peek() !== '{') return null;

  const out = parseObject(cur);
  if (!out.ok) return null;
  // parseObject always returns an object value or sentinel — narrow.
  if (out.value === undefined) {
    // Object started but no fields parsed yet.
    return { value: {}, complete: false };
  }
  return {
    value: out.value as Record<string, unknown>,
    complete: out.complete,
  };
}

// ---------------------------------------------------------------------------
// Object: { "k1": v1, "k2": v2, ... }
// ---------------------------------------------------------------------------

function parseObject(cur: Cursor): Inner {
  // Caller guarantees we're at '{'.
  cur.pos++;
  const obj: Record<string, unknown> = {};

  while (true) {
    cur.skipWs();
    if (cur.done()) {
      // Unclosed object — implicit close.
      return { ok: true, value: obj, complete: false };
    }

    const c = cur.peek();
    if (c === '}') {
      cur.pos++;
      return { ok: true, value: obj, complete: true };
    }

    // Tolerate leading or repeated commas (trailing-comma case ends here).
    if (c === ',') {
      cur.pos++;
      continue;
    }

    // Must be a key (string).
    if (c !== '"') {
      // Malformed, but partial — just stop here and return what we have.
      return { ok: true, value: obj, complete: false };
    }

    const keyParse = parseString(cur);
    if (!keyParse.ok) return { ok: true, value: obj, complete: false };

    if (!keyParse.complete) {
      // Partial key without closing quote: drop, parse incomplete.
      return { ok: true, value: obj, complete: false };
    }

    const key = keyParse.value as string;

    cur.skipWs();
    if (cur.done() || cur.peek() !== ':') {
      // Key parsed but no colon yet → drop this key, return what we have.
      return { ok: true, value: obj, complete: false };
    }
    cur.pos++; // consume ':'
    cur.skipWs();

    if (cur.done()) {
      // Colon but no value yet — drop key.
      return { ok: true, value: obj, complete: false };
    }

    const valParse = parseValue(cur);
    if (!valParse.ok) {
      // Couldn't even start a value → drop key.
      return { ok: true, value: obj, complete: false };
    }

    if (valParse.value !== undefined) {
      obj[key] = valParse.value;
    }

    if (!valParse.complete) {
      // Value was partial — include what we have and stop.
      return { ok: true, value: obj, complete: false };
    }

    // Look for comma or close-brace.
    cur.skipWs();
    if (cur.done()) {
      return { ok: true, value: obj, complete: false };
    }
    const sep = cur.peek();
    if (sep === ',') {
      cur.pos++;
      continue;
    }
    if (sep === '}') {
      cur.pos++;
      return { ok: true, value: obj, complete: true };
    }
    // Anything else: stop, return partial.
    return { ok: true, value: obj, complete: false };
  }
}

// ---------------------------------------------------------------------------
// Array: [ v1, v2, ... ]
// ---------------------------------------------------------------------------

function parseArray(cur: Cursor): Inner {
  // Caller guarantees we're at '['.
  cur.pos++;
  const arr: unknown[] = [];

  while (true) {
    cur.skipWs();
    if (cur.done()) {
      return { ok: true, value: arr, complete: false };
    }
    const c = cur.peek();
    if (c === ']') {
      cur.pos++;
      return { ok: true, value: arr, complete: true };
    }
    if (c === ',') {
      cur.pos++;
      continue;
    }

    const valParse = parseValue(cur);
    if (!valParse.ok) {
      return { ok: true, value: arr, complete: false };
    }
    if (valParse.value !== undefined) {
      arr.push(valParse.value);
    }
    if (!valParse.complete) {
      return { ok: true, value: arr, complete: false };
    }

    cur.skipWs();
    if (cur.done()) return { ok: true, value: arr, complete: false };
    const sep = cur.peek();
    if (sep === ',') {
      cur.pos++;
      continue;
    }
    if (sep === ']') {
      cur.pos++;
      return { ok: true, value: arr, complete: true };
    }
    return { ok: true, value: arr, complete: false };
  }
}

// ---------------------------------------------------------------------------
// Value dispatch
// ---------------------------------------------------------------------------

function parseValue(cur: Cursor): Inner {
  cur.skipWs();
  if (cur.done()) return FAIL;
  const c = cur.peek();
  if (c === '"') return parseString(cur);
  if (c === '{') return parseObject(cur);
  if (c === '[') return parseArray(cur);
  if (c === '-' || (c >= '0' && c <= '9')) return parseNumber(cur);
  if (c === 't' || c === 'f' || c === 'n') return parseKeyword(cur);
  return FAIL;
}

// ---------------------------------------------------------------------------
// String: "...". Handles \" \\ \/ \b \f \n \r \t \uXXXX. Unrecognized
// escapes are passed through literally (paseo-compatible).
// ---------------------------------------------------------------------------

function parseString(cur: Cursor): Inner {
  // Caller guarantees we're at '"'.
  cur.pos++;
  let out = '';
  while (cur.pos < cur.src.length) {
    const ch = cur.src[cur.pos];
    if (ch === '"') {
      cur.pos++;
      return { ok: true, value: out, complete: true };
    }
    if (ch === '\\') {
      // Escape — must have at least one more char.
      if (cur.pos + 1 >= cur.src.length) {
        // Stopped mid-escape: drop the trailing backslash, return what we have.
        return { ok: true, value: out, complete: false };
      }
      const esc = cur.src[cur.pos + 1];
      switch (esc) {
        case '"':
          out += '"';
          cur.pos += 2;
          break;
        case '\\':
          out += '\\';
          cur.pos += 2;
          break;
        case '/':
          out += '/';
          cur.pos += 2;
          break;
        case 'b':
          out += '\b';
          cur.pos += 2;
          break;
        case 'f':
          out += '\f';
          cur.pos += 2;
          break;
        case 'n':
          out += '\n';
          cur.pos += 2;
          break;
        case 'r':
          out += '\r';
          cur.pos += 2;
          break;
        case 't':
          out += '\t';
          cur.pos += 2;
          break;
        case 'u': {
          // \uXXXX — need 4 hex digits.
          if (cur.pos + 6 > cur.src.length) {
            // Truncated unicode escape — stop.
            return { ok: true, value: out, complete: false };
          }
          const hex = cur.src.slice(cur.pos + 2, cur.pos + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            // Malformed escape — stop, return what we have so far.
            return { ok: true, value: out, complete: false };
          }
          out += String.fromCharCode(parseInt(hex, 16));
          cur.pos += 6;
          break;
        }
        default:
          // Unknown escape — pass through both chars literally.
          out += esc;
          cur.pos += 2;
      }
    } else {
      out += ch;
      cur.pos++;
    }
  }
  // Ran out of input — partial string.
  return { ok: true, value: out, complete: false };
}

// ---------------------------------------------------------------------------
// Number: optional minus, digits, optional .digits, optional eE+-digits.
// If we hit end of input mid-number: keep only if the prefix is a valid
// well-formed number on its own.
// ---------------------------------------------------------------------------

function parseNumber(cur: Cursor): Inner {
  const start = cur.pos;
  if (cur.peek() === '-') cur.pos++;

  // Integer part: at least one digit, OR end of input (so far just "-").
  const intStart = cur.pos;
  while (cur.pos < cur.src.length) {
    const ch = cur.src.charCodeAt(cur.pos);
    if (ch >= 0x30 && ch <= 0x39) cur.pos++;
    else break;
  }
  const hasIntDigits = cur.pos > intStart;

  // Fraction
  let hasFrac = false;
  if (cur.pos < cur.src.length && cur.src[cur.pos] === '.') {
    hasFrac = true;
    cur.pos++;
    while (cur.pos < cur.src.length) {
      const ch = cur.src.charCodeAt(cur.pos);
      if (ch >= 0x30 && ch <= 0x39) cur.pos++;
      else break;
    }
  }

  // Exponent
  let hasExp = false;
  let expHasDigits = false;
  if (
    cur.pos < cur.src.length &&
    (cur.src[cur.pos] === 'e' || cur.src[cur.pos] === 'E')
  ) {
    hasExp = true;
    cur.pos++;
    if (
      cur.pos < cur.src.length &&
      (cur.src[cur.pos] === '+' || cur.src[cur.pos] === '-')
    ) {
      cur.pos++;
    }
    const expStart = cur.pos;
    while (cur.pos < cur.src.length) {
      const ch = cur.src.charCodeAt(cur.pos);
      if (ch >= 0x30 && ch <= 0x39) cur.pos++;
      else break;
    }
    expHasDigits = cur.pos > expStart;
  }

  const text = cur.src.slice(start, cur.pos);

  // No int digits → just `-` or empty → drop.
  if (!hasIntDigits) {
    cur.pos = start; // rewind so caller sees the failure
    return FAIL;
  }

  // Determine completeness: a number is "complete" only if the next char
  // is a clear value-terminator (whitespace, comma, close-bracket, EOF in
  // the sense that JSON.parse(text) accepts it standalone).
  // For partial tolerance: if input ends inside the number, treat as
  // partial unless trailing fragment is a syntactically-complete number.
  const reachedEnd = cur.pos >= cur.src.length;

  // If we're at end of input AND the token might be in-progress (e.g.
  // user has typed "12." or "1e" — exp marker present but no exp digits),
  // we need to decide: include or not.
  const trailingIncomplete =
    reachedEnd && ((hasFrac && text.endsWith('.')) || (hasExp && !expHasDigits));

  if (trailingIncomplete) {
    // Try to keep the integer prefix without the trailing `.` or `e`.
    // Walk back to last fully-formed digit/sign run.
    let backTo = cur.pos;
    while (backTo > start) {
      const ch = cur.src[backTo - 1];
      if (ch === '.' || ch === 'e' || ch === 'E' || ch === '+' || ch === '-') {
        backTo--;
      } else {
        break;
      }
    }
    const safeText = cur.src.slice(start, backTo);
    if (safeText.length === 0 || safeText === '-') {
      cur.pos = start;
      return FAIL;
    }
    const n = Number(safeText);
    if (Number.isFinite(n)) {
      cur.pos = backTo; // leave cursor at trailing char so outer loop stops
      return { ok: true, value: n, complete: false };
    }
    cur.pos = start;
    return FAIL;
  }

  const n = Number(text);
  if (!Number.isFinite(n)) {
    cur.pos = start;
    return FAIL;
  }
  // Complete iff we are NOT at the boundary of a possibly-extending number.
  // If reachedEnd, the next byte could extend the number, so call it
  // partial-but-known.
  return { ok: true, value: n, complete: !reachedEnd };
}

// ---------------------------------------------------------------------------
// Keyword: true | false | null. Partial-prefix recovery only when prefix is
// unambiguous (length >= 2).
// ---------------------------------------------------------------------------

function parseKeyword(cur: Cursor): Inner {
  const start = cur.pos;
  const remaining = cur.src.slice(cur.pos);

  if (remaining.startsWith('true')) {
    cur.pos += 4;
    return { ok: true, value: true, complete: true };
  }
  if (remaining.startsWith('false')) {
    cur.pos += 5;
    return { ok: true, value: false, complete: true };
  }
  if (remaining.startsWith('null')) {
    cur.pos += 4;
    return { ok: true, value: null, complete: true };
  }

  // Partial prefixes — only keep if length >= 2 AND prefix is unambiguous.
  // 't', 'f', 'n' alone are ambiguous (could be the start of a non-keyword
  // identifier in some lenient interpretations, but more importantly: a
  // single byte gives us no real information). We require >= 2 chars.
  if (remaining.length >= 2) {
    if ('true'.startsWith(remaining) && remaining.length <= 4) {
      cur.pos = cur.src.length;
      return { ok: true, value: undefined, complete: false };
    }
    if ('false'.startsWith(remaining) && remaining.length <= 5) {
      cur.pos = cur.src.length;
      return { ok: true, value: undefined, complete: false };
    }
    if ('null'.startsWith(remaining) && remaining.length <= 4) {
      cur.pos = cur.src.length;
      return { ok: true, value: undefined, complete: false };
    }
  }

  cur.pos = start;
  return FAIL;
}

// Reference NEED_MORE_OBJ to satisfy strict TS unused-export lint, even
// though it's currently a defensive sentinel. Reserved for future use.
void NEED_MORE_OBJ;
