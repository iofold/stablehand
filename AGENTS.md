# CTXMILL — PROJECT KNOWLEDGE BASE

**Generated:** 2026-03-21 · **Commit:** f09a876 · **Branch:** feat/persistent-sandbox-sessions

## OVERVIEW

Multi-harness agent runtime. Agents define in YAML, execute inside Docker sandbox containers (gRPC IPC), stream AG-UI events to a React dashboard via SSE. PostgreSQL persistence, typed event bus with trigger-based agent chaining.

## STRUCTURE

```
packages/
  ctxmill/              Core runtime — orchestrator, 5 harnesses, sandbox, tools, events, DB
  ui/                   React dashboard — Vite, Zustand, Tailwind, SSE streaming
  shared/               Types only — AG-UI events, API contracts (no runtime code)
  proto/                Protobuf (buf) — HarnessService + OrchestratorService gRPC definitions
  create-ctxmill/       Scaffold CLI — generates new project from template
  examples/
    kitchen-sink/       5-agent example — one per harness, event-chained, 12 shared tools
tests/
  unit/                 51 files — harness adapters, config, learning, sandbox, tools
  integration/          19 files — orchestrator scenarios, event flows, CRUD
  e2e/                  8 Playwright specs — chat, background runs, visual regression
  compliance/           13 files — contract conformance
  contract/             FUSE overlay lifecycle tests
  sandbox/              4 files — container manager, suspend/resume, harness subagents
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
| Add a DB table | `packages/ctxmill/src/database/schema-pg.ts` | Drizzle ORM, add to repository.ts |
| Add an event | `packages/ctxmill/src/events/bus.ts` | Add to `EventMap` type, emit via `TypedEventBus` |
| Modify proto | `packages/proto/ctxmill/sandbox/v1/sandbox.proto` | Run `pnpm -C packages/proto build` to regenerate |
| Add agent to example | `packages/examples/kitchen-sink/agents/` | YAML manifest (apiVersion: ctxmill.io/v1) |
| Define a tool | Use `defineTool({ name, description, input: z.object(...), handler })` | Zod schema for input |
| Define an agent | Use `defineAgent({ tools, systemPrompt })` or YAML manifest | `{{knowledge}}` placeholder for dynamic injection |

## CONVENTIONS

- **ESM with `.js` extensions** — All imports require `.js` suffix (NodeNext module resolution)
- **Barrel exports** — Each module has `index.ts` re-exporting public API
- **Constructor DI** — Services accept `Deps`/`Options` interface, stored as `private readonly`
- **Logger interface** — Services define local `Logger` interface, injected via constructor
- **Unused params** — Prefix with `_` (ESLint rule: `argsIgnorePattern: '^_'`)
- **Test naming** — `*.test.ts` (never `.spec.ts`), colocated in `__tests__/` or top-level `tests/`
- **Type naming** — `*Deps` (constructor deps), `*Options` (config), `*Provider` (pluggable), `*Config` (settings)
- **Constants** — `UPPER_SNAKE_CASE`, use `ReadonlySet<string>` for immutable collections

## ANTI-PATTERNS

- **NEVER store secrets in checkpoints** — Secrets injected fresh on resume via tmpfs, never persisted
- **NEVER suppress types** — No `as any`, `@ts-ignore`, `@ts-expect-error`
- **NEVER use empty catch blocks** — `catch(e) {}` forbidden
- **NEVER delete failing tests** to make CI pass
- **NO path aliases in source** — Relative imports only (with `.js`). Path aliases only in vitest.config.ts
- **NO Prettier** — No formatting enforcer configured; follow existing style
- **NO callback patterns** — async/await only (1825+ instances)

## COMMANDS

```bash
# Development
docker compose up --build -d               # Start full stack
docker compose --profile sandbox up -d      # Include sandbox containers
pnpm dev                                    # Same as docker compose up --build

# Build & Check
pnpm -r build                              # Build all packages
pnpm lint                                  # ESLint across packages/ and tests/
pnpm typecheck                             # TypeScript check all packages

# Test
pnpm test                                  # Vitest (all unit + integration)
pnpm test:e2e                              # Playwright (requires Docker stack running)
pnpm vitest run tests/contract/            # FUSE contract tests (needs fuse-overlayfs)

# Docker Helpers
pnpm docker:up                             # Start detached
pnpm docker:down                           # Stop
pnpm docker:logs                           # Tail logs
pnpm docker:clean                          # Stop + remove volumes

# Proto
pnpm -C packages/proto build               # Regenerate TS from .proto
```

## NOTES

- **Docker-first** — Everything runs in containers. No local dev mode.
- **Strict test mode** — `CTXMILL_STRICT_TESTS=1` in CI. Tests fail on internal errors (CRITICAL, FOREIGN KEY, mount failure). Opt out with `allowConsoleErrors()`. See `tests/AGENTS.md`.
- **Sandbox images** — 5 separate Docker images per harness, all FROM `harness-base` in `Dockerfile.sandbox`. Built with `--target harness-{name}`.
- **gRPC IPC** — Orchestrator ↔ sandbox via ConnectRPC on port 50051. Proto in `packages/proto/`. Two services: HarnessService (4 RPCs), OrchestratorService (3 RPCs).
- **SSE streaming** — UI connects to `/api/agents/:id/stream` via EventSource. AG-UI events flow: harness → proto → SSE → React.
- **Event chaining** — Agents emit events via `emit-event` tool → EventTriggerManager matches → spawns background run on another agent. Cascade protection: `MAX_TRIGGER_DEPTH=5`.
- **Checkpoint/Resume** — Sessions suspend cooperatively at safe execution phases. Checkpoint v2 format (5 MB max). Workspace captured as tar.gz (100 MB max). Secrets NEVER in checkpoints.
- **HITL pause flow** — Tool requests approval → Docker pause (5s delay) → freeze promotion (5 min) → checkpoint promotion (10 min).
- **`--experimental-strip-types`** — Node 22 flag used in Dockerfile for TypeScript enum handling.
- **`--shamefully-hoist`** — Production pnpm install hoists deps for SDK lazy imports.
- **16 DB tables** via Drizzle ORM — see `packages/ctxmill/src/database/schema-pg.ts`.
- **Default model** — `gpt-5-mini` (OpenAI). Override via `OPENAI_MODEL` env var.
- **Workspace isolation** — FUSE overlayfs when available, mock overlay fallback.
- **Container concurrency** — Semaphore limits concurrent sandbox containers (default 20). FIFO queue with 60s timeout.
- **Tool providers** — 4 types: Local (in-process), MCP (stdio/HTTP), HTTP (REST endpoints), Composio (500+ SaaS).
- **Agent manifests** — YAML format (`apiVersion: ctxmill.io/v1`). Supports `{{knowledge}}` placeholder in instructions, `$secret:KEY_NAME` for secrets.
