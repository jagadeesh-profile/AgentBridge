import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { TOOLS, TOOL_NAMES, UNTRUSTED_NOTICE } from '@agentbridge/mcp';
import { CreateTaskRequest, PutArtifactRequest } from '@agentbridge/contracts';

/**
 * MCP conformance. A2A is Phase 1, so this suite covers MCP only (spec §7).
 * Written from the contract and agents/protocol-adapters.md, not from the
 * adapter's implementation.
 */
const EXPECTED_TOOLS = [
  'approval.request',
  'artifact.put',
  'inbox.list',
  'message.send',
  'task.create',
  'task.get',
  'task.update',
];

describe('MCP conformance', () => {
  it('lists exactly the seven Phase 0 tools', () => {
    expect([...TOOL_NAMES].sort()).toEqual(EXPECTED_TOOLS);
  });

  it('declares an input schema for every tool', () => {
    for (const tool of TOOLS) {
      expect(Object.keys(tool.inputSchema).length, tool.name).toBeGreaterThan(0);
    }
  });

  it('states untrusted-data provenance in every tool description', () => {
    for (const tool of TOOLS) {
      expect(tool.description, tool.name).toContain(UNTRUSTED_NOTICE);
    }
  });

  it('gives every tool a human-readable title', () => {
    for (const tool of TOOLS) {
      expect(tool.title.length, tool.name).toBeGreaterThan(2);
    }
  });

  it('keeps task.create aligned with the contract', () => {
    const declared = new Set(Object.keys(TOOLS.find((t) => t.name === 'task.create')!.inputSchema));
    for (const key of ['thread', 'assignee', 'title', 'payload', 'side_effect']) {
      expect(declared, key).toContain(key);
    }
    // side_effect must be required in the contract too.
    expect(
      CreateTaskRequest.safeParse({ thread: 't', assignee: 'agent:m', title: 'x', payload: {} })
        .success,
    ).toBe(false);
  });

  it('keeps artifact.put aligned with the contract', () => {
    const declared = new Set(
      Object.keys(TOOLS.find((t) => t.name === 'artifact.put')!.inputSchema),
    );
    for (const key of ['task', 'kind', 'name', 'content_type']) {
      expect(declared, key).toContain(key);
    }
    expect(PutArtifactRequest.safeParse({ task: 't' }).success).toBe(false);
  });

  it('never names a tool outside the agreed set', () => {
    for (const name of TOOL_NAMES) {
      expect(EXPECTED_TOOLS, `unexpected tool ${name}`).toContain(name);
    }
  });

  it('ships a README documenting the client wiring', async () => {
    const readme = await readFile('adapters/mcp/README.md', 'utf8');
    expect(readme).toContain('claude_desktop_config.json');
    expect(readme).toContain('AGENTBRIDGE_KEY_PATH');
    for (const name of EXPECTED_TOOLS) {
      expect(readme, name).toContain(name);
    }
  });
});
