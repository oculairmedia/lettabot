import { describe, expect, it } from 'vitest';
import { parsePartialJsonObject } from './partial-json.js';

describe('parsePartialJsonObject', () => {
  describe('design doc §2 spec table — supported partial states', () => {
    it.each<[string, Record<string, unknown>, boolean]>([
      // input,                           expected value,                        complete?
      ['{', {}, false],
      ['{"key', {}, false],
      ['{"key":', {}, false],
      ['{"key": "val', { key: 'val' }, false],
      ['{"key": "value",', { key: 'value' }, false],
      ['{"key": "value", "k2":', { key: 'value' }, false],
      ['{"key": "value", "k2": 4', { key: 'value', k2: 4 }, false],
      ['{"key": "value"}', { key: 'value' }, true],
      ['{"a": [1, 2,', { a: [1, 2] }, false],
      ['{"a": [1, 2, "p', { a: [1, 2, 'p'] }, false],
      // Coerced from `tr` → unambiguous prefix → drop value, key drops too
      ['{"a": {"nested": tr', { a: {} }, false],
    ])('parses %j → value %j, complete=%s', (input, expected, complete) => {
      const result = parsePartialJsonObject(input);
      expect(result).not.toBeNull();
      expect(result!.value).toEqual(expected);
      expect(result!.complete).toBe(complete);
    });

    it('returns null for garbage input', () => {
      expect(parsePartialJsonObject('garbage')).toBeNull();
      expect(parsePartialJsonObject('[1, 2]')).toBeNull(); // arrays not objects
      expect(parsePartialJsonObject('null')).toBeNull();
      expect(parsePartialJsonObject('')).toBeNull();
    });
  });

  describe('partial strings', () => {
    it('returns chars seen so far for unclosed string', () => {
      const r = parsePartialJsonObject('{"x": "hello world');
      expect(r).toEqual({ value: { x: 'hello world' }, complete: false });
    });

    it('unescapes recognized escapes inside partial strings', () => {
      const r = parsePartialJsonObject('{"x": "line\\nhalf');
      expect(r).toEqual({ value: { x: 'line\nhalf' }, complete: false });
    });

    it('drops trailing backslash if parse stopped on escape (no second char)', () => {
      const r = parsePartialJsonObject('{"x": "abc\\');
      expect(r).toEqual({ value: { x: 'abc' }, complete: false });
    });

    it('handles \\uXXXX unicode escapes when complete', () => {
      const r = parsePartialJsonObject('{"x": "\\u0041BC"}');
      expect(r).toEqual({ value: { x: 'ABC' }, complete: true });
    });

    it('drops trailing partial \\uXXX escape', () => {
      const r = parsePartialJsonObject('{"x": "AB\\u00');
      expect(r).toEqual({ value: { x: 'AB' }, complete: false });
    });
  });

  describe('partial numbers', () => {
    it('keeps complete integers from partial input', () => {
      const r = parsePartialJsonObject('{"n": 12345');
      expect(r).toEqual({ value: { n: 12345 }, complete: false });
    });

    it('strips trailing decimal point when partial', () => {
      const r = parsePartialJsonObject('{"n": 12.');
      expect(r).toEqual({ value: { n: 12 }, complete: false });
    });

    it('strips trailing exponent marker when partial', () => {
      const r = parsePartialJsonObject('{"n": 1e');
      expect(r).toEqual({ value: { n: 1 }, complete: false });
    });

    it('drops bare minus sign (ambiguous)', () => {
      const r = parsePartialJsonObject('{"n": -');
      expect(r).toEqual({ value: {}, complete: false });
    });

    it('keeps negative integers', () => {
      const r = parsePartialJsonObject('{"n": -42');
      expect(r).toEqual({ value: { n: -42 }, complete: false });
    });

    it('keeps complete decimals', () => {
      const r = parsePartialJsonObject('{"n": 3.14}');
      expect(r).toEqual({ value: { n: 3.14 }, complete: true });
    });

    it('keeps scientific notation', () => {
      const r = parsePartialJsonObject('{"n": 1.5e10}');
      expect(r).toEqual({ value: { n: 1.5e10 }, complete: true });
    });
  });

  describe('partial keywords', () => {
    it('completes "tr" → drops value (length 2 partial of true)', () => {
      const r = parsePartialJsonObject('{"x": tr');
      expect(r).toEqual({ value: {}, complete: false });
    });

    it('completes "fa" → drops value (length 2 partial of false)', () => {
      const r = parsePartialJsonObject('{"x": fa');
      expect(r).toEqual({ value: {}, complete: false });
    });

    it('completes "nu" → drops value (length 2 partial of null)', () => {
      const r = parsePartialJsonObject('{"x": nu');
      expect(r).toEqual({ value: {}, complete: false });
    });

    it('drops length-1 ambiguous prefix "t"', () => {
      const r = parsePartialJsonObject('{"x": t');
      // 't' is length-1; treated as start-of-keyword but we drop until length >= 2
      // OR we accept it as partial-and-drop. Spec says length-1 is ambiguous → drop key.
      expect(r).toEqual({ value: {}, complete: false });
    });

    it('full true is included', () => {
      const r = parsePartialJsonObject('{"x": true');
      expect(r).toEqual({ value: { x: true }, complete: false });
    });

    it('full false is included', () => {
      const r = parsePartialJsonObject('{"x": false}');
      expect(r).toEqual({ value: { x: false }, complete: true });
    });

    it('full null is included', () => {
      const r = parsePartialJsonObject('{"x": null}');
      expect(r).toEqual({ value: { x: null }, complete: true });
    });
  });

  describe('partial keys', () => {
    it('drops partial key (no closing quote)', () => {
      const r = parsePartialJsonObject('{"par');
      expect(r).toEqual({ value: {}, complete: false });
    });

    it('drops complete key with no colon', () => {
      const r = parsePartialJsonObject('{"key"');
      expect(r).toEqual({ value: {}, complete: false });
    });

    it('drops key + colon with no value', () => {
      const r = parsePartialJsonObject('{"key":');
      expect(r).toEqual({ value: {}, complete: false });
    });
  });

  describe('trailing commas', () => {
    it('tolerates trailing comma at object end', () => {
      const r = parsePartialJsonObject('{"a": 1,');
      expect(r).toEqual({ value: { a: 1 }, complete: false });
    });

    it('tolerates trailing comma in array', () => {
      const r = parsePartialJsonObject('{"a": [1, 2,]}');
      expect(r).toEqual({ value: { a: [1, 2] }, complete: true });
    });
  });

  describe('unclosed objects/arrays', () => {
    it('closes unclosed object implicitly', () => {
      const r = parsePartialJsonObject('{"a": 1, "b": 2');
      expect(r).toEqual({ value: { a: 1, b: 2 }, complete: false });
    });

    it('closes unclosed array implicitly', () => {
      const r = parsePartialJsonObject('{"a": [1, 2, 3');
      expect(r).toEqual({ value: { a: [1, 2, 3] }, complete: false });
    });

    it('closes deeply nested unclosed structures', () => {
      const r = parsePartialJsonObject('{"a": {"b": {"c": [1, 2');
      expect(r).toEqual({
        value: { a: { b: { c: [1, 2] } } },
        complete: false,
      });
    });
  });

  describe('whitespace tolerance', () => {
    it('handles whitespace before opening brace', () => {
      const r = parsePartialJsonObject('   \n{"a": 1}');
      expect(r).toEqual({ value: { a: 1 }, complete: true });
    });

    it('handles whitespace inside object', () => {
      const r = parsePartialJsonObject('{ "a"  :  1 ,  "b" : 2 }');
      expect(r).toEqual({ value: { a: 1, b: 2 }, complete: true });
    });
  });

  describe('realistic tool_call argument shapes', () => {
    it('progressively parses a write_file call', () => {
      const stages = [
        '{"file_p',
        '{"file_path": "/tmp/x',
        '{"file_path": "/tmp/x.txt", "content',
        '{"file_path": "/tmp/x.txt", "content": "hello',
        '{"file_path": "/tmp/x.txt", "content": "hello world"}',
      ];
      const results = stages.map(parsePartialJsonObject);
      expect(results[0]).toEqual({ value: {}, complete: false });
      expect(results[1]).toEqual({
        value: { file_path: '/tmp/x' },
        complete: false,
      });
      expect(results[2]).toEqual({
        value: { file_path: '/tmp/x.txt' },
        complete: false,
      });
      expect(results[3]).toEqual({
        value: { file_path: '/tmp/x.txt', content: 'hello' },
        complete: false,
      });
      expect(results[4]).toEqual({
        value: { file_path: '/tmp/x.txt', content: 'hello world' },
        complete: true,
      });
    });

    it('parses nested array of objects (tool returning JSON results)', () => {
      const r = parsePartialJsonObject(
        '{"results": [{"id": 1, "name": "a"}, {"id": 2, "name":',
      );
      // Second object has key but no value yet → drop key, end parse
      expect(r).toEqual({
        value: {
          results: [
            { id: 1, name: 'a' },
            { id: 2 },
          ],
        },
        complete: false,
      });
    });
  });

  describe('property fuzz: prefixes of well-formed JSON parse without throwing', () => {
    const fixtures = [
      '{}',
      '{"a": 1}',
      '{"a": 1, "b": 2, "c": 3}',
      '{"x": "hello world"}',
      '{"x": [1, 2, 3]}',
      '{"x": {"y": {"z": "deep"}}}',
      '{"a": [1, "two", true, null, {"k": "v"}]}',
      '{"file_path": "/tmp/x.txt", "content": "line1\\nline2"}',
      '{"unicode": "\\u00e9\\u4e2d"}',
      '{"sci": 1.5e-10, "neg": -42}',
    ];

    for (const fixture of fixtures) {
      it(`every prefix of ${JSON.stringify(fixture).slice(0, 60)}... parses cleanly`, () => {
        // Skip prefix length 0 (empty) — that's "" → null and is fine.
        for (let i = 1; i <= fixture.length; i++) {
          const prefix = fixture.slice(0, i);
          // Should never throw; should return either null OR a valid result
          // (we don't fix the exact values, just shape).
          const result = parsePartialJsonObject(prefix);
          if (result !== null) {
            expect(typeof result.value).toBe('object');
            expect(typeof result.complete).toBe('boolean');
            // Whatever we returned must round-trip through JSON.stringify
            // without throwing (i.e. it's a serializable JS value).
            expect(() => JSON.stringify(result.value)).not.toThrow();
          }
        }
        // The full string must parse as complete.
        const full = parsePartialJsonObject(fixture);
        expect(full).not.toBeNull();
        expect(full!.complete).toBe(true);
        expect(full!.value).toEqual(JSON.parse(fixture));
      });
    }
  });
});
