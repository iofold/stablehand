# CTXMill

**A self-hosted framework for building AI products with a multi-harness agent runtime, streaming UI, and human-in-the-loop controls.**

CTXMill ships a Docker-first stack with a Fastify orchestrator, PostgreSQL persistence, a React UI, SSE streaming, event-triggered background runs, and workspace isolation for agent sessions.

## What Ships Today

- **Multi-harness agent runtime**: LangGraph, Claude Agents, and PI Agent
- **Streaming UI**: SSE-based run and message streaming to the frontend
- **A2UI chart rendering**: agent-driven charts and structured visual blocks
- **Human-in-the-loop (HITL)**: approval cards, editable documents, and structured field requests
- **Event bus and triggers**: persisted event flow plus background-run triggers
- **Workspace isolation**: session-scoped workspace diff capture/restore during suspend/resume
- **Artifact storage**: S3/MinIO-backed persistent file upload/download with signed URLs
- **System settings**: 14 runtime-configurable knobs with DB persistence and Settings UI
- **External learning hooks**: run lifecycle, message, tool, and feedback events for webhook-driven learners
- **PostgreSQL persistence**: agents, runs, messages, events, triggers, and secrets
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

> Sandbox harness images are included in the default compose stack. They build automatically with `docker compose up --build -d`.

### Common Commands

```bash
# View logs
docker compose logs -f

# Stop services
docker compose down

# Run the Vitest suite
pnpm test

# Run browser E2E certification against an already-running stack
agent-browser skills get core
agent-browser skills get dogfood
# Then follow docs/verification/e2e-testing-journey.md
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
      artifact/         Artifact storage (S3/MinIO) and daemon tools
      cli/              `ctxmill dev` and `ctxmill chat`
      config/           Presets, factories, DI container
      database/         PostgreSQL schema, repository, migrations
      events/           Typed event bus, triggers, wait primitives
      harness/          Harness adapters (3 shipped: LangGraph, Claude Agents, PI Agent)
      knowledge/        Knowledge store abstractions and implementations
      manifest/         YAML manifest parsing and conversion
      orchestrator/     Fastify server, SSE, HITL, routes
      sandbox/          Container lifecycle, gRPC daemon, checkpoint/resume
      secrets/          Encrypted secret storage
      settings/         Runtime system configuration (17 knobs)
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
| Agent harnesses | LangGraph, Claude Agents, PI Agent |
| Tool providers | Local, MCP, HTTP, Composio, Artifact (S3) |
| Testing | Vitest, agent-browser E2E certification |
| Monorepo | pnpm workspaces |

## Documentation

### Getting Started
| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System architecture, component interactions, data flow |
| [One-Pager](docs/ctxmill-one-pager.md) | High-level overview of what CTXMill is and does |
| [API Reference](docs/api-reference.md) | Complete REST API and SSE streaming protocol reference |
| [Environment Variables](docs/environment-variables.md) | Complete env var reference — core, sandbox, AI, storage, and system settings |
| [Harness Comparison](docs/harness-comparison.md) | Feature matrix for choosing between LangGraph, Claude Agents, and PI Agent |
| [Custom Providers](docs/custom-providers.md) | Using OpenRouter, Cloudflare AI Gateway, or any OpenAI-compatible endpoint |

### Guides
| Document | Description |
|----------|-------------|
| [AG-UI Compatibility](docs/ag-ui-compat.md) | Drop-in AG-UI renderer support (CopilotKit, agui-hooks, assistant-ui) |
| [Embedding in Foreign Stacks](docs/embedding-in-foreign-stacks.md) | Integrating CTXMill into your existing application |
| [Writing Tool Providers](docs/writing-tool-providers.md) | Adding custom tools (Local, MCP, HTTP, Composio) |
| [Writing Skills](docs/writing-skills.md) | Creating agent skills with SKILL.md format |
| [Programmatic Tool Calling](docs/programmatic-tool-calling.md) | PTC API for structured tool invocations |
| [HITL Approval Flow](docs/HITL_APPROVAL_FLOW.md) | Human-in-the-loop approval cards, editable docs, and field requests |
| [LangSmith Tracing](docs/langsmith-tracing.md) | Setting up observability with LangSmith |

### Operations
| Document | Description |
|----------|-------------|
| [Checkpoint & Resume](docs/checkpoint-resume.md) | Session suspend, checkpoint, and resume lifecycle |
| [Container Lifecycle](docs/container-lifecycle.md) | Idle timeout, freeze promotion, and reconciliation |
| [Observability](docs/observability.md) | Monitoring, logging, and debugging your deployment |
| [Debugging Harnesses](docs/debugging-harnesses.md) | Troubleshooting agent execution inside sandbox containers |
| [Event Pipeline Mapping](docs/event-pipeline-mapping.md) | Proto → TypeScript → AG-UI event conversion reference |
| [Deploying with Bhatti](docs/deploy-bhatti.md) | Firecracker microVM deployment |

## License

MIT
