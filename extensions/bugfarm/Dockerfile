# Bugfarm worker. Build from the repository root, so the workspace lockfile
# pins every dependency:
#   docker build -f extensions/bugfarm/Dockerfile -t stablehand-bugfarm .
#
# The build stage bundles the server (with the workspace packages it uses:
# contracts, client, manifest) into one file and builds the board page; the
# runtime image holds only that output and Node, with no node_modules.
#
# This image serves the board, the ingest API and the floor tools. It has no
# Docker or Harbor tooling, so campaigns run from a worker on the host (see
# README: "A campaign, on a dedicated box").

FROM node:22-slim AS build
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/client/package.json packages/client/
COPY packages/manifest/package.json packages/manifest/
COPY extensions/bugfarm/package.json extensions/bugfarm/
RUN pnpm install --frozen-lockfile --filter "@stablehand-ext/bugfarm..."
COPY packages/contracts/ packages/contracts/
COPY packages/client/ packages/client/
COPY packages/manifest/ packages/manifest/
COPY extensions/bugfarm/ extensions/bugfarm/
RUN pnpm --filter "@stablehand-ext/bugfarm^..." build && pnpm --filter @stablehand-ext/bugfarm build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/extensions/bugfarm/dist ./dist
COPY --from=build /app/extensions/bugfarm/agents ./agents
USER node
ENV NODE_ENV=production \
    BUGFARM_PORT=8095
EXPOSE 8095
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD wget -q -O /dev/null http://127.0.0.1:8095/healthz || exit 1
CMD ["node", "dist/server/main.js"]
