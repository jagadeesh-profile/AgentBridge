#!/usr/bin/env node
/**
 * One full Claude <-> Muse exchange against a running hub, for the 7-day gate.
 *
 * Exits 0 only if every step held, including the one that matters most: Muse
 * must see nothing while a side effect waits for approval. Reuses the same mode
 * modules the test suite exercises, so this script and the tests cannot drift.
 */
import { canonicalize, payloadHash } from '@agentbridge/contracts';
import * as ed from '@noble/ed25519';
import { Client, loadKey } from '@agentbridge/sdk';
import { startPullMuse } from './modes/pull.js';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`${name} is required`);
  return v;
}

const say = (msg: string): void => {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
};

async function main(): Promise<void> {
  const baseUrl = env('AGENTBRIDGE_URL', 'http://localhost:8080');
  const workspace = env('AGENTBRIDGE_WORKSPACE');
  const runId = `pilot-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}`;
  const thread = 'thr_job_search';

  const claude = new Client({
    baseUrl,
    workspace,
    agent: 'agent:claude',
    privateKey: await loadKey(env('CLAUDE_KEY', './claude.key')),
  });
  const ownerPriv = await loadKey(env('OWNER_KEY', './owner.key'));
  const muse = startPullMuse({
    baseUrl,
    workspace,
    agent: 'agent:muse',
    privateKey: await loadKey(env('MUSE_KEY', './muse.key')),
  });

  const health = await fetch(`${baseUrl}/healthz`);
  if (!health.ok) throw new Error(`hub unhealthy: ${health.status}`);
  say('hub healthy');

  say('1/5 claude creates a plain task for muse');
  const plain = await claude.createTask({
    thread,
    assignee: 'agent:muse',
    title: 'list the 3 newest job matches',
    payload: { count: 3 },
    idempotencyKey: `${runId}-create`,
  });

  say('2/5 muse drains its inbox');
  await muse.drain();
  const completed = await claude.getTask(plain.id);
  if (completed.state !== 'completed') {
    throw new Error(`expected completed, got ${completed.state}`);
  }

  say('3/5 claude requests a side effect');
  const gated = await claude.requestApproval({
    thread,
    assignee: 'agent:muse',
    title: 'email the recruiter',
    payload: { to: 'recruiter@example.com', subject: 'Re: your role' },
    idempotencyKey: `${runId}-gated`,
  });
  if (gated.state !== 'needs-approval') {
    throw new Error(`side effect did not gate: state is ${gated.state}`);
  }

  say('4/5 the gate holds: muse must see nothing');
  const before = muse.handled();
  await muse.drain();
  if (muse.handled() !== before) {
    throw new Error('APPROVAL GATE LEAKED: muse was handed a task awaiting approval');
  }

  say('5/5 owner approves; muse then completes it');
  const issuedAt = new Date().toISOString();
  const current = await claude.getTask(gated.id);
  const hash = payloadHash(current.payload);
  const sig = await ed.signAsync(
    new TextEncoder().encode(
      canonicalize({
        task: gated.id,
        decision: 'approve',
        payload_hash: hash,
        issued_at: issuedAt,
      }),
    ),
    ownerPriv,
  );
  await claude.decideApproval({
    task: gated.id,
    decision: 'approve',
    payloadHash: hash,
    issuedAt,
    sig: `ed25519:${Buffer.from(sig).toString('base64')}`,
  });
  await muse.drain();
  const released = await claude.getTask(gated.id);
  if (released.state !== 'completed') {
    throw new Error(`approved task did not complete: ${released.state}`);
  }

  const audit = await claude.verifyAudit();
  if (!audit.ok) throw new Error(`audit chain broken at seq ${String(audit.brokenAtSeq)}`);
  say(`audit chain verifies across ${audit.checked} rows`);

  say(`PILOT OK (${runId})`);
}

main().catch((err: unknown) => {
  process.stderr.write(`PILOT FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
