# CTXMill

**A self-hosted framework for building AI products with a multi-harness agent runtime, streaming UI, and human-in-the-loop controls.**

CTXMill ships a Docker-first stack with a Fastify orchestrator, PostgreSQL persistence, a React UI, SSE streaming, event-triggered background runs, and workspace isolation for agent sessions.

## What Ships Today

- **Multi-harness agent runtime**: LangGraph, OpenAI Agents, Claude Agents, Vercel AI, and PI Agent
- **Streaming UI**: SSE-based run and message streaming to the frontend
- **A2UI chart rendering**: agent-driven charts and structured visual blocks
- **Human-in-the-loop (HITL)**: approval cards, editable documents, and structured field requests
- **Event bus and triggers**: persisted event flow plus background-run triggers
- **Workspace isolation**: mock and `fuse-overlayfs` session overlays
- **Learning pipeline**: optional trace reflection and knowledge updates
- **PostgreSQL persistence**: agents, runs, messages, events, traces, triggers, and secrets
- **React operations UI**: dashboard, chat, knowledge, files, triggers, tools, and run detail views
- **Scaffold CLI**: `create-ctxmill` for a generic starter project

## Current Boundaries

- The supported workflow in this repo is the Docker stack.
- Agent harnesses execute inside Docker containers (one per run) via the sandbox subsystem.
- Firecracker sandbox execution is planned, not shipped.
- The Docker preset currently uses PostgreSQL for system persistence, but pgvector-backed knowledge search is not wired into the active runtime yet.

## Quick Start

```bash
# 1. Clone and enter the project
git clone <repo-url>
cd ctxmill

# 2. Configure your environment
cp .env.example .env
# Add the API keys your agents need

# 3. Build and start the stack
docker compose up --build -d

# 4. Open the UI
# http://localhost:3200
```

> To enable full sandbox execution, add the sandbox profile: `docker compose --profile sandbox up --build -d`

### Common Commands

```bash
# View logs
docker compose logs -f

# Stop services
docker compose down

# Run the Vitest suite
pnpm test

# Run Playwright against an already-running stack
pnpm test:e2e
```

### Service Endpoints

| Service | URL |
|---------|-----|
| UI | http://localhost:3200 |
| API | http://localhost:3002 |
| PostgreSQL | localhost:5433 |
| Egress proxy (sandbox profile) | localhost:3128 |
| PgAdmin (debug profile) | http://localhost:5050 |

## Project Structure

```text
packages/
  ctxmill/              Core runtime and orchestrator
    src/
      a2ui/             Agent-to-UI structured block extraction
      agent/            Agent discovery and manifest loading
      cli/              `ctxmill dev` and `ctxmill chat`
      config/           Presets, factories, DI container
      database/         PostgreSQL schema, repository, migrations
      events/           Typed event bus, triggers, wait primitives
      harness/          Harness adapters (5 shipped)
      knowledge/        Knowledge store abstractions and implementations
      learning/         Trace reflection and learning pipeline
      llm/              LLM abstraction layer and provider factory
      manifest/         YAML manifest parsing and conversion
      orchestrator/     Fastify server, SSE, HITL, routes
      sandbox/          Container lifecycle, gRPC daemon, checkpoint/resume
      secrets/          Encrypted secret storage
      skills/           Skill loader (SKILL.md format)
      tool/             Tool executors and providers
      util/             Shared runtime utilities
      workspace/        Session-scoped workspace environments
  proto/                Protocol Buffers for sandbox gRPC IPC
  ui/                   React frontend (Vite + Tailwind)
  shared/               Shared event and API types
  create-ctxmill/       Generic starter-project scaffold
  examples/
    kitchen-sink/       Multi-harness example project and tests
docs/
  architecture.md       Current shipped architecture
  plans/                Historical and active planning docs
tests/
  unit/
  integration/
  e2e/
  compliance/
  contract/
  sandbox/
```

## Example Surface

The maintained example in this repo is the kitchen-sink project in [packages/examples/kitchen-sink](/path/to/stablehand/packages/examples/kitchen-sink). It exercises the shipped harness set, shared tools, and event-triggered chaining across multiple agents.

The scaffolded starter from `create-ctxmill` is intentionally generic. It creates a single assistant agent with file, knowledge, and search-style helper tools rather than a domain-specific finance, supply-chain, or marketing template.

## UI Surface

The shipped UI includes:

- Dashboard
- Agent chat
- Agent detail
- Run detail
- Events
- Tools
- Agent flow
- Knowledge
- Triggers
- Settings
- Overview, knowledge, runs, tools, files, subagents, and secrets tabs inside agent detail

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js, TypeScript |
| Server | Fastify |
| Persistence | PostgreSQL |
| Frontend | React, Vite, Tailwind CSS |
| State | Zustand |
| Agent harnesses | LangGraph, OpenAI Agents, Claude Agents, Vercel AI, PI Agent |
| Tool providers | Local, MCP, HTTP, Composio |
| Testing | Vitest, Playwright |
| Monorepo | pnpm workspaces |

## Architecture Notes

The current architecture document is [docs/architecture.md](/path/to/stablehand/docs/architecture.md). Future sandbox execution work is tracked in [docs/plans/2026-03-17-sandbox-execution-requirements.md](/path/to/stablehand/docs/plans/2026-03-17-sandbox-execution-requirements.md).

## License

MIT
