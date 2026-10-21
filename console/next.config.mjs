/**
 * The console is a static UI plus a path-preserving proxy. It is NOT an API.
 *
 * Every /v1/* call is rewritten to the hub unchanged, which does two things:
 * same-origin requests need no CORS on the hub, and the path the browser
 * signed is the path the hub verifies. A proxy that rewrote the path — say
 * /api/hub/v1/approvals — would invalidate every signature, and the tempting
 * fix is to re-sign on the server, which is exactly where the owner key must
 * never be.
 *
 * Nothing here reads the owner key. There is no route handler that could.
 */
const HUB_URL = process.env.AGENTBRIDGE_URL ?? 'http://localhost:8080';

/** @type {import('next').NextConfig} */
export default {
  async rewrites() {
    return [{ source: '/v1/:path*', destination: `${HUB_URL}/v1/:path*` }];
  },
};
