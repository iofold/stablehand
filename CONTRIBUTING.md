# Contributing to CTXMill

## Prerequisites

- Docker with the Compose plugin (`docker compose`)
- Node.js 22+
- pnpm

## Getting Started

```bash
git clone <repo-url>
cd ctxmill
cp .env.example .env
# Add the API keys you need

docker compose up --build -d
```

> Sandbox harness images are included in the default compose stack. They build automatically with `docker compose up --build -d`.

The UI is available at `http://localhost:3200` and the API at `http://localhost:3002`.

## Development Workflow

Start the stack:

```bash
docker compose up --build -d
```

> Sandbox harness images are included in the default compose stack. They build automatically with `docker compose up --build -d`.

View logs:

```bash
docker compose logs -f
```

Stop the stack:

```bash
docker compose down
```

## Project Layout

```text
packages/
  ctxmill/           Core runtime, orchestrator, harness registry, tools, workspace
  sandbox-daemon/    gRPC daemon + harness adapters that run inside sandbox containers
  proto/             Protocol Buffers for sandbox gRPC IPC
  ui/                Frontend (React, SSE, Zustand, Tailwind)
  shared/            Shared API and event types
  client/            Typed browser client for AG-UI streaming integrations
  react/             React components and hooks for AG-UI chat integrations
  create-ctxmill/    Starter-project scaffold
  examples/          Example projects
```

## Testing

Run the main Vitest suite:

```bash
pnpm install
pnpm test
pnpm lint          # ESLint across packages and tests
pnpm typecheck     # TypeScript type checking across all packages
```

Run package builds:

```bash
pnpm -r build
```

Docker helpers:

```bash
pnpm docker:up     # Start Docker stack in background
pnpm docker:down   # Stop Docker stack
pnpm docker:logs   # Tail Docker logs
pnpm docker:clean  # Stop and remove volumes
```

Run the Playwright suite:

```bash
# Requires the Docker stack to already be running on localhost:3200 / :3002
pnpm test:e2e
```

Recommended verification before opening a PR:

```bash
pnpm test
pnpm -r build
pnpm test:e2e
```

## CI Pipeline

GitHub Actions (`.github/workflows/ci.yml`) runs these jobs on every push and PR:

| Job | What it does |
|-----|-------------|
| **test** | Installs, builds, lints, typechecks, and runs the backend (strict mode) and UI Vitest suites on a Node 22/24 matrix |
| **audit** | Runs `pnpm audit:prod` against production dependencies |
| **e2e** | Spins up the Docker stack and runs the required `@smoke` Playwright gate against it (needs `test`) |
| **images** | Builds the deployable orchestrator, UI, and per-harness sandbox Docker images (needs `test`) |
| **dev2-deploy** | Gated on `DEV2_DEPLOY_ENABLED`; deploys to the dev2 k3s target and runs the required smoke suite (ADR 009, needs `e2e` + `images`) |

`test`, `audit`, `e2e`, and `images` must pass before merge; `dev2-deploy` runs only when enabled.

## Notes on Current Architecture

- The repo is Docker-first today.
- Agent harnesses execute inside Docker containers via the sandbox subsystem (`packages/ctxmill/src/sandbox/`). The orchestrator creates a container per run, communicates via gRPC, and supports checkpoint/resume, timeout enforcement, and orphan cleanup.
- The maintained example project is `packages/examples/kitchen-sink`.

## Pull Request Guidelines

- Keep each PR focused.
- Add or update tests for behavior changes.
- Preserve TypeScript strictness.
- Do not silently update current-state docs with future-state claims.
- If you touch planning docs, mark whether the plan is active, historical, or obsolete.
