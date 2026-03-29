# CTXMILL — PROJECT KNOWLEDGE BASE

**Generated:** 2026-03-26 · **Commit:** e2f30a0 · **Branch:** master

## OVERVIEW

Multi-harness agent runtime. Agents defined in YAML, execute inside Docker sandbox containers (gRPC IPC), stream AG-UI events to a React dashboard via SSE. PostgreSQL persistence, typed event bus with trigger-based agent chaining.

## STRUCTURE

```
packages/
  ctxmill/              Core runtime — orchestrator, 3 harnesses, sandbox, tools, events, DB (126 src files)
  ui/                   React dashboard — Vite, React 18, Zustand, Tailwind, SSE streaming (84 files)
  shared/               Types only — AG-UI events, API contracts (no build step, src/index.ts direct)
  proto/                Protobuf (buf) — HarnessService + OrchestratorService gRPC definitions
  create-ctxmill/       Scaffold CLI — generates new project from template
  examples/
    kitchen-sink/       3 agents (LangGraph, Claude, PI), 12 shared tools, event-chained
tests/
  unit/                 53 files — harness adapters, config, learning, sandbox, tools
  integration/          23 files — orchestrator scenarios, event flows, CRUD
  e2e/                  32 Playwright specs — chat, background runs, visual regression, visual QA
  compliance/           13 files — interface contract conformance via pluggable factories
  contract/             EMPTY — FUSE overlay tests removed (overlay abstractions deleted)
  sandbox/              4 files — container lifecycle, suspend/resume, harness integration
  stress/               Stress test agents and tools (not in main test suite)
  utils/                Shared helpers — test-db.ts, event-bus-test-helpers.ts
docs/
  architecture.md       Shipped architecture reference
  event-pipeline-mapping.md  Proto → TS → AG-UI event conversion map
  plans/                Historical planning docs (not current truth)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add a new harness | `packages/ctxmill/src/harness/` | Implement `AgentHarness`, register in `DefaultHarnessRegistry` |
| Add a tool provider | `packages/ctxmill/src/tool/providers/` | Implement `ToolProvider`, register in `DefaultToolRegistry` |
| Add an API route | `packages/ctxmill/src/orchestrator/routes/` | Fastify plugin pattern, register in `server.ts` |
| Add a UI page | `packages/ui/src/pages/` + `App.tsx` | Add route in App.tsx, nav item in Sidebar.tsx |
| Add a DB table | `packages/ctxmill/src/database/schema-pg.ts` | Drizzle ORM, add to `repository.ts` |
| Add an event | `packages/ctxmill/src/events/bus.ts` | Add to `EventMap` type, emit via `TypedEventBus` |
| Modify proto | `packages/proto/ctxmill/sandbox/v1/sandbox.proto` | Run `pnpm -C packages/proto build` to regenerate |
| Add agent to example | `packages/examples/kitchen-sink/agents/` | YAML manifest (`apiVersion: ctxmill.io/v1`) |
| Define a tool | Use `defineTool({ name, description, input: z.object(...), handler })` | Zod schema for input validation |
| Define an agent | Use `defineAgent({ tools, systemPrompt })` or YAML manifest | `{{knowledge}}` placeholder for dynamic injection |
| Understand DI wiring | `packages/ctxmill/src/config/container.ts` | `createContainer()` builds all services |
| Trace a run execution | `orchestrator/agent-run-service.ts` → `sandbox-run-service.ts` → `sandbox/runner.ts` | All runs go through sandbox containers |
| Understand session lifecycle | `orchestrator/sandbox-session-manager.ts` | Session state machine: pause → freeze → checkpoint |
| Configure runtime settings | `packages/ctxmill/src/settings/service.ts` | 17 system knobs, DB-persisted, Settings UI |
| Manage artifacts | `packages/ctxmill/src/artifact/artifact-store.ts` | S3/MinIO, signed URLs, daemon tools |

## CONVENTIONS

- **ESM with `.js` extensions** — All imports require `.js` suffix (NodeNext module resolution). Path aliases forbidden in source.
- **Barrel exports** — Each module has `index.ts` re-exporting public API
- **Constructor DI** — Services accept `Deps`/`Options` interface, stored as `private readonly` (209 instances)
- **Logger interface** — Each service defines its own local `Logger` interface, injected via constructor (no global logger)
- **Unused params** — Prefix with `_` (ESLint rule: `argsIgnorePattern: '^_'`)
- **Test naming** — `*.test.ts` for Vitest (never `.spec.ts`), `*.spec.ts` for Playwright only. Colocated in `__tests__/` or top-level `tests/`
- **Type naming** — `*Deps` (constructor deps), `*Options` (config), `*Provider` (pluggable), `*Config` (settings)
- **Constants** — `UPPER_SNAKE_CASE`, use `ReadonlySet<string>` for immutable collections
- **Error classes** — Only 2 custom: `EventTimeoutError`, `ContainerLimitError`. All else uses generic `Error`
- **Zod for tool input** — `z.object(...)` schema validation in all tool definitions
- **gRPC error codes** — Use `ConnectError` with `Code.*` (InvalidArgument, etc.)

## ANTI-PATTERNS

- **NEVER store secrets in checkpoints** — Secrets injected fresh on resume via tmpfs (`/run/secrets/config.json`), never persisted
- **NEVER suppress types** — No `as any`, `@ts-ignore`, `@ts-expect-error` (32 existing `as any` in source are documented tech debt from Zod/EventEmitter/Drizzle library limitations)
- **NEVER use empty catch blocks** — `catch(e) {}` forbidden
- **NEVER delete failing tests** to make CI pass
- **NEVER call harness.run() directly** — All execution goes through `SandboxRunService` → Docker containers
- **NEVER exceed checkpoint limits** — 5 MB checkpoint, 100 MB workspace tar. Oversized checkpoints are rejected
- **NO path aliases in source** — Relative imports only (with `.js`). Aliases only in `vitest.config.ts` and `vite.config.ts`
- **NO Prettier** — No formatting enforcer configured; follow existing style
- **NO callback patterns** — async/await only throughout

## COMMANDS

```bash
# Development
docker compose up --build -d               # Start full stack (postgres + orchestrator + UI)
docker compose --profile sandbox up -d      # Include sandbox containers + egress proxy
pnpm dev                                    # Same as docker compose up --build

# Build & Check
pnpm -r build                              # Build all packages (shared → proto → ctxmill → ui)
pnpm lint                                  # ESLint across packages/ and tests/
pnpm typecheck                             # TypeScript check all packages

# Test
pnpm test                                  # Vitest (unit + integration + compliance)
pnpm test:e2e                              # Playwright (requires Docker stack running)
pnpm vitest run tests/contract/            # FUSE contract tests (needs fuse-overlayfs)

# Docker Helpers
pnpm docker:up                             # Start detached
pnpm docker:down                           # Stop
pnpm docker:logs                           # Tail logs
pnpm docker:clean                          # Stop + remove volumes

# Proto
pnpm -C packages/proto build               # buf generate (proto → TS)
pnpm -C packages/proto build:js            # tsc (compile generated TS → JS)

# Sandbox Images (built separately from main stack)
docker build --target harness-langgraph -t ctxmill/harness-langgraph -f Dockerfile.sandbox .
docker build --target harness-claude-agents -t ctxmill/harness-claude-agents -f Dockerfile.sandbox .
docker build --target harness-pi-agent -t ctxmill/harness-pi-agent -f Dockerfile.sandbox .
```

## NOTES

- **Docker-first** — Everything runs in containers. No local dev mode. Node 22+ required.
- **pnpm 10.12.4** — Locked via `packageManager` field. `--shamefully-hoist` in production for SDK lazy imports.
- **Strict test mode** — `CTXMILL_STRICT_TESTS=1` in CI. Tests fail on console errors matching: CRITICAL, FOREIGN KEY, mount failure, etc. Opt out per-test with `allowConsoleErrors()`. See `tests/AGENTS.md`.
- **Sandbox images** — 3 Docker images per harness (langgraph, claude-agents, pi-agent), all FROM `harness-base` in `Dockerfile.sandbox`. Built separately with `--target harness-{name}`.
- **gRPC IPC** — Orchestrator ↔ sandbox via ConnectRPC on port 50051. Two services: HarnessService (OpenSession, DeliverTurn, SuspendSession, KillSession), OrchestratorService (RequestTool, EmitEvent, RefreshSecrets).
- **SSE streaming** — UI connects to `/api/agents/:id/stream` via EventSource. Events flow: harness → proto → gRPC → SSE → React.
- **Event chaining** — Agents emit events via `emit-event` tool → EventTriggerManager matches → spawns background run on another agent. Cascade protection: `MAX_TRIGGER_DEPTH=5`.
- **Checkpoint/Resume** — Sessions suspend cooperatively at safe execution phases. Checkpoint v2 format (5 MB max). Workspace captured as tar.gz (100 MB max). Secrets NEVER in checkpoints.
- **HITL pause flow** — Tool requests approval → Docker pause (5s delay) → freeze promotion (5 min) → checkpoint promotion (10 min).
- **`--experimental-strip-types`** — Node 22 flag in Dockerfile CMD for TypeScript enum handling in proto-generated code.
- **19 DB tables** via Drizzle ORM — see `packages/ctxmill/src/database/schema-pg.ts`. Test DB uses advisory lock (ID: 424242) for concurrent resets.
- **Default model** — `gpt-5-mini` (OpenAI). Override via `OPENAI_MODEL` env var. Per-agent override in YAML manifest.
- **Workspace isolation** — Workspace diff capture/restore during suspend/resume. Legacy FUSE/mock overlay abstractions removed.
- **Container concurrency** — Semaphore limits concurrent sandbox containers (default 20). FIFO queue with 60s timeout.
- **Tool providers** — 5 types: Local (in-process), MCP (stdio/HTTP), HTTP (REST endpoints), Composio (500+ SaaS), Artifact (daemon-handled S3/MinIO upload/download).
- **Agent manifests** — YAML format (`apiVersion: ctxmill.io/v1`). Supports `{{knowledge}}` placeholder in instructions, `$secret:KEY_NAME` for secrets.
- **Artifact storage** — S3/MinIO-backed file persistence. Tools (artifact_upload, artifact_download) run at daemon location, bypassing gRPC byte-proxying. Requires S3_ENDPOINT + S3_ACCESS_KEY + S3_SECRET_KEY env vars. MinIO container in docker-compose.
- **System settings** — 17 runtime-configurable knobs (timeouts, limits, resource defaults) persisted in system_settings table. Settings UI at /settings. 5-minute cache TTL. No restart required.
- **Container lifecycle policy** — Unified module replacing separate pause-manager, timeout-enforcer, and orphan-cleanup. Handles idle timeout, freeze promotion, checkpoint promotion, and reconciliation.
- **Durable HITL** — Interrupt resolution persisted DB-first. Sessions resume from DB state on restart. Replaces in-memory-only interrupt tracking.
- **A2UI render tool** — Intrinsic tool (a2ui-render) for agent-driven structured UI blocks. Replaces legacy inline A2UI extraction from message content.
- **Daemon tools** — Tool location 'daemon' for tools executed by sandbox daemon process (not harness or orchestrator). Currently: artifact_upload, artifact_download.
- **CI matrix** — Node 22 + 24. Three jobs: test (unit/integration), e2e (Playwright + Docker), fuse-tests (contract, continue-on-error).
- **Service ports** — UI: 3200, API: 3002 (nginx-proxied 3001), PostgreSQL: 5433, gRPC sandbox: 50051, Egress proxy: 3128, PgAdmin: 5050 (debug profile).
