import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as ed from '@noble/ed25519';

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/**
 * Generates an agent key pair locally. The private key never leaves the machine
 * and is never sent to the hub, which stores public keys only (spec §5.1).
 */
export async function generateKeyPair(): Promise<KeyPair> {
  const privateKey = ed.utils.randomPrivateKey();
  return { privateKey, publicKey: await ed.getPublicKeyAsync(privateKey) };
}

export function publicKeyBase64(publicKey: Uint8Array): string {
  return Buffer.from(publicKey).toString('base64');
}

/**
 * Writes the private key 0600. Refuses to clobber an existing key unless
 * forced: silently replacing a key would lock the agent out of its own
 * identity with no way back.
 */
export async function saveKey(
  path: string,
  privateKey: Uint8Array,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (opts.force !== true) {
    const exists = await access(path).then(
      () => true,
      () => false,
    );
    if (exists) {
      throw new Error(`a key already exists at ${path}; pass force to replace it`);
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(privateKey).toString('base64'), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export async function loadKey(path: string): Promise<Uint8Array> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`no key file at ${path}`);
  }
  const bytes = new Uint8Array(Buffer.from(text.trim(), 'base64'));
  if (bytes.length !== 32) {
    throw new Error(`key at ${path} is ${bytes.length} bytes; an Ed25519 key is 32 bytes`);
  }
  return bytes;
}
