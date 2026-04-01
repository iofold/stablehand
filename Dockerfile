# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-slim AS build

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

WORKDIR /app

# Copy workspace config and lockfile first for layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./

# Copy all package.json and config files to resolve workspace dependencies
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/ctxmill/package.json packages/ctxmill/tsconfig.json packages/ctxmill/
COPY packages/sandbox-daemon/package.json packages/sandbox-daemon/tsconfig.json packages/sandbox-daemon/
COPY packages/proto/package.json packages/proto/tsconfig.build.json packages/proto/
COPY packages/ui/package.json packages/ui/vite.config.ts packages/ui/tsconfig.json packages/ui/
COPY packages/ui/postcss.config.js packages/ui/tailwind.config.ts packages/ui/index.html packages/ui/

# Copy example package.json files so pnpm workspace resolution doesn't fail
COPY packages/examples/ packages/examples/
COPY packages/create-ctxmill/package.json packages/create-ctxmill/

# Install all dependencies (including devDependencies for building)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/shared/src/ packages/shared/src/
COPY packages/ctxmill/src/ packages/ctxmill/src/
COPY packages/sandbox-daemon/src/ packages/sandbox-daemon/src/
COPY packages/proto/gen/ packages/proto/gen/
COPY packages/ui/src/ packages/ui/src/

# Build shared first (composite project, used by both orchestrator and UI)
RUN cd packages/shared && npx tsc --build

# Build proto (compile .ts to .js so Node 22 strip-only mode can handle enums)
RUN cd packages/proto && npx tsc -p tsconfig.build.json

# Build sandbox-daemon (ctxmill depends on it via re-export stubs)
RUN pnpm --filter @ctxmill/sandbox-daemon build

# Build orchestrator
RUN pnpm --filter ctxmill build

# Build UI
RUN pnpm --filter @ctxmill/ui build

# ── Stage 2: Orchestrator Runtime ─────────────────────────────────────────────
FROM node:22-slim AS orchestrator

RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/ctxmill/package.json packages/ctxmill/
COPY packages/sandbox-daemon/package.json packages/sandbox-daemon/
COPY packages/proto/package.json packages/proto/

COPY packages/examples/ packages/examples/
COPY packages/create-ctxmill/package.json packages/create-ctxmill/
COPY packages/ui/package.json packages/ui/

RUN pnpm install --frozen-lockfile --prod --shamefully-hoist

COPY --from=build /app/packages/shared/dist/ packages/shared/dist/
COPY --from=build /app/packages/ctxmill/dist/ packages/ctxmill/dist/
COPY --from=build /app/packages/sandbox-daemon/dist/ packages/sandbox-daemon/dist/
COPY --from=build /app/packages/proto/dist/ packages/proto/dist/
COPY --from=build /app/packages/proto/gen/ packages/proto/gen/

COPY packages/examples/kitchen-sink/tools/ /app/project/tools/
COPY packages/examples/kitchen-sink/agents/ /app/project/agents/

EXPOSE 3001

WORKDIR /app/project
CMD ["node", "--experimental-strip-types", "/app/packages/ctxmill/dist/cli/index.js", "dev"]

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
