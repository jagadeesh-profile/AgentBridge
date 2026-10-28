#!/usr/bin/env node
/**
 * Answers "why did the hub reject this owner key" in one command.
 *
 *   node scripts/check-owner-key.mjs [keyfile] [hubUrl]
 *
 * `unauthenticated` on an owner route has exactly two causes — the key is not
 * the one the hub was started with, or the clock is outside the replay window
 * — and from the outside they look identical. Worse, the obvious suspects are
 * innocent: a wrong workspace authenticates fine and returns an empty list, so
 * the name on screen tells you nothing.
 *
 * This checks both, plus the thing that actually bites: `owner.key`,
 * `claude.key` and `muse.key` are all 44 bytes of base64 sitting in the same
 * directory, and nothing but the hub can tell them apart. `parseOwnerKey`
 * deliberately cannot — rejecting a non-owner key is the hub's job, not the
 * console's — so picking the wrong file in a file dialog produces precisely
 * the error that sends you hunting your clock.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as ed from '../sdk/typescript/node_modules/@noble/ed25519/index.js';

const keyFile = process.argv[2] ?? 'owner.key';
const hubUrl = process.argv[3] ?? process.env.AGENTBRIDGE_URL ?? 'http://localhost:8090';

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- the key
let seed;
try {
  seed = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
} catch (err) {
  fail(`cannot read ${keyFile}: ${err instanceof Error ? err.message : String(err)}`);
}
if (seed.length !== 32) {
  fail(
    `${keyFile} decodes to ${seed.length} bytes, not 32. ` +
      'An AgentBridge key file is the base64 of a raw 32-byte Ed25519 seed.',
  );
}
const derived = Buffer.from(await ed.getPublicKeyAsync(new Uint8Array(seed))).toString('base64');

// ------------------------------------------------- what the hub was given
// Read it from the running container rather than .env: .env is what someone
// intended, the container's environment is what the hub is actually verifying
// against, and a stale container is one of the ways these drift apart.
// One command string rather than argv + shell:true, which Node 24 warns about
// (DEP0190) because the args would be concatenated unescaped. Nothing here is
// user input, but a deprecation warning in a diagnostic tool is noise exactly
// where the output needs to be easy to read.
const fromContainer = spawnSync(
  'docker compose exec -T hub printenv AGENTBRIDGE_OWNER_PUBLIC_KEY',
  { encoding: 'utf8', shell: true },
);
const configured = (fromContainer.stdout ?? '').trim();

process.stdout.write(`key file   : ${keyFile}\n`);
process.stdout.write(`its public : ${derived}\n`);

if (configured === '') {
  process.stdout.write('hub expects: (could not read it from the container — is the stack up?)\n');
} else {
  process.stdout.write(`hub expects: ${configured}\n`);
  process.stdout.write(
    derived === configured
      ? '\nMATCH: this IS the owner key the hub verifies against.\n'
      : `\nMISMATCH: this is NOT the hub's owner key. The hub will answer\n` +
          'unauthenticated for every owner route, whatever the workspace says.\n' +
          'Check which file you picked — agent keys live beside the owner key\n' +
          'and are indistinguishable until the hub sees a signature.\n',
  );
}

// ---------------------------------------------------------------- the clock
const res = await fetch(`${hubUrl}/healthz`, { signal: AbortSignal.timeout(3000) }).catch(
  () => null,
);
if (res === null) {
  process.stdout.write(`\nclock      : could not reach ${hubUrl}\n`);
} else {
  // The hub's own Date header, so this compares against the clock that will
  // judge the signature rather than against any third party.
  const hubDate = res.headers.get('date');
  const skewMs = hubDate === null ? null : Math.abs(Date.now() - Date.parse(hubDate));
  process.stdout.write(
    skewMs === null
      ? '\nclock      : the hub sent no Date header\n'
      : `\nclock skew : ${Math.round(skewMs / 1000)}s vs the hub ` +
          `(the replay window is 300s)${skewMs > 300_000 ? ' — TOO FAR, this alone would reject' : ' — fine'}\n`,
  );
}
