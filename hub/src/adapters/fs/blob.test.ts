import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openBlobStore } from './blob.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-blob-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('filesystem blob store', () => {
  it('round-trips bytes', async () => {
    const blob = openBlobStore(dir);
    await blob.put('tsk_1/resume.pdf', new Uint8Array([1, 2, 3]), 'application/pdf');
    expect(await blob.get('tsk_1/resume.pdf')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('overwrites an existing key', async () => {
    const blob = openBlobStore(dir);
    await blob.put('k', new Uint8Array([1]), 'application/octet-stream');
    await blob.put('k', new Uint8Array([2, 2]), 'application/octet-stream');
    expect(await blob.get('k')).toEqual(new Uint8Array([2, 2]));
  });

  it('leaves no temp file behind after a successful put', async () => {
    const blob = openBlobStore(dir);
    await blob.put('k', new Uint8Array([1]), 'application/octet-stream');
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('throws a clear error for a missing key rather than returning empty bytes', async () => {
    await expect(openBlobStore(dir).get('nope')).rejects.toThrow(/no such blob/i);
  });

  it('REFUSES a key that escapes the artifact directory', async () => {
    const blob = openBlobStore(dir);
    for (const key of ['../escape', '../../etc/passwd', 'a/../../b', '/abs/path']) {
      await expect(
        blob.put(key, new Uint8Array([1]), 'application/octet-stream'),
        key,
      ).rejects.toThrow(/outside the artifact directory|invalid blob key/i);
    }
  });

  it('REFUSES to read a key that escapes the artifact directory', async () => {
    await expect(openBlobStore(dir).get('../../etc/passwd')).rejects.toThrow(
      /outside the artifact directory|invalid blob key/i,
    );
  });

  it('handles a key with nested directories', async () => {
    const blob = openBlobStore(dir);
    await blob.put('a/b/c/file.json', new Uint8Array([9]), 'application/json');
    expect(await blob.get('a/b/c/file.json')).toEqual(new Uint8Array([9]));
  });
});
