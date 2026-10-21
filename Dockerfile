# syntax=docker/dockerfile:1

# Node 24 matches the dev toolchain. node:sqlite is built in, so there is no
# native module to compile and no build toolchain needed in either stage.
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.3.4 --activate

# Manifests first, so a source-only change does not reinstall dependencies.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./
COPY contracts/package.json contracts/
COPY hub/package.json hub/
COPY delivery/package.json delivery/
COPY sdk/typescript/package.json sdk/typescript/
COPY adapters/mcp/package.json adapters/mcp/
COPY cli/package.json cli/
RUN pnpm install --frozen-lockfile

COPY . .
# No `pnpm prune --prod`: in a pnpm workspace it removes the node_modules
# links to the sibling packages the app imports at runtime, so the image builds
# fine and then fails with MODULE_NOT_FOUND on start.
RUN pnpm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app /app

# State lives on a volume so pilot data survives a restart.
RUN mkdir -p /data/artifacts && chown -R node:node /data
USER node

ENV AGENTBRIDGE_DB=/data/agentbridge.sqlite \
    AGENTBRIDGE_ARTIFACTS=/data/artifacts \
    PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The composition root lives in delivery (see delivery/src/main.ts).
CMD ["node", "delivery/dist/main.js"]
