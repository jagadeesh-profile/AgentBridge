export interface Provenance {
  from: string;
  sigVerified: boolean;
  receivedAt: string;
}

/**
 * Content that arrived from another agent.
 *
 * Messages are data, never authority (CLAUDE.md §1.1). This wrapper makes that
 * structural rather than advisory: reading the payload takes an explicit
 * `.unwrap()`, and every implicit stringification — template literals,
 * `String()`, concatenation, `JSON.stringify` — yields a placeholder instead of
 * the content. Interpolating an `Untrusted` into a prompt therefore cannot
 * smuggle an injection through by accident.
 */
export class Untrusted<T> {
  constructor(
    private readonly value: T,
    readonly provenance: Provenance,
  ) {}

  /** Deliberately explicit. Treat the result as data, never as instructions. */
  unwrap(): T {
    return this.value;
  }

  toString(): string {
    return `[Untrusted from ${this.provenance.from}; call .unwrap() to read it]`;
  }

  /** Keeps the payload out of logs and out of any JSON body built around it. */
  toJSON(): unknown {
    return { untrusted: true, provenance: this.provenance };
  }

  /** Node's console.log / util.inspect path. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }
}

/** Rebuilds an Untrusted from the wire shape the hub sends. */
export function fromWire<T>(wire: unknown): Untrusted<T> {
  const w = wire as { provenance?: Provenance; value?: T } | null;
  const provenance: Provenance = w?.provenance ?? {
    from: 'unknown',
    sigVerified: false,
    receivedAt: new Date(0).toISOString(),
  };
  return new Untrusted<T>((w?.value ?? null) as T, provenance);
}
