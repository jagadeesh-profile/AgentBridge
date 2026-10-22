/**
 * JSON-RPC 2.0 envelope handling for the A2A endpoint.
 *
 * Error codes: -32700…-32603 are JSON-RPC's own. The -32001…-32006 block is
 * A2A's reserved application range. They are centralised here so that if the
 * published spec numbers them differently, one edit fixes every handler —
 * worth doing because a wrong code is the kind of thing a conformance suite
 * catches long after the code is written.
 */
export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  // A2A application errors.
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotificationNotSupported: -32003,
  unsupportedOperation: -32004,
  contentTypeNotSupported: -32005,
} as const;

export type RpcId = string | number | null;

export interface RpcRequest {
  jsonrpc: '2.0';
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    /**
     * The id from the request that failed, when it could be read.
     *
     * Carried on the error because validation throws before the handler has
     * an id of its own, and JSON-RPC requires echoing it — a client
     * correlating by id otherwise waits forever for a reply it can match.
     */
    readonly id?: RpcId,
  ) {
    super(message);
    this.name = 'RpcFailure';
  }
}

export const ok = (id: RpcId, result: unknown) => ({ jsonrpc: '2.0' as const, id, result });

export const err = (id: RpcId, code: number, message: string, data?: unknown) => ({
  jsonrpc: '2.0' as const,
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) } satisfies RpcError,
});

/**
 * Validates the envelope before any handler sees it.
 *
 * Returns the id separately so a malformed request can still be answered with
 * the id it supplied — JSON-RPC requires echoing it, and a client correlating
 * by id otherwise hangs waiting for a reply it can match.
 */
export function parseEnvelope(body: unknown): { id: RpcId; request: RpcRequest } {
  const rawId = (body as { id?: unknown } | null)?.id;
  const id: RpcId = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    // Batch requests are rejected deliberately: A2A does not use them, and
    // accepting them would mean deciding how partial failure interacts with
    // the approval gate.
    throw new RpcFailure(
      RPC.invalidRequest,
      'expected a single JSON-RPC 2.0 object',
      undefined,
      id,
    );
  }
  const obj = body as Record<string, unknown>;

  if (obj.jsonrpc !== '2.0') {
    throw new RpcFailure(RPC.invalidRequest, 'jsonrpc must be "2.0"', undefined, id);
  }
  if (typeof obj.method !== 'string' || obj.method === '') {
    throw new RpcFailure(RPC.invalidRequest, 'method is required', undefined, id);
  }
  return {
    id,
    request: { jsonrpc: '2.0', id, method: obj.method, params: obj.params },
  };
}
