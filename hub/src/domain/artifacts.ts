import { AgentBridgeError } from '@agentbridge/contracts';
import { blobKeyFor } from '../adapters/fs/blob.js';
import type { AgentRecord, ArtifactRecord, BlobStore, Deps } from '../ports/index.js';
import { appendAudit } from './audit.js';
import { requireScope } from './registry.js';
import { enqueueTo } from './threads.js';

export type ArtifactDeps = Deps & { blob: BlobStore };

export interface PutArtifactInput {
  task: string;
  kind: 'text' | 'json' | 'file' | 'link';
  name: string;
  content_type: string;
  inline?: unknown;
  trace_id?: string | undefined;
}

export async function putArtifact(
  deps: ArtifactDeps,
  agent: AgentRecord,
  req: PutArtifactInput,
  bytes?: Uint8Array,
): Promise<ArtifactRecord> {
  requireScope(agent, 'write_artifact');
  const ws = agent.workspace;

  const task = deps.store.getTask(ws, req.task);
  if (!task) throw new AgentBridgeError('not_found', req.task);

  if (req.kind === 'file' && bytes === undefined) {
    throw new AgentBridgeError('schema_invalid', 'a file artifact requires bytes');
  }

  const now = deps.clock.now().toISOString();
  const id = deps.ids.ulid('art');

  // The blob is written BEFORE the row, and outside the transaction, so a failed
  // blob write cannot leave a dangling artifact record pointing at nothing.
  let blobKey: string | null = null;
  if (req.kind === 'file' && bytes !== undefined) {
    blobKey = blobKeyFor(ws, req.task, id);
    await deps.blob.put(blobKey, bytes, req.content_type);
  }

  return deps.store.transaction(() => {
    const artifact: ArtifactRecord = {
      id,
      workspace: ws,
      task: req.task,
      version: deps.store.nextArtifactVersion(ws, req.task, req.name),
      kind: req.kind,
      name: req.name,
      contentType: req.content_type,
      inline: req.inline ?? null,
      blobKey,
      createdAt: now,
    };
    deps.store.putArtifact(artifact);

    // The creator asked for the work, so the creator hears that output landed.
    enqueueTo(deps, {
      workspace: ws,
      thread: task.thread,
      from: agent.ref,
      recipient: task.creator,
      type: 'artifact.put',
      task: req.task,
      body: {
        artifact: artifact.id,
        name: artifact.name,
        kind: artifact.kind,
        version: artifact.version,
        inline: artifact.inline,
      },
      sideEffect: task.sideEffect,
      ...(req.trace_id === undefined ? {} : { traceId: req.trace_id }),
      now,
    });

    appendAudit(
      deps,
      ws,
      'artifact.put',
      agent.ref,
      `${req.task}:${artifact.name}:v${artifact.version}`,
    );
    return artifact;
  });
}

export function listArtifacts(
  deps: Pick<Deps, 'store'>,
  agent: AgentRecord,
  taskId: string,
): readonly ArtifactRecord[] {
  return deps.store.listArtifacts(agent.workspace, taskId);
}

export async function readArtifactBytes(
  deps: ArtifactDeps,
  artifact: ArtifactRecord,
): Promise<Uint8Array> {
  if (artifact.blobKey === null) {
    throw new AgentBridgeError('schema_invalid', 'this artifact has no stored bytes');
  }
  return deps.blob.get(artifact.blobKey);
}
