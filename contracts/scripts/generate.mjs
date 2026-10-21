// Generates contracts/generated/ from the Zod schemas, which are the single
// source of truth (spec §2.3). Runs against dist/ so the emitted artifacts
// describe exactly what consumers import. `pnpm run contracts` regenerates and
// fails if the result differs from what is committed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { CONTRACT_VERSION, ERROR_CATALOG, EnvelopeSchema } from '../dist/index.js';
import * as api from '../dist/api.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'generated');
mkdirSync(OUT, { recursive: true });

/** Every named schema we publish: the envelope plus every schema in api.ts. */
const schemas = { Envelope: EnvelopeSchema };
for (const [name, value] of Object.entries(api)) {
  if (value && typeof value === 'object' && typeof value.safeParse === 'function') {
    schemas[name] = value;
  }
}

const names = Object.keys(schemas).sort();

// One JSON Schema file per named schema, sorted so diffs stay meaningful.
for (const name of names) {
  const json = zodToJsonSchema(schemas[name], { name, target: 'jsonSchema7' });
  writeFileSync(join(OUT, `${name}.schema.json`), `${JSON.stringify(json, null, 2)}\n`);
}

/**
 * The error responses every endpoint can return, keyed by status. Several codes
 * share a status (401 covers unauthenticated, signature_invalid and
 * key_revoked), so the description lists every code that maps to it.
 */
const errorResponses = {};
for (const [code, { status, message }] of Object.entries(ERROR_CATALOG)) {
  const key = String(status);
  const existing = errorResponses[key];
  errorResponses[key] = {
    description: existing ? `${existing.description} | ${code}: ${message}` : `${code}: ${message}`,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
  };
}

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

function operation({ operationId, body, status, ok, summary }) {
  const op = {
    operationId,
    summary,
    responses: {
      [String(status)]: {
        description: 'Success',
        ...(ok ? { content: { 'application/json': { schema: ref(ok) } } } : {}),
      },
      ...errorResponses,
    },
  };
  if (body) {
    op.requestBody = { required: true, content: { 'application/json': { schema: ref(body) } } };
  }
  return op;
}

const paths = {
  '/v1/agents': {
    post: operation({
      operationId: 'registerAgent',
      body: 'RegisterAgentRequest',
      status: 201,
      summary: 'Register an agent with its capabilities card, public key and scopes (FR-1).',
    }),
    get: operation({
      operationId: 'listAgents',
      status: 200,
      ok: 'AgentListResponse',
      summary: 'Owner-signed roster: who exists, their scopes and whose key still works.',
    }),
  },
  '/v1/agents/{ref}/key': {
    delete: operation({
      operationId: 'revokeAgentKey',
      status: 200,
      summary: 'Owner-signed kill switch: revoke the key and drop that agent’s pending deliveries.',
    }),
  },
  '/v1/messages': {
    post: operation({
      operationId: 'postMessage',
      body: 'PostMessageRequest',
      status: 202,
      summary: 'Post a signed message to a thread (FR-3).',
    }),
  },
  '/v1/tasks': {
    post: operation({
      operationId: 'createTask',
      body: 'CreateTaskRequest',
      status: 201,
      summary: 'Create a task. side_effect:true enters needs-approval (FR-4, FR-8).',
    }),
    get: operation({
      operationId: 'listTasks',
      status: 200,
      ok: 'TaskListResponse',
      summary: 'Owner-signed listing, e.g. ?state=needs-approval for the approval queue.',
    }),
  },
  '/v1/tasks/{id}': {
    get: operation({ operationId: 'getTask', status: 200, summary: 'Read one task.' }),
    patch: operation({
      operationId: 'updateTask',
      body: 'UpdateTaskRequest',
      status: 200,
      summary: 'Transition a task. Illegal transitions return illegal_transition.',
    }),
  },
  '/v1/artifacts': {
    post: operation({
      operationId: 'putArtifact',
      body: 'PutArtifactRequest',
      status: 201,
      summary: 'Attach a versioned artifact to a task (FR-5).',
    }),
  },
  '/v1/approvals': {
    post: operation({
      operationId: 'decideApproval',
      body: 'ApprovalDecisionRequest',
      status: 200,
      summary: 'Owner-signed decision bound to the current payload hash (FR-8).',
    }),
  },
  '/v1/inbox': {
    get: operation({
      operationId: 'listInbox',
      status: 200,
      ok: 'InboxResponse',
      summary: 'Pull fallback for agents that cannot receive inbound calls (FR-7).',
    }),
  },
  '/v1/inbox/ack': {
    post: operation({
      operationId: 'ackInbox',
      status: 200,
      summary: 'Advance the inbox cursor.',
    }),
  },
  '/v1/audit': {
    get: operation({
      operationId: 'listAudit',
      status: 200,
      ok: 'AuditListResponse',
      summary: 'Owner-signed: the hash-chained audit rows, for independent verification.',
    }),
  },
  '/v1/audit/verify': {
    get: operation({
      operationId: 'verifyAudit',
      status: 200,
      summary: 'Owner-signed. The hub checking itself — prefer recomputing from GET /v1/audit.',
    }),
  },
};

const components = {};
for (const name of names) {
  components[name] = zodToJsonSchema(schemas[name], { target: 'jsonSchema7' });
}

writeFileSync(
  join(OUT, 'openapi.yaml'),
  stringify({
    openapi: '3.1.0',
    info: {
      title: 'AgentBridge',
      version: CONTRACT_VERSION,
      description: 'Generated from contracts/src/*.ts. Do not edit by hand; run `make contracts`.',
    },
    paths,
    components: { schemas: components },
  }),
);

process.stdout.write(`generated ${names.length} schemas + openapi.yaml\n`);
