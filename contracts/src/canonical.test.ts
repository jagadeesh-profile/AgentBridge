import { describe, expect, it } from 'vitest';
import { canonicalize } from './canonical.js';

describe('canonicalize (RFC 8785)', () => {
  it('sorts object keys by UTF-16 code unit', () => {
    expect(canonicalize({ b: 1, a: 2, C: 3 })).toBe('{"C":3,"a":2,"b":1}');
  });

  it('sorts nested keys too', () => {
    expect(canonicalize({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('serializes integral floats without a trailing .0', () => {
    expect(canonicalize({ n: 1.0 })).toBe('{"n":1}');
  });

  it('uses ES number serialization for exponents', () => {
    expect(canonicalize({ n: 1e30 })).toBe('{"n":1e+30}');
  });

  it('rejects non-finite numbers, which have no JSON form', () => {
    expect(() => canonicalize({ n: NaN })).toThrow(/finite/i);
    expect(() => canonicalize({ n: Infinity })).toThrow(/finite/i);
    expect(() => canonicalize({ n: -Infinity })).toThrow(/finite/i);
  });

  // Review Focus item 4 — non-ASCII and astral-plane text must round-trip.
  it('emits non-ASCII literally rather than escaped', () => {
    expect(canonicalize({ k: 'héllo' })).toBe('{"k":"héllo"}');
    expect(canonicalize({ k: '日本語' })).toBe('{"k":"日本語"}');
  });

  it('preserves emoji and surrogate pairs byte-for-byte', () => {
    const emoji = '\u{1F469}‍\u{1F4BB}\u{1F389}';
    const out = canonicalize({ k: emoji });
    expect(JSON.parse(out)).toEqual({ k: emoji });
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
  });

  it('preserves combining marks without normalizing them', () => {
    // U+00E9 vs. "e" + U+0301. RFC 8785 does not normalize, so these are two
    // different messages with two different signatures. Written as escapes
    // because the two forms are visually identical in source.
    const composed = 'é';
    const decomposed = 'é';
    expect(composed).not.toBe(decomposed);
    expect(canonicalize({ k: composed })).not.toBe(canonicalize({ k: decomposed }));
  });

  it('escapes control characters with the short forms RFC 8785 requires', () => {
    expect(canonicalize({ k: '\n\t"\\' })).toBe('{"k":"\\n\\t\\"\\\\"}');
    // U+0001 has no short form, so it takes the \u00xx escape.
    expect(canonicalize({ k: '' })).toBe('{"k":"\\u0001"}');
  });

  it('drops undefined-valued keys', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('is stable across key insertion order', () => {
    const one: Record<string, number> = {};
    one.x = 1;
    one.a = 2;
    const two: Record<string, number> = {};
    two.a = 2;
    two.x = 1;
    expect(canonicalize(one)).toBe(canonicalize(two));
  });

  it('canonicalizes null and nested arrays of objects', () => {
    expect(canonicalize({ a: null })).toBe('{"a":null}');
    expect(canonicalize([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });
});
