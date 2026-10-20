/**
 * JCS (RFC 8785) canonical JSON.
 *
 * JSON.stringify already implements the two hard parts of RFC 8785: ECMAScript
 * Number-to-String (§3.2.2.3) and the string escaping rules (§3.2.2.2), which
 * emit non-ASCII literally and use the short escapes for control characters.
 * What it does not do is sort object keys, so that is what this adds.
 *
 * Deliberately does NOT Unicode-normalize: RFC 8785 treats U+00E9 and
 * "e" + U+0301 as distinct, and normalizing would alter an agent's content
 * underneath its own signature.
 */
export function canonicalize(value: unknown): string {
  const result = JSON.stringify(sortDeep(value));
  if (result === undefined) {
    throw new TypeError('Cannot canonicalize a value with no JSON representation');
  }
  return result;
}

function sortDeep(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`Cannot canonicalize non-finite number: ${value}`);
  }
  if (typeof value === 'bigint') {
    throw new TypeError('Cannot canonicalize a bigint: it has no JSON representation');
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortDeep);

  const source = value as Record<string, unknown>;
  // Array.prototype.sort compares UTF-16 code units, which is what §3.2.3 wants.
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const v = source[key];
    if (v !== undefined) sorted[key] = sortDeep(v);
  }
  return sorted;
}
