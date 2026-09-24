# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-slim AS build

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

WORKDIR /app

# Copy workspace config and lockfile first for layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./

# Copy all package.json and config files to resolve workspace dependencies
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/contracts/package.json packages/contracts/tsconfig.json packages/contracts/
COPY packages/manifest/package.json packages/manifest/tsconfig.json packages/manifest/
COPY packages/client/package.json packages/client/tsconfig.json packages/client/
COPY packages/react/package.json packages/react/tsconfig.json packages/react/tsconfig.typecheck.json packages/react/
COPY packages/stablehand/package.json packages/stablehand/tsconfig.json packages/stablehand/
COPY packages/sandbox-daemon/package.json packages/sandbox-daemon/tsconfig.json packages/sandbox-daemon/
COPY packages/proto/package.json packages/proto/tsconfig.build.json packages/proto/
COPY packages/ui/package.json packages/ui/vite.config.ts packages/ui/tsconfig.json packages/ui/
COPY packages/ui/postcss.config.js packages/ui/tailwind.config.ts packages/ui/index.html packages/ui/

# Copy example package.json files so pnpm workspace resolution doesn't fail
COPY packages/examples/ packages/examples/
COPY packages/create-stablehand/package.json packages/create-stablehand/

# Install all dependencies (including devDependencies for building)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/shared/src/ packages/shared/src/
COPY packages/contracts/src/ packages/contracts/src/
COPY packages/manifest/src/ packages/manifest/src/
COPY packages/client/src/ packages/client/src/
COPY packages/react/src/ packages/react/src/
COPY packages/stablehand/src/ packages/stablehand/src/
COPY packages/sandbox-daemon/src/ packages/sandbox-daemon/src/
COPY packages/proto/gen/ packages/proto/gen/
COPY packages/ui/src/ packages/ui/src/

# Build strict runtime contracts first (shared re-exports contract types)
RUN pnpm --filter @stablehand/contracts build

# Build shared (composite project, used by both orchestrator and UI)
RUN cd packages/shared && npx tsc --build

# Build proto (compile .ts to .js so Node 22 strip-only mode can handle enums)
RUN cd packages/proto && npx tsc -p tsconfig.build.json

# Build canonical manifest parsing consumed by the orchestrator
RUN pnpm --filter @stablehand/manifest build

# Build sandbox-daemon (stablehand depends on it via re-export stubs)
RUN pnpm --filter @stablehand/sandbox-daemon build

# Build orchestrator
RUN pnpm --filter stablehand build

# Build UI
RUN pnpm --filter @stablehand/ui build

# ── Stage 2: Orchestrator Runtime ─────────────────────────────────────────────
FROM node:22-slim AS orchestrator

RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/contracts/package.json packages/contracts/
COPY packages/manifest/package.json packages/manifest/
COPY packages/client/package.json packages/client/
COPY packages/react/package.json packages/react/
COPY packages/stablehand/package.json packages/stablehand/
COPY packages/sandbox-daemon/package.json packages/sandbox-daemon/
COPY packages/proto/package.json packages/proto/

COPY packages/examples/ packages/examples/
COPY packages/create-stablehand/package.json packages/create-stablehand/
COPY packages/ui/package.json packages/ui/

RUN pnpm install --frozen-lockfile --prod --shamefully-hoist

COPY --from=build /app/packages/shared/dist/ packages/shared/dist/
COPY --from=build /app/packages/contracts/dist/ packages/contracts/dist/
COPY --from=build /app/packages/manifest/dist/ packages/manifest/dist/
COPY --from=build /app/packages/stablehand/dist/ packages/stablehand/dist/
COPY --from=build /app/packages/sandbox-daemon/dist/ packages/sandbox-daemon/dist/
COPY --from=build /app/packages/proto/dist/ packages/proto/dist/
COPY --from=build /app/packages/proto/gen/ packages/proto/gen/

COPY packages/examples/kitchen-sink/tools/ /app/project/tools/
COPY packages/examples/kitchen-sink/agents/ /app/project/agents/

EXPOSE 3001

WORKDIR /app/project
CMD ["node", "--experimental-strip-types", "/app/packages/stablehand/dist/cli/index.js", "dev"]

# ── Stage 3: UI (nginx) ──────────────────────────────────────────────────────
FROM nginx:alpine AS ui

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built UI assets
COPY --from=build /app/packages/ui/dist/ /usr/share/nginx/html/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
