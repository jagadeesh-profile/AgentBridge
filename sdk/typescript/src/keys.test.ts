import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair, loadKey, publicKeyBase64, saveKey } from './keys.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-keys-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('keys', () => {
  it('generates a 32-byte private key and its public key', async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    expect(privateKey).toHaveLength(32);
    expect(publicKey).toHaveLength(32);
  });

  it('round-trips a key through save and load', async () => {
    const { privateKey } = await generateKeyPair();
    const path = join(dir, 'muse.key');
    await saveKey(path, privateKey);
    expect(await loadKey(path)).toEqual(privateKey);
  });

  it('refuses to overwrite an existing key without force', async () => {
    const { privateKey } = await generateKeyPair();
    const path = join(dir, 'muse.key');
    await saveKey(path, privateKey);
    await expect(saveKey(path, privateKey)).rejects.toThrow(/exists/i);
  });

  it('overwrites when force is given', async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const path = join(dir, 'muse.key');
    await saveKey(path, a.privateKey);
    await saveKey(path, b.privateKey, { force: true });
    expect(await loadKey(path)).toEqual(b.privateKey);
  });

  it('writes the key 0600 so other local users cannot read it', async () => {
    const { privateKey } = await generateKeyPair();
    const path = join(dir, 'muse.key');
    await saveKey(path, privateKey);
    if (platform() !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } else {
      // Windows ignores POSIX modes; the call must still succeed.
      expect(statSync(path).isFile()).toBe(true);
    }
  });

  it('derives a base64 public key suitable for registration', async () => {
    const { publicKey } = await generateKeyPair();
    const b64 = publicKeyBase64(publicKey);
    expect(Buffer.from(b64, 'base64')).toEqual(Buffer.from(publicKey));
  });

  it('throws a clear error for a missing key file', async () => {
    await expect(loadKey(join(dir, 'nope.key'))).rejects.toThrow(/no key file/i);
  });

  it('rejects a key file of the wrong length', async () => {
    const path = join(dir, 'bad.key');
    await saveKey(path, new Uint8Array(32));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, 'deadbeef', 'utf8');
    await expect(loadKey(path)).rejects.toThrow(/32 bytes/i);
  });
});
