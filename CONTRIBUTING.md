# Contributing to Stablehand

## Prerequisites

- Docker with the Compose plugin (`docker compose`)
- Node.js 22+
- pnpm

## Getting Started

Follow the [quickstart in the README](README.md#quickstart) to configure `.env` and start the stack. It fills `SECRET_MASTER_KEY` and `STABLEHAND_API_TOKEN` in place, which the production-mode compose stack requires.

The UI is at `http://localhost:3200` and the API at `http://localhost:3002`.

## Development Workflow

```bash
docker compose up --build -d   # rebuild and start, including the three sandbox harness images
docker compose logs -f         # follow logs
docker compose down            # stop
```

Changes under `packages/sandbox-daemon` only reach agents after the harness images are rebuilt; `docker compose up --build -d` does that.

## Project Layout

```text
packages/
  stablehand/           Core runtime, orchestrator, harness registry, tools, workspace
  sandbox-daemon/    gRPC daemon + harness adapters that run inside sandbox containers
  proto/             Protocol Buffers for sandbox gRPC IPC
  ui/                Frontend (React, SSE, Zustand, Tailwind)
  shared/            Shared API and event types
  client/            Typed browser client for AG-UI streaming integrations
  react/             React components and hooks for AG-UI chat integrations
  egress-proxy/      mitmproxy allowlist proxy, the sandboxes' only route out
  contracts/         Strict API and event schemas
  manifest/          YAML agent manifest parser
  create-stablehand/    Starter-project scaffold (not on npm yet)
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

`test`, `audit`, `e2e`, and `images` must pass before merge.

## Notes on Current Architecture

- The repo is Docker-first today.
- Agent harnesses execute inside Docker containers via the sandbox subsystem (`packages/stablehand/src/sandbox/`). The orchestrator creates a container per agent session, communicates via gRPC, and supports checkpoint/resume, timeout enforcement, and orphan cleanup.
- `packages/examples/kitchen-sink` is the default project baked into the orchestrator image; `packages/examples/overnight-analyst` is the scheduled-agent example the README quickstart runs.

## Pull Request Guidelines

- Keep each PR focused.
- Add or update tests for behavior changes.
- Preserve TypeScript strictness.
- Do not silently update current-state docs with future-state claims.
- If you touch planning docs, mark whether the plan is active, historical, or obsolete.
