import { z } from 'zod';
import { AgentRefSchema, SCOPES } from './envelope.js';
import { TASK_STATES } from './task-states.js';

const ScopeSchema = z.enum(SCOPES);
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const Signature = z.string().regex(/^ed25519:[A-Za-z0-9+/]+={0,2}$/);

export const CapabilityCard = z.object({
  skills: z.array(z.string().min(1)),
  input: z.array(z.string().min(1)),
  output: z.array(z.string().min(1)),
  description: z.string().max(2000).optional(),
});

export const RegisterAgentRequest = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
  capabilities: CapabilityCard,
  public_key: z
    .string()
    .min(1)
    .describe('base64 Ed25519 public key. The hub never sees the private key.'),
  webhook_url: z.string().url().optional().describe('Omit for pull-inbox-only agents.'),
  /** Least privilege by default — CLAUDE.md §8. */
  scopes: z.array(ScopeSchema).default(['read', 'message']),
});

export const PostMessageRequest = z.object({
  thread: z.string().min(1),
  to: z.array(AgentRefSchema).min(1),
  body: z.unknown(),
  side_effect: z.boolean(),
  idempotency_key: z.string().min(1).max(256),
});

export const CreateTaskRequest = z.object({
  thread: z.string().min(1),
  assignee: AgentRefSchema,
  title: z.string().min(1).max(500),
  payload: z.unknown(),
  side_effect: z.boolean(),
  due_at: z.string().datetime({ offset: true }).optional(),
  idempotency_key: z.string().min(1).max(256).optional(),
});

export const UpdateTaskRequest = z.object({
  state: z.enum(TASK_STATES),
  note: z.string().max(2000).optional(),
  idempotency_key: z.string().min(1).max(256).optional(),
});

export const PutArtifactRequest = z.object({
  task: z.string().min(1),
  kind: z.enum(['text', 'json', 'file', 'link']),
  name: z.string().min(1).max(200),
  content_type: z.string().min(1).max(100),
  /** Inline for text/json/link; for file, the bytes are uploaded separately. */
  inline: z.unknown().optional(),
  idempotency_key: z.string().min(1).max(256).optional(),
});

export const ApprovalDecisionRequest = z.object({
  task: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
  payload_hash: Sha256Hex,
  issued_at: z.string().datetime({ offset: true }),
  sig: Signature.describe('Owner signature over JCS of {task, decision, payload_hash, issued_at}.'),
});

export const InboxQuery = z.object({
  since: z.string().min(1).optional().describe('ULID cursor of the last acknowledged item.'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const UntrustedWrapper = z.object({
  untrusted: z.literal(true),
  provenance: z.object({
    from: AgentRefSchema,
    sigVerified: z.boolean(),
    receivedAt: z.string().datetime({ offset: true }),
  }),
  value: z.unknown(),
});

export const InboxResponse = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      thread: z.string().min(1),
      type: z.string().min(1),
      task: z.string().min(1).optional(),
      body: UntrustedWrapper,
      created_at: z.string().datetime({ offset: true }),
    }),
  ),
  cursor: z.string().min(1).nullable(),
});

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    trace_id: z.string().min(1),
  }),
});

export type RegisterAgentRequestT = z.infer<typeof RegisterAgentRequest>;
export type PostMessageRequestT = z.infer<typeof PostMessageRequest>;
export type CreateTaskRequestT = z.infer<typeof CreateTaskRequest>;
export type UpdateTaskRequestT = z.infer<typeof UpdateTaskRequest>;
export type PutArtifactRequestT = z.infer<typeof PutArtifactRequest>;
export type ApprovalDecisionRequestT = z.infer<typeof ApprovalDecisionRequest>;
export type InboxQueryT = z.infer<typeof InboxQuery>;
export type InboxResponseT = z.infer<typeof InboxResponse>;
