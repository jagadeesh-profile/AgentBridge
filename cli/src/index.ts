#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  approve,
  auditVerify,
  inbox,
  keygen,
  register,
  revoke,
  type Env,
} from './commands/index.js';

const USAGE = `agentbridge — AgentBridge owner CLI

  agentbridge keygen   --out <path> [--force]
  agentbridge register --name <slug> --key <path> --owner-key <path>
                       [--scopes a,b] [--webhook-url <url>] [--skills a,b]
  agentbridge approve  --task <id> --owner-key <path> --agent <ref> --agent-key <path>
                       [--reject] --yes
  agentbridge revoke   --ref <agent:slug> --agent <ref> --agent-key <path> --yes
  agentbridge inbox    --agent <ref> --agent-key <path> [--limit n]
  agentbridge audit verify --agent <ref> --agent-key <path>

Environment:
  AGENTBRIDGE_URL        hub base url (default http://localhost:8080)
  AGENTBRIDGE_WORKSPACE  workspace id (required)
`;

function env(): Env {
  const workspace = process.env.AGENTBRIDGE_WORKSPACE;
  if (workspace === undefined || workspace === '') {
    throw new Error('AGENTBRIDGE_WORKSPACE is required');
  }
  return {
    baseUrl: process.env.AGENTBRIDGE_URL ?? 'http://localhost:8080',
    workspace,
    write: (line) => process.stdout.write(`${line}\n`),
  };
}

function need(value: string | undefined, flag: string): string {
  if (value === undefined || value === '') throw new Error(`${flag} is required`);
  return value;
}

const list = (v: string | undefined): string[] | undefined =>
  v === undefined
    ? undefined
    : v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');

async function main(argv: string[]): Promise<void> {
  const [command, sub] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  const { values } = parseArgs({
    args: argv.slice(command === 'audit' ? 2 : 1),
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      force: { type: 'boolean' },
      name: { type: 'string' },
      key: { type: 'string' },
      scopes: { type: 'string' },
      'webhook-url': { type: 'string' },
      skills: { type: 'string' },
      task: { type: 'string' },
      'owner-key': { type: 'string' },
      agent: { type: 'string' },
      'agent-key': { type: 'string' },
      ref: { type: 'string' },
      reject: { type: 'boolean' },
      limit: { type: 'string' },
      yes: { type: 'boolean' },
    },
  });

  const e = env();
  const agentRef = (): string => need(values.agent, '--agent');
  const agentKey = (): string => need(values['agent-key'], '--agent-key');

  switch (command) {
    case 'keygen':
      await keygen(e, {
        out: need(values.out, '--out'),
        ...(values.force === true ? { force: true } : {}),
      });
      return;

    case 'register':
      await register(e, {
        name: need(values.name, '--name'),
        key: need(values.key, '--key'),
        ...(list(values.scopes) === undefined ? {} : { scopes: list(values.scopes) }),
        ...(values['webhook-url'] === undefined ? {} : { webhookUrl: values['webhook-url'] }),
        ownerKeyPath: need(values['owner-key'], '--owner-key'),
        ...(list(values.skills) === undefined ? {} : { skills: list(values.skills) }),
      });
      return;

    case 'approve':
      await approve(e, {
        task: need(values.task, '--task'),
        ownerKeyPath: need(values['owner-key'], '--owner-key'),
        agentRef: agentRef(),
        agentKeyPath: agentKey(),
        decision: values.reject === true ? 'reject' : 'approve',
        ...(values.yes === true ? { yes: true } : {}),
      });
      return;

    case 'revoke':
      await revoke(e, {
        ref: need(values.ref, '--ref'),
        agentRef: agentRef(),
        agentKeyPath: agentKey(),
        ...(values.yes === true ? { yes: true } : {}),
      });
      return;

    case 'inbox':
      await inbox(e, {
        agentRef: agentRef(),
        agentKeyPath: agentKey(),
        ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
      });
      return;

    case 'audit':
      if (sub !== 'verify') throw new Error('usage: agentbridge audit verify');
      await auditVerify(e, { agentRef: agentRef(), agentKeyPath: agentKey() });
      return;

    default:
      throw new Error(`unknown command: ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
