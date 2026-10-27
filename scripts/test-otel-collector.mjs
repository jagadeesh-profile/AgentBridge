#!/usr/bin/env node
/**
 * Wire-compatibility check against the real OpenTelemetry Collector.
 *
 * Starts the collector, runs `tests/telemetry/collector.test.ts` against it,
 * then greps the collector's own log for the trace id that was sent. The grep
 * is the part a stub receiver cannot provide: forceFlush resolving proves the
 * collector returned 2xx, while the log line proves it actually parsed the
 * span and kept the trace id — those are different claims, and only the second
 * one rules out a collector that accepts and discards.
 *
 * Refuses to run if the collector never becomes reachable, for the same reason
 * `scripts/test-aws.mjs` does: `collector.test.ts` skips itself without an
 * endpoint, and a silent skip would let "verified against a real collector" be
 * claimed when nothing ran.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

// Pinned, not `latest` (§4). 0.116.0 was tried first and its linux/amd64
// image fails to exec on this host — `exec /otelcol: no such file or
// directory` with a matching architecture — so the version is pinned to one
// that was actually run rather than one that looked plausible.
const IMAGE = 'otel/opentelemetry-collector:0.164.0';
const NAME = 'ab-otel-collector';
const PORT = 4318;
const ENDPOINT = `http://localhost:${PORT}`;
const CONFIG = resolve('tests/telemetry/collector-config.yaml');
const TRACE_ID = randomBytes(16).toString('hex');

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts });
}

function running() {
  const out = sh('docker', ['ps', '--filter', `name=${NAME}`, '--format', '{{.Names}}']);
  return (out.stdout ?? '').includes(NAME);
}

function start() {
  if (running()) {
    process.stdout.write(`${NAME} already running\n`);
    return;
  }
  process.stdout.write(`starting ${IMAGE}…\n`);
  const run = sh('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    NAME,
    '-p',
    `${PORT}:${PORT}`,
    '-v',
    // The image's default config path, so no --config argument is needed.
    `${CONFIG}:/etc/otelcol/config.yaml:ro`,
    IMAGE,
  ]);
  if (run.status !== 0) {
    process.stderr.write(`docker run failed: ${run.stderr ?? ''}\n`);
    process.exit(1);
  }
}

async function reachable() {
  for (let i = 1; i <= 20; i += 1) {
    try {
      // An empty POST is a malformed OTLP payload, so the collector answers
      // 4xx — which is all that is needed here: it answered.
      const res = await fetch(`${ENDPOINT}/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(2000),
      });
      if (res.status > 0) return true;
    } catch {
      process.stdout.write(`  waiting for the collector (${i}/20)\n`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function stop() {
  sh('docker', ['stop', NAME]);
}

start();

if (!(await reachable())) {
  process.stderr.write(
    `\nFAIL: no OpenTelemetry Collector at ${ENDPOINT}.\n` +
      `collector.test.ts would have SKIPPED, not passed.\n` +
      `Collector log:\n${sh('docker', ['logs', NAME]).stdout ?? ''}\n`,
  );
  stop();
  process.exit(1);
}

process.stdout.write(`collector up; exporting spans under trace id ${TRACE_ID}\n`);

const code = await new Promise((done) => {
  const child = spawn(
    'pnpm',
    ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts', 'tests/telemetry'],
    {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, OTEL_COLLECTOR_ENDPOINT: ENDPOINT, AB_TRACE_ID: TRACE_ID },
    },
  );
  child.on('exit', (c) => done(c ?? 1));
});

if (code !== 0) {
  stop();
  process.exit(code);
}

// The independent confirmation: the collector parsed the span and kept the
// trace id. `debug` with detailed verbosity prints it to stdout.
const logs = sh('docker', ['logs', NAME]);
const haystack = `${logs.stdout ?? ''}${logs.stderr ?? ''}`;
if (!haystack.includes(TRACE_ID)) {
  process.stderr.write(
    `\nFAIL: the collector returned 2xx but its log never mentions trace id ${TRACE_ID}.\n` +
      `That means the span was accepted and dropped, which a stub receiver cannot detect.\n` +
      `Collector log:\n${haystack}\n`,
  );
  stop();
  process.exit(1);
}

process.stdout.write(`\nOK: the real collector received and parsed trace ${TRACE_ID}.\n`);
stop();
