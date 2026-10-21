import { registrationDescriptor, signDescriptor } from '@agentbridge/contracts';

export interface RegistrationInput {
  baseUrl: string;
  workspace: string;
  name: string;
  /** base64 Ed25519 public key of the agent being enrolled. */
  publicKey: string;
  /** The OWNER's private key. Never the agent's. */
  ownerPrivateKey: Uint8Array;
  scopes?: readonly string[];
  webhookUrl?: string | undefined;
  capabilities?: { skills: string[]; input: string[]; output: string[] };
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface RegistrationResult {
  ref: string;
  scopes: string[];
  /** Returned exactly once, at registration. Never readable again. */
  webhookSecret: string | null;
  createdAt: string;
}

/** CLAUDE.md §8: least privilege unless the owner says otherwise. */
const DEFAULT_SCOPES = ['read', 'message'] as const;

/**
 * Enrols an agent, authorised by the owner's signature (ADR 0005).
 *
 * Registration is the one call that cannot be signed as the agent — it has no
 * registered key yet — so the owner signs a descriptor binding the workspace,
 * name, public key, scopes and webhook URL. Changing any of those after
 * signing invalidates it, so a captured enrolment cannot be retargeted.
 */
export async function registerAgent(input: RegistrationInput): Promise<RegistrationResult> {
  const scopes = [...(input.scopes ?? DEFAULT_SCOPES)];
  const issuedAt = (input.now ?? (() => new Date()))().toISOString();

  const signature = await signDescriptor(
    registrationDescriptor({
      workspace: input.workspace,
      name: input.name,
      publicKey: input.publicKey,
      scopes,
      ...(input.webhookUrl === undefined ? {} : { webhookUrl: input.webhookUrl }),
      issuedAt,
    }),
    input.ownerPrivateKey,
  );

  const res = await (input.fetch ?? fetch)(`${input.baseUrl}/v1/agents`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agentbridge-workspace': input.workspace,
      'x-agentbridge-timestamp': issuedAt,
      'x-agentbridge-owner-signature': signature,
    },
    body: JSON.stringify({
      name: input.name,
      capabilities: input.capabilities ?? {
        skills: [],
        input: ['text', 'json'],
        output: ['text', 'json'],
      },
      public_key: input.publicKey,
      scopes,
      ...(input.webhookUrl === undefined ? {} : { webhook_url: input.webhookUrl }),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`register ${input.name} failed: ${res.status} ${text}`);
  }

  const body = (await res.json()) as {
    ref: string;
    scopes: string[];
    webhook_secret: string | null;
    created_at: string;
  };
  return {
    ref: body.ref,
    scopes: body.scopes,
    webhookSecret: body.webhook_secret,
    createdAt: body.created_at,
  };
}
