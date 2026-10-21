import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ed from '@noble/ed25519';
import { describe, expect, it } from 'vitest';
import { OwnerKeyError, parseOwnerKey, wipeKey } from './owner-key.js';

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

describe('parseOwnerKey', () => {
  it('accepts a key file written by `agentbridge keygen`', () => {
    const priv = ed.utils.randomPrivateKey();
    expect(parseOwnerKey(b64(priv))).toEqual(priv);
  });

  it('tolerates the trailing newline a file inevitably has', () => {
    const priv = ed.utils.randomPrivateKey();
    expect(parseOwnerKey(`${b64(priv)}\n`)).toEqual(priv);
  });

  it('rejects a key of the wrong length and says what the length was', () => {
    expect(() => parseOwnerKey(b64(new Uint8Array(16)))).toThrow(/16 bytes/);
  });

  it('CANNOT reject a 32-byte public key — that check belongs to the hub', () => {
    // An Ed25519 public key is also 32 bytes, so nothing here distinguishes
    // it. Recording the limitation rather than implying a guarantee: the
    // wrong key surfaces as `unauthenticated` on the first request, which is
    // why the console loads the queue immediately after unlocking.
    const publicKeyBytes = new Uint8Array(32).fill(7);
    expect(() => parseOwnerKey(b64(publicKeyBytes))).not.toThrow();
  });

  it('rejects an empty file with a message a human can act on', () => {
    expect(() => parseOwnerKey('   \n ')).toThrow(/empty/i);
  });

  it('names PEM specifically, since that is the likely wrong file', () => {
    expect(() =>
      parseOwnerKey('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'),
    ).toThrow(/PEM/);
  });

  it('rejects non-base64 junk', () => {
    expect(() => parseOwnerKey('not a key!!')).toThrow(OwnerKeyError);
  });

  it('NEVER echoes the input back in the error message', () => {
    // Error strings reach screenshots, bug reports and logs. The input here is
    // a private key, so it must not travel with the complaint about it.
    const secret = 'AAAABBBBCCCCDDDDEEEEFFFFGGGG';
    try {
      parseOwnerKey(secret);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(String(err)).not.toContain(secret);
    }
  });
});

describe('wipeKey', () => {
  it('zeroes the bytes in place', () => {
    const key = ed.utils.randomPrivateKey();
    wipeKey(key);
    expect([...key].every((b) => b === 0)).toBe(true);
  });
});

describe('the console never puts the owner key at rest', () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return sources(full);
      return /\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts') ? [full] : [];
    });
  }

  /**
   * Comments are stripped first: these files *document* the rule, and a guard
   * that read prose would fire on the explanation of itself.
   */
  const code = (file: string): string =>
    readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('uses no storage API anywhere in the console source', () => {
    // The guarantee the design rests on, enforced mechanically rather than by
    // intention. "Persist it so the owner does not re-load each session" is a
    // reasonable-sounding change that would quietly undo it.
    for (const file of sources(srcDir)) {
      expect(code(file), file).not.toMatch(
        /localStorage|sessionStorage|indexedDB|document\.cookie/,
      );
    }
  });

  it('imports no node: builtin, so signing cannot drift to a server', () => {
    for (const file of sources(srcDir)) {
      expect(code(file), file).not.toMatch(/from ['"]node:/);
    }
  });

  it('is checking a real set of files, not silently zero', () => {
    // A guard that walks an empty directory passes forever. Both rules above
    // are vacuous without this.
    expect(sources(srcDir).length).toBeGreaterThanOrEqual(3);
  });
});
