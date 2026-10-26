#!/usr/bin/env node
/**
 * Runs the Phase 1 adapter conformance suite against LocalStack, refusing to
 * run at all if LocalStack is not answering.
 *
 * The guard is the entire reason this script exists. `blob-conformance.test.ts`
 * skips its S3 half when no endpoint responds, which is correct — `check` has
 * to pass on a machine without Docker. But that same skip would let "the S3
 * adapter passes conformance" be claimed when nothing ran, which is exactly the
 * vacuous pass that a `warn`-level container log produced once already (see the
 * defect table in docs/TASKS.md). So: probe first, fail loudly, then run.
 *
 * Node rather than curl in a Makefile recipe, because this repo is developed on
 * Windows where `make` is not installed and the pnpm scripts are the interface
 * that actually gets exercised.
 */
import { spawn } from 'node:child_process';

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const HEALTH = `${ENDPOINT}/_localstack/health`;
const ATTEMPTS = 15;
const DELAY_MS = 2000;

async function reachable() {
  for (let i = 1; i <= ATTEMPTS; i += 1) {
    try {
      const res = await fetch(HEALTH, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const body = await res.json();
        // Reachable is not enough — S3 itself must be up, or every case fails
        // later with a confusing error instead of a clear one now.
        const s3 = body?.services?.s3;
        if (s3 === 'available' || s3 === 'running') return true;
        process.stdout.write(`  LocalStack up, s3="${s3}" — waiting (${i}/${ATTEMPTS})\n`);
      }
    } catch {
      process.stdout.write(`  no answer from ${HEALTH} (${i}/${ATTEMPTS})\n`);
    }
    if (i < ATTEMPTS) await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  return false;
}

if (!(await reachable())) {
  process.stderr.write(
    `\nFAIL: no usable S3 at ${ENDPOINT}.\n` +
      `The conformance suite would have SKIPPED its S3 half, not passed it.\n` +
      `Start it with:  docker run -d --rm --name ab-localstack -p 4566:4566 -e SERVICES=s3 localstack/localstack:4\n`,
  );
  process.exit(1);
}

process.stdout.write(`S3 available at ${ENDPOINT}; running adapter conformance.\n`);

const child = spawn(
  'pnpm',
  [
    '--filter',
    '@agentbridge/hub',
    'exec',
    'vitest',
    'run',
    '--dir',
    'src',
    'ports/blob-conformance',
  ],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);
child.on('exit', (code) => process.exit(code ?? 1));
