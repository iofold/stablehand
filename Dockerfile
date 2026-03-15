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
COPY packages/ui/src/ packages/ui/src/

# Build shared first (composite project, used by both orchestrator and UI)
RUN cd packages/shared && npx tsc --build

# Build orchestrator
RUN pnpm --filter ctxmill build

# Build UI
RUN pnpm --filter @ctxmill/ui build

# ── Stage 2: Orchestrator Runtime ─────────────────────────────────────────────
FROM node:22-slim AS orchestrator

RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

WORKDIR /app

# Copy workspace config
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/ctxmill/package.json packages/ctxmill/

# Copy example package.json files for workspace resolution
COPY packages/examples/ packages/examples/
COPY packages/create-ctxmill/package.json packages/create-ctxmill/
COPY packages/ui/package.json packages/ui/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built output
COPY --from=build /app/packages/shared/dist/ packages/shared/dist/
COPY --from=build /app/packages/ctxmill/dist/ packages/ctxmill/dist/

EXPOSE 3001

CMD ["node", "packages/ctxmill/dist/cli/index.js", "dev"]

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
