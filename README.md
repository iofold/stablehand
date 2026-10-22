# Stablehand

**A self-hosted framework for building AI products with a multi-harness agent runtime, streaming UI, and human-in-the-loop controls.**

Stablehand ships a Docker-first stack with a Fastify orchestrator, PostgreSQL persistence, authenticated HTTP APIs, a React UI, durable SSE streaming, event-triggered background runs, and workspace isolation for agent sessions.

## What Ships Today

- **Multi-harness agent runtime**: LangGraph, Claude Agents, and PI Agent
- **Streaming UI**: durable SSE-based run and message streaming to the frontend
- **Control-plane auth**: operator master token plus revocable, capability-scoped keys for extensions
- **A2UI chart rendering**: agent-driven charts and structured visual blocks
- **Human-in-the-loop (HITL)**: approval cards, editable documents, and structured field requests
- **Canonical event spine**: persisted `event_store` replay plus background-run triggers
- **Workspace isolation**: session-scoped workspace diff capture/restore during suspend/resume
- **Artifact storage**: S3/MinIO-backed persistent file upload/download with signed URLs
- **System settings**: runtime-configurable knobs with DB persistence and Settings UI
- **External learning hooks**: run lifecycle, message, tool, and feedback events for webhook-driven learners
- **PostgreSQL persistence**: agents, runs, messages, events, triggers, and secrets
- **React operations UI**: dashboard, chat, analytics, events, artifacts, triggers, tools, access keys, and session detail views
- **Cost control**: per-agent and per-tag budget policies, model-gateway routing, and spend reconciliation with honest settlement of lost evidence
- **Scaffold CLI**: `create-stablehand` for a generic starter project

## Current Boundaries

- The supported workflow in this repo is the Docker stack.
- Agent harnesses execute inside Docker containers (one per run) via the sandbox subsystem.
- Firecracker sandbox execution is planned, not shipped.
- The default container wires the Local, per-agent HTTP, Artifact, and Browser tool providers. MCP and Composio provider classes are exported from `packages/stablehand/src/tool/providers/`, but the default stack does not register them, so agents cannot reach MCP servers or Composio tools out of the box.
- System persistence uses PostgreSQL. Stablehand does not ship a built-in knowledge/RAG search layer; the previously planned pgvector-backed knowledge search was removed and is not part of the active runtime.

## Quick Start

```bash
# 1. Clone and enter the project
git clone https://github.com/iofold/stablehand.git
cd stablehand

# 2. Configure your environment
cp .env.example .env
# Required for the production-labeled Docker stack:
echo "SECRET_MASTER_KEY=$(openssl rand -hex 32)" >> .env
echo "STABLEHAND_API_TOKEN=$(openssl rand -hex 32)" >> .env
# Add the API keys your agents need, such as OPENAI_API_KEY or ANTHROPIC_API_KEY.

# 3. Build and start the stack
docker compose up --build -d

# 4. Open the UI
# http://localhost:3200
# Enter the master STABLEHAND_API_TOKEN when the TokenGate prompts.
```

> Sandbox harness images are included in the default compose stack. They build automatically with `docker compose up --build -d`.

The base stack needs no external networks or reverse proxy. To publish the UI on your own domain through an existing Traefik instance, add the optional overlay in [deploy/compose/traefik](deploy/compose/traefik/docker-compose.yml) and set `STABLEHAND_DOMAIN`:

```bash
COMPOSE_FILE=docker-compose.yml:deploy/compose/traefik/docker-compose.yml \
STABLEHAND_DOMAIN=stablehand.example.com \
  docker compose up --build -d
```

### Common Commands

```bash
# View logs
docker compose logs -f

# Stop services
docker compose down

# Run the Vitest suite
pnpm test

# Run browser E2E certification against an already-running stack
# (see docs/e2e-testing-journey.md)
```

### Service Endpoints

| Service | URL |
|---------|-----|
| UI | http://localhost:3200 |
| API | http://localhost:3002 |
| PostgreSQL | localhost:5433 |
| Sandbox egress proxy (internal agents network only) | egress:8080 |
| PgAdmin (debug profile) | http://localhost:5050 |

## Project Structure

```text
packages/
  stablehand/              Core runtime and orchestrator
    src/
      a2ui/             Agent-to-UI structured block extraction
      agent/            Agent discovery and manifest loading
      artifact/         Artifact storage (S3/MinIO) and daemon tools
      cli/              `stablehand dev` and `stablehand chat`
      config/           Presets, factories, DI container
      database/         PostgreSQL schema, repository, migrations
      events/           Typed event bus, triggers, wait primitives
      harness/          Harness registry and interfaces (3 shipped: LangGraph, Claude Agents, PI Agent)
      manifest/         YAML manifest parsing and conversion
      orchestrator/     Fastify server, SSE, HITL, routes
      sandbox/          Container lifecycle, gRPC daemon, checkpoint/resume
      secrets/          Encrypted secret storage
      settings/         Runtime system configuration backed by DB/env overrides
      tool/             Tool executors and providers
      util/             Shared runtime utilities
      workspace/        Session-scoped workspace environments
  sandbox-daemon/       @stablehand/sandbox-daemon — gRPC daemon running inside harness
                        containers: harness adapters, tool proxy, proto-convert, checkpoint
  proto/                Protocol Buffers for sandbox gRPC IPC
  ui/                   React frontend (Vite + Tailwind)
  shared/               Shared event and API types
  client/               @stablehand/client — typed browser client for AG-UI streaming
  react/                @stablehand/react — React components and hooks for AG-UI chat
  create-stablehand/       Generic starter-project scaffold
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

The maintained example in this repo is the kitchen-sink project in [packages/examples/kitchen-sink](packages/examples/kitchen-sink). It exercises the shipped harness set, shared tools, and event-triggered chaining across multiple agents.

The scaffolded starter from `create-stablehand` is intentionally generic. It creates a single assistant agent with file, knowledge, and search-style helper tools rather than a domain-specific finance, supply-chain, or marketing template.

## UI Surface

The shipped UI includes:

- Dashboard
- Events
- Tools
- Agent flow
- Triggers
- Artifacts
- Settings
- Settings → Access keys for scoped extension credentials
- Agent conversation/session views
- Agent detail with overview, sessions, tools, files, artifacts, and secrets tabs

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js, TypeScript |
| Server | Fastify |
| Persistence | PostgreSQL |
| Frontend | React, Vite, Tailwind CSS |
| State | Zustand |
| Agent harnesses | LangGraph, Claude Agents, PI Agent |
| Tool providers | Local, per-agent HTTP, Artifact and Browser (when S3 is configured) |
| Testing | Vitest, agent-browser E2E certification |
| Monorepo | pnpm workspaces |

## Documentation

### Getting Started
| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System architecture, component interactions, data flow |
| [Codebase Map](docs/codebase-map.md) | Current package map, runtime flows, capabilities, and gotchas |
| [One-Pager](docs/stablehand-one-pager.md) | High-level overview of what Stablehand is and does |
| [API Reference](docs/api-reference.md) | Complete REST API and SSE streaming protocol reference |
| [Extending Stablehand](EXTENDING.md) | Current Git-first extension handshake, state ownership, and UI boundary |
| [Scoped API Keys](docs/scoped-api-keys.md) | Capability map, creation, rotation, revocation, and verification |
| [Environment Variables](docs/environment-variables.md) | Complete env var reference — core, sandbox, AI, storage, and system settings |
| [Harness Comparison](docs/harness-comparison.md) | Feature matrix for choosing between LangGraph, Claude Agents, and PI Agent |
| [Custom Providers](docs/custom-providers.md) | Using OpenRouter, Cloudflare AI Gateway, or any OpenAI-compatible endpoint |

### Guides
| Document | Description |
|----------|-------------|
| [AG-UI Compatibility](docs/ag-ui-compat.md) | Drop-in AG-UI renderer support (CopilotKit, agui-hooks, assistant-ui) |
| [React Chat Integration](docs/integrate-chat-ui.md) | Embed the Stablehand streaming chat UI with A2UI and HITL support |
| [Embedding in Foreign Stacks](docs/embedding-in-foreign-stacks.md) | Integrating Stablehand into your existing application |
| [Writing Tool Providers](docs/writing-tool-providers.md) | Adding custom tools and tool providers |
| [Writing Skills](docs/writing-skills.md) | Current status of SDK-native workspace skills |
| [Programmatic Tool Calling](docs/programmatic-tool-calling.md) | PTC API for structured tool invocations |
| [HITL Approval Flow](docs/HITL_APPROVAL_FLOW.md) | Human-in-the-loop approval cards, editable docs, and field requests |
| [LangSmith Tracing](docs/langsmith-tracing.md) | Setting up observability with LangSmith |

### Operations
| Document | Description |
|----------|-------------|
| [Checkpoint & Resume](docs/checkpoint-resume.md) | Session suspend, checkpoint, and resume lifecycle |
| [Container Lifecycle](docs/container-lifecycle.md) | Idle checkpointing, restore, and reconciliation |
| [Observability](docs/observability.md) | Monitoring, logging, and debugging your deployment |
| [Debugging Harnesses](docs/debugging-harnesses.md) | Troubleshooting agent execution inside sandbox containers |
| [Event Pipeline Mapping](docs/event-pipeline-mapping.md) | Proto → TypeScript → AG-UI event conversion reference |

## License

MIT
