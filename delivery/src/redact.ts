const REDACTED = '[REDACTED]';

/**
 * Token shapes worth catching before content leaves the hub (CLAUDE.md §1.6).
 * Deliberately conservative: a false positive mangles an agent's message, so
 * each pattern requires a recognizable prefix and a plausible length.
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, // Anthropic
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  // No \b here: a word boundary cannot exist before a hyphen.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

/** Luhn check, so order numbers and ids are not mistaken for card numbers. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const ch = digits.charCodeAt(i) - 48;
    if (ch < 0 || ch > 9) return false;
    let d = ch;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function redactString(input: string): string {
  let out = input;
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  // 13–19 digit runs, optionally separated by spaces or dashes, that pass Luhn.
  out = out.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (match) => {
    const digits = match.replace(/[^0-9]/g, '');
    if (digits.length < 13 || digits.length > 19) return match;
    return luhnValid(digits) ? REDACTED : match;
  });
  return out;
}

/**
 * Walks a value with an explicit stack, not recursion: agent content is
 * attacker-controlled, and a deeply nested object must not overflow the
 * redactor that exists to sanitize it.
 */
export function redactOutbound(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;

  const root: unknown = Array.isArray(value) ? [...value] : { ...(value as object) };
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }];
  const MAX_DEPTH = 256;

  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    const { node, depth } = entry;
    if (node === null || typeof node !== 'object' || depth > MAX_DEPTH) continue;

    const container = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(container)) {
      if (typeof v === 'string') {
        container[k] = redactString(v);
      } else if (v !== null && typeof v === 'object') {
        const copy: unknown = Array.isArray(v) ? [...v] : { ...(v as object) };
        container[k] = copy;
        stack.push({ node: copy, depth: depth + 1 });
      }
    }
  }

  return root;
}
