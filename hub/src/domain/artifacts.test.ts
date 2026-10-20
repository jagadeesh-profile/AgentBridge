import { beforeEach, describe, expect, it } from 'vitest';
import { makeFakes, type Fakes } from '../ports/fakes/index.js';
import { registerAgent } from './registry.js';
import { createTask } from './tasks.js';
import { listArtifacts, putArtifact } from './artifacts.js';
import type { AgentRecord } from '../ports/index.js';

let deps: Fakes;
let claude: AgentRecord;
let muse: AgentRecord;
let taskId: string;

beforeEach(() => {
  deps = makeFakes();
  claude = registerAgent(deps, 'ws', {
    name: 'claude',
    capabilities: {},
    public_key: 'A',
    scopes: ['read', 'message', 'create_task'],
  });
  muse = registerAgent(deps, 'ws', {
    name: 'muse',
    capabilities: {},
    public_key: 'B',
    scopes: ['read', 'message', 'write_artifact'],
  });
  taskId = createTask(deps, claude, {
    thread: 'thr_1',
    assignee: 'agent:muse',
    title: 't',
    payload: {},
    side_effect: false,
  }).id;
});

const json = {
  kind: 'json' as const,
  name: 'matches.json',
  content_type: 'application/json',
  inline: { hits: 3 },
};

describe('putArtifact', () => {
  it('stores version 1 for a new name', async () => {
    expect((await putArtifact(deps, muse, { ...json, task: taskId })).version).toBe(1);
  });

  it('increments the version for the same name', async () => {
    await putArtifact(deps, muse, { ...json, task: taskId });
    expect((await putArtifact(deps, muse, { ...json, task: taskId })).version).toBe(2);
  });

  it('versions independently per name', async () => {
    await putArtifact(deps, muse, { ...json, task: taskId });
    const other = await putArtifact(deps, muse, {
      task: taskId,
      kind: 'text',
      name: 'notes.txt',
      content_type: 'text/plain',
      inline: 'x',
    });
    expect(other.version).toBe(1);
  });

  it('requires write_artifact scope', async () => {
    await expect(putArtifact(deps, claude, { ...json, task: taskId })).rejects.toMatchObject({
      code: 'scope_denied',
    });
  });

  it('rejects an artifact for an unknown task', async () => {
    await expect(putArtifact(deps, muse, { ...json, task: 'tsk_ghost' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('writes file bytes to the blob store and records the key', async () => {
    const rec = await putArtifact(
      deps,
      muse,
      { task: taskId, kind: 'file', name: 'resume.pdf', content_type: 'application/pdf' },
      new Uint8Array([1, 2, 3]),
    );
    expect(rec.blobKey).not.toBeNull();
    expect(await deps.blob.get(rec.blobKey as string)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects a file artifact with no bytes', async () => {
    await expect(
      putArtifact(deps, muse, {
        task: taskId,
        kind: 'file',
        name: 'x.pdf',
        content_type: 'application/pdf',
      }),
    ).rejects.toMatchObject({ code: 'schema_invalid' });
  });

  it('keeps every version readable', async () => {
    await putArtifact(deps, muse, { ...json, task: taskId });
    await putArtifact(deps, muse, { ...json, task: taskId, inline: { hits: 5 } });
    expect(listArtifacts(deps, muse, taskId)).toHaveLength(2);
  });

  it('notifies the task creator that an artifact landed', async () => {
    await putArtifact(deps, muse, { ...json, task: taskId });
    expect(deps.store.listInbox('ws', 'agent:claude', null, 10).length).toBeGreaterThan(0);
  });

  it('audits the put', async () => {
    await putArtifact(deps, muse, { ...json, task: taskId });
    expect(deps.store.listAudit('ws', 0, 20).map((r) => r.action)).toContain('artifact.put');
  });

  it('leaves no artifact row when the blob write fails', async () => {
    const failing = {
      ...deps,
      blob: {
        put: async () => {
          throw new Error('disk full');
        },
        get: async () => new Uint8Array(),
      },
    };
    await expect(
      putArtifact(
        failing,
        muse,
        { task: taskId, kind: 'file', name: 'big.bin', content_type: 'application/octet-stream' },
        new Uint8Array([1]),
      ),
    ).rejects.toThrow(/disk full/);
    expect(listArtifacts(deps, muse, taskId)).toHaveLength(0);
  });
});

describe('listArtifacts', () => {
  it('scopes to the workspace and task', async () => {
    await putArtifact(deps, muse, { ...json, task: taskId });
    expect(listArtifacts(deps, muse, 'tsk_other')).toHaveLength(0);
  });
});
