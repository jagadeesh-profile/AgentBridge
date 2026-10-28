/**
 * Owner key handling for the console.
 *
 * The key is loaded into the page and held in memory only (ADR 0006): never
 * localStorage, never sessionStorage, never IndexedDB, never sent anywhere.
 * Closing the tab is what ends the session. A key at rest in a browser profile
 * is a key any script on the origin — or anyone with the disk — can read, and
 * this one authorises every side effect in the workspace.
 *
 * Browser-safe by construction: no `node:` imports, so this module and the
 * signing it feeds both run in the page rather than on a server.
 */

/** Matches `saveKey` in the SDK: base64 of the raw 32-byte Ed25519 seed. */
const ED25519_KEY_BYTES = 32;

export class OwnerKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerKeyError';
  }
}

function base64ToBytes(b64: string): Uint8Array {
  // atob rather than Buffer: this runs in the page.
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Parses the contents of an `agentbridge keygen` key file.
 *
 * Errors name the problem without quoting the input: an error string can end
 * up in a screenshot, a bug report or a console log, and this input is a
 * private key.
 */
export function parseOwnerKey(text: string): Uint8Array {
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new OwnerKeyError('That file is empty.');
  }
  if (/^-----BEGIN/.test(trimmed)) {
    throw new OwnerKeyError(
      'That looks like a PEM file. AgentBridge keys are the base64 body written by `agentbridge keygen`.',
    );
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new OwnerKeyError('That file is not a base64 AgentBridge key.');
  }

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(trimmed);
  } catch {
    throw new OwnerKeyError('That file is not valid base64.');
  }

  if (bytes.length !== ED25519_KEY_BYTES) {
    throw new OwnerKeyError(
      `That key is ${String(bytes.length)} bytes; an Ed25519 private key is ${String(
        ED25519_KEY_BYTES,
      )}. A public key or a truncated copy would look like this.`,
    );
  }
  return bytes;
}

/**
 * Overwrites the key bytes in place.
 *
 * Not a guarantee — a JS engine may have copied the buffer, and GC timing is
 * not ours to control — but it shortens the window in which a heap snapshot
 * taken after locking contains the key. Cheap, and strictly better than
 * dropping the reference alone.
 */
export function wipeKey(key: Uint8Array): void {
  key.fill(0);
}

/**
 * The PUBLIC half of a loaded owner key, base64 — safe to display.
 *
 * Exists because "the hub rejected this key" is not actionable on its own.
 * `owner.key`, `claude.key` and `muse.key` are all 44 bytes of base64 sitting
 * in the same directory, and nothing here can tell them apart: refusing a
 * non-owner key is the hub's job, deliberately, since only the hub knows which
 * public key it was started with. So the file dialog offers several
 * indistinguishable files and picking the wrong one produces an error that
 * mentions the key, the clock and the workspace — and sends you to check the
 * two that are fine.
 *
 * Showing the derived public key closes that loop: it is directly comparable
 * with `AGENTBRIDGE_OWNER_PUBLIC_KEY`, so "which file did I pick" stops being
 * a guess. A public key discloses nothing — it is already in the hub's
 * environment and its compose file.
 */
export async function ownerPublicKey(key: Uint8Array): Promise<string> {
  const ed = await import('@noble/ed25519');
  const pub = await ed.getPublicKeyAsync(key);
  let binary = '';
  for (const byte of pub) binary += String.fromCharCode(byte);
  // btoa rather than Buffer: this runs in the page.
  return btoa(binary);
}
