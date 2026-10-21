#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client, loadKey } from '@agentbridge/sdk';
import { buildServer } from './server.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required. See adapters/mcp/README.md.`);
  }
  return value;
}

async function main(): Promise<void> {
  const client = new Client({
    baseUrl: process.env.AGENTBRIDGE_URL ?? 'http://localhost:8080',
    workspace: required('AGENTBRIDGE_WORKSPACE'),
    agent: required('AGENTBRIDGE_AGENT'),
    privateKey: await loadKey(required('AGENTBRIDGE_KEY_PATH')),
  });

  // stdio is the transport: stdout belongs to the protocol, so nothing else may
  // write to it. Diagnostics go to stderr.
  await buildServer(client).connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  process.stderr.write(`agentbridge-mcp failed to start: ${String(err)}\n`);
  process.exit(1);
});

export { buildServer } from './server.js';
export { TOOLS, TOOL_NAMES, UNTRUSTED_NOTICE } from './tools.js';
