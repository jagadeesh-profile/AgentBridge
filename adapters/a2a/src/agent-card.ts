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
    version: opts.version ?? '0.1.0',

    /**
     * v1.0 REQUIRED field (spec §4.4.1, §8.3.1). An ordered list whose first
     * entry is the preferred interface; v1.0 consolidated v0.3's `url`,
     * `preferredTransport` and `additionalInterfaces` into it.
     *
     * This card declared `protocolVersion: '1.0'` while serving only the v0.3
     * shape, which the conformance suite caught. A client written against v1.0
     * reads `supportedInterfaces[0].url` and would have found no endpoint at
     * all.
     */
    supportedInterfaces: [
      {
        url: `${base}/a2a/v1`,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      },
    ],

    /**
     * Retained alongside `supportedInterfaces` for v0.3 clients. Removing them
     * would break any caller already pointed at this hub, and they cost two
     * fields — so they stay until there is a reason to believe nothing reads
     * them. They must keep naming the same endpoint as
     * `supportedInterfaces[0]`, which a conformance case asserts.
     */
    url: `${base}/a2a/v1`,
    preferredTransport: 'JSONRPC',

    capabilities: {
      // Declared false rather than advertised and stubbed. A caller that sees
      // `streaming: true` and gets a non-stream has no recourse; one that sees
      // false polls `tasks/get`, which works.
      streaming: false,
      // Push is supported, but only to an origin the workspace owner already
      // authorised for that agent at enrolment — see tasks/pushNotificationConfig/set.
      pushNotifications: true,
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
