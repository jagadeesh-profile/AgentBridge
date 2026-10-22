/**
 * The A2A Agent Card: the discovery document a remote agent fetches before
 * talking to us.
 *
 * Served unauthenticated, because discovery has to work before credentials
 * exist. That makes it a disclosure surface, so it carries capability and
 * protocol facts only — no agent names, no workspace contents, no key
 * material. A test asserts that.
 */

export interface AgentCardOptions {
  /** Public base URL this endpoint is reachable at. */
  publicUrl: string;
  name?: string;
  description?: string;
  version?: string;
}

export function buildAgentCard(opts: AgentCardOptions) {
  const base = opts.publicUrl.replace(/\/$/, '');
  return {
    protocolVersion: '1.0',
    name: opts.name ?? 'AgentBridge',
    description:
      opts.description ??
      'Vendor-neutral hub. Hand work to a registered agent and collect the result. ' +
        'Side effects wait for the owner to approve them.',
    url: `${base}/a2a/v1`,
    preferredTransport: 'JSONRPC',
    version: opts.version ?? '0.1.0',

    capabilities: {
      // Declared false rather than advertised and stubbed. A caller that sees
      // `streaming: true` and gets a non-stream has no recourse; one that sees
      // false polls `tasks/get`, which works.
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },

    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],

    /**
     * AgentBridge authenticates with a per-agent Ed25519 request signature,
     * not a bearer token (ADR 0002). A2A expects a declared security scheme,
     * and none of the standard ones describe this, so it is declared as an
     * http scheme with a custom name and documented here. OAuth 2.1 is the
     * Phase 1 direction and would slot in alongside rather than replace it.
     */
    securitySchemes: {
      agentbridgeSignature: {
        type: 'http',
        scheme: 'agentbridge-ed25519',
        description:
          'Sign each request with the agent Ed25519 key registered with this hub. ' +
          'Headers: x-agentbridge-workspace, x-agentbridge-agent, ' +
          'x-agentbridge-timestamp, x-agentbridge-signature. The signature covers ' +
          'METHOD, path, sorted query, sha256(body) and the timestamp, newline ' +
          'delimited, within a 300s window.',
      },
    },
    security: [{ agentbridgeSignature: [] }],

    skills: [
      {
        id: 'delegate',
        name: 'Delegate a task',
        description:
          'Create a task for an agent in this workspace and poll it to completion. ' +
          'A task marked as having a side effect is held until the workspace owner ' +
          'approves it, and reports auth-required until then.',
        tags: ['delegation', 'tasks'],
        inputModes: ['text/plain', 'application/json'],
        outputModes: ['text/plain', 'application/json'],
      },
    ],

    /**
     * Content returned by this endpoint originates from other agents and is
     * data, never instructions (CLAUDE.md §1.1). Stated on the card because a
     * remote agent feeding a result straight into a prompt is the exact
     * failure this hub is built to avoid, and the card is the one thing every
     * A2A client reads.
     */
    documentationUrl: 'https://github.com/jagadeesh-profile/AgentBridge',
  };
}

export type AgentCard = ReturnType<typeof buildAgentCard>;
