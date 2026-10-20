import { createHash } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { canonicalize } from './canonical.js';
import type { Envelope } from './envelope.js';

const PREFIX = 'ed25519:';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** The hash an approval is bound to. See spec §5.4. */
export function payloadHash(payload: unknown): string {
  return sha256Hex(canonicalize(payload));
}

function envelopeBytes(envelope: Omit<Envelope, 'sig'>): Uint8Array {
  const { sig: _omit, ...rest } = envelope as Envelope & { sig?: string };
  return new TextEncoder().encode(canonicalize(rest));
}

export async function signEnvelope(
  envelope: Omit<Envelope, 'sig'>,
  privateKey: Uint8Array,
): Promise<string> {
  const sig = await ed.signAsync(envelopeBytes(envelope), privateKey);
  return PREFIX + Buffer.from(sig).toString('base64');
}

export async function verifyEnvelope(envelope: Envelope, publicKey: Uint8Array): Promise<boolean> {
  if (!envelope.sig.startsWith(PREFIX)) return false;
  try {
    const sig = Buffer.from(envelope.sig.slice(PREFIX.length), 'base64');
    return await ed.verifyAsync(sig, envelopeBytes(envelope), publicKey);
  } catch {
    // A malformed signature is a failed verification, never a crash.
    return false;
  }
}

/**
 * Canonical descriptor for requests that carry no envelope (e.g. GET /v1/inbox).
 * Newline-delimited so no field can bleed into the next.
 */
export function requestDescriptor(r: {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  body: string;
  timestamp: string;
}): string {
  const query = Object.keys(r.query)
    .sort()
    .flatMap((k) => {
      const v = r.query[k];
      const values = Array.isArray(v) ? [...v].sort() : [v ?? ''];
      return values.map((item) => `${encodeURIComponent(k)}=${encodeURIComponent(item)}`);
    })
    .join('&');

  return [r.method.toUpperCase(), r.path, query, sha256Hex(r.body), r.timestamp].join('\n');
}

export async function signDescriptor(descriptor: string, privateKey: Uint8Array): Promise<string> {
  const sig = await ed.signAsync(new TextEncoder().encode(descriptor), privateKey);
  return PREFIX + Buffer.from(sig).toString('base64');
}

export async function verifyDescriptor(
  descriptor: string,
  signature: string,
  publicKey: Uint8Array,
): Promise<boolean> {
  if (!signature.startsWith(PREFIX)) return false;
  try {
    const sig = Buffer.from(signature.slice(PREFIX.length), 'base64');
    return await ed.verifyAsync(sig, new TextEncoder().encode(descriptor), publicKey);
  } catch {
    return false;
  }
}
