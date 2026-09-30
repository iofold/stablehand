# STABLEHAND — PROJECT KNOWLEDGE BASE

**Generated:** 2026-07-10 · **Branch:** master

## OVERVIEW

Multi-harness agent runtime. Agents defined in YAML, execute inside Docker sandbox containers (gRPC IPC), stream AG-UI events to a React dashboard via SSE. PostgreSQL persistence, typed event bus with trigger-based agent chaining.

## STRUCTURE

```
packages/
  stablehand/              Core runtime — orchestrator, harness registry, sandbox orchestration, tools, events, DB
  sandbox-daemon/       Daemon process inside sandbox containers — gRPC server, harness adapters, tool proxy
  ui/                   React dashboard — Vite, React 18, Zustand, Tailwind, SSE streaming
  shared/               Types only — AG-UI events, API contracts (no build step, src/index.ts direct)
  proto/                Protobuf (buf) — HarnessService + OrchestratorService gRPC definitions
  client/               Typed browser client for AG-UI streaming integrations (@stablehand/client)
  react/                React components and hooks for AG-UI chat integrations (@stablehand/react)
  create-stablehand/       Scaffold CLI — generates new project from template
  examples/
    kitchen-sink/       3 agents (LangGraph, Claude, PI), 11 shared tools, event-chained
tests/
  unit/                 harness adapters, config, events, sandbox, tools
  integration/          orchestrator scenarios, event flows, CRUD
  e2e/                  Legacy scripted browser specs — chat, background runs, visual regression, visual QA
  compliance/           interface contract conformance via pluggable factories
  contract/             EMPTY — no shipped contract suite currently
  sandbox/              container lifecycle, suspend/resume, harness integration
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
| Add a new harness | Registry: `packages/stablehand/src/harness/`; adapter: `packages/sandbox-daemon/src/harness/` | Implement the `AgentHarness` adapter in `sandbox-daemon`, register it in `DefaultHarnessRegistry` |
| Add a tool provider | `packages/stablehand/src/tool/providers/` | Implement `ToolProvider`, register in `DefaultToolRegistry` |
| Add an API route | `packages/stablehand/src/orchestrator/routes/` | Fastify plugin pattern, register in `server.ts` |
| Add a UI page | `packages/ui/src/pages/` + `App.tsx` | Add route in App.tsx, nav item in Sidebar.tsx |
| Add a DB table | `packages/stablehand/src/database/schema-pg.ts` | Drizzle ORM, add to `repository.ts` |
| Add an event | `packages/stablehand/src/events/bus.ts` | Add to `EventMap` type, emit via `TypedEventBus` |
| Modify proto | `packages/proto/stablehand/sandbox/v1/sandbox.proto` | Run `pnpm -C packages/proto build` to regenerate |
| Add agent to example | `packages/examples/kitchen-sink/agents/` | YAML manifest (`apiVersion: stablehand.io/v1`) |
| Define a tool | Use `defineTool({ name, description, input: z.object(...), handler })` | Zod schema for input validation |
| Define an agent | Use `defineAgent({ tools, systemPrompt })` or YAML manifest | `{{knowledge}}` placeholder for dynamic injection |
| Understand DI wiring | `packages/stablehand/src/config/container.ts` | `createContainer()` builds all services |
| Trace a run execution | `orchestrator/agent-turn-service.ts` → `orchestrator/sandbox-session-manager.ts` → `packages/sandbox-daemon/src/sandbox/runner.ts` | All runs go through sandbox containers |
| Modify sandbox daemon | `packages/sandbox-daemon/src/` | gRPC server, harness adapters, tool proxy. Runs inside containers, NOT orchestrator |
| Understand session lifecycle | `orchestrator/sandbox-session-manager.ts` | Active → checkpointed → restoring lifecycle plus reconciliation |
| Configure runtime settings | `packages/stablehand/src/settings/service.ts` | DB-persisted system settings, Settings UI |
| Manage artifacts | `packages/stablehand/src/artifact/artifact-store.ts` | S3/MinIO, signed URLs, daemon tools |

## CONVENTIONS

- **ESM with `.js` extensions** — All imports require `.js` suffix (NodeNext module resolution). Path aliases forbidden in source.
- **Barrel exports** — Each module has `index.ts` re-exporting public API
- **Constructor DI** — Services accept `Deps`/`Options` interface, stored as `private readonly` (209 instances)
- **Logger interface** — Each service defines its own local `Logger` interface, injected via constructor (no global logger)
- **Unused params** — Prefix with `_` (ESLint rule: `argsIgnorePattern: '^_'`)
- **Test naming** — `*.test.ts` for Vitest (never `.spec.ts`), `*.spec.ts` only for legacy scripted browser specs. Colocated in `__tests__/` or top-level `tests/`
- **Type naming** — `*Deps` (constructor deps), `*Options` (config), `*Provider` (pluggable), `*Config` (settings)
- **Constants** — `UPPER_SNAKE_CASE`, use `ReadonlySet<string>` for immutable collections
- **Error classes** — Only 2 custom: `EventTimeoutError`, `ContainerLimitError`. All else uses generic `Error`
- **Zod for tool input** — `z.object(...)` schema validation in all tool definitions
- **gRPC error codes** — Use `ConnectError` with `Code.*` (InvalidArgument, etc.)

## WORKFLOW RULES

- **ALWAYS commit after completing work** — Every agent session MUST `git add` + `git commit` its changes before stopping. Uncommitted work gets lost when other sessions clean the working tree. Do NOT push unless the user explicitly asks.
- **Commit granularity** — One commit per logical unit of work (feature, fix, refactor). If a session implements multiple things, multiple commits are fine.
- **Never leave dirty working tree** — If you made changes, commit them. No exceptions.
- **Temporary files stay under `.tmp/`** — Put scratch scripts, screenshots, agent-browser artifacts, test result artifacts, logs, downloads, and other generated investigation files under `.tmp/`. Do not create root-level temporary directories such as browser reports, `test-results/`, or ad hoc scratch folders outside `.tmp/`.
- **Visually verify UI changes** — After any change that touches routes returning data to the UI, API response shapes, or frontend components:
  1. Rebuild the Docker stack (`docker compose up --build -d`)
  2. Use `agent-browser` to navigate the affected screens, interact with them, and save screenshots/snapshots/console/error/network evidence under `.tmp/`
  3. Feed each screenshot to `look_at` with a specific critique goal (e.g., "Are sessions listed? Do status badges render? Any broken layouts?")
  4. Fix any issues surfaced before marking the task complete
  This catches shape mismatches, empty states, and rendering failures that unit tests miss.

## ANTI-PATTERNS

- **NEVER store secrets in checkpoints** — Secrets are injected fresh into sandbox env on resume, never persisted
- **NEVER suppress types** — No `as any`, `@ts-ignore`, `@ts-expect-error` (existing `as any` in source are documented tech debt from Zod/EventEmitter/Drizzle library limitations)
- **NEVER use empty catch blocks** — `catch(e) {}` forbidden
- **NEVER delete failing tests** to make CI pass
- **NEVER call harness.run() directly** — All execution goes through `AgentTurnService` → `SandboxSessionManager` → Docker containers
- **NEVER exceed checkpoint limits** — The daemon checkpoint validator currently rejects oversized state payloads (>5 MB by default), and workspace tar snapshots are capped at 100 MB
- **NO path aliases in source** — Relative imports only (with `.js`). Aliases only in `vitest.config.ts` and `vite.config.ts`
- **NO Prettier** — No formatting enforcer configured; follow existing style
- **NO callback patterns** — async/await only throughout

## COMMANDS

```bash
# Development
docker compose up --build -d               # Start full stack (postgres + orchestrator + UI)
docker compose up --build -d               # Builds all services including sandbox harness images
pnpm dev                                    # Same as docker compose up --build

# Build & Check
pnpm -r build                              # Build all packages (shared → proto → stablehand → ui)
pnpm lint                                  # ESLint across packages/ and tests/
pnpm typecheck                             # TypeScript check all packages

# Test
pnpm test                                  # Vitest (unit + integration + compliance)
# Browser E2E certification: docs/verification/e2e-testing-journey.md
# No contract test command/job unless restored

# Docker Helpers
pnpm docker:up                             # Start detached
pnpm docker:down                           # Stop
pnpm docker:logs                           # Tail logs
pnpm docker:clean                          # Stop + remove volumes

# Proto
pnpm -C packages/proto build               # buf generate (proto → TS)
pnpm -C packages/proto build:js            # tsc (compile generated TS → JS)

# Sandbox Images (built separately from main stack)
docker build --target harness-langgraph -t stablehand/harness-langgraph -f Dockerfile.sandbox .
docker build --target harness-claude-agents -t stablehand/harness-claude-agents -f Dockerfile.sandbox .
docker build --target harness-pi-agent -t stablehand/harness-pi-agent -f Dockerfile.sandbox .
```

## NOTES

- **Docker-first** — Everything runs in containers. No local dev mode. Node 22+ required.
- **pnpm 10.12.4** — Locked via `packageManager` field. `--shamefully-hoist` in production for SDK lazy imports.
- **Strict test mode** — `STABLEHAND_STRICT_TESTS=1` in CI. Tests fail on console errors matching: CRITICAL, FOREIGN KEY, mount failure, etc. Opt out per-test with `allowConsoleErrors()`. See `tests/AGENTS.md`.
- **Sandbox images** — 3 Docker images per harness (langgraph, claude-agents, pi-agent), all FROM `harness-base` in `Dockerfile.sandbox`. Built separately with `--target harness-{name}`.
- **gRPC IPC** — Orchestrator ↔ sandbox via ConnectRPC on port 50051. Two services: HarnessService (OpenSession, DeliverTurn, SuspendSession, KillSession), OrchestratorService (RequestTool, EmitEvent, RefreshSecrets).
- **SSE streaming** — UI connects to `/api/agents/:id/stream` via EventSource. Events flow: harness → proto → gRPC → SSE → React.
- **Event chaining** — Agents emit events via `emit-event` tool → EventTriggerManager matches → spawns background run on another agent. Cascade protection: `MAX_TRIGGER_DEPTH=5`.
- **Checkpoint/Resume** — Sessions suspend cooperatively at safe execution phases. Checkpoint v2 format; workspace captured as tar.gz (100 MB max). Secrets NEVER in checkpoints.
- **HITL flow** — Tool requests approval → interrupt is persisted → the user resolves it via the dashboard/API → the matching sandbox session resumes or restores from checkpoint.
- **`--experimental-strip-types`** — Node 22 flag in Dockerfile CMD for TypeScript enum handling in proto-generated code.
- **Drizzle ORM schema** — see `packages/stablehand/src/database/schema-pg.ts`. Test DB uses advisory lock (ID: 424242) for concurrent resets.
- **Default model** — Agent model selection belongs in each agent's harness config or YAML manifest. Harnesses may still read provider-specific env vars inside sandbox containers.
- **Sandbox-daemon package** — Separate package (`@stablehand/sandbox-daemon`) deployed inside sandbox containers. Contains gRPC server, harness adapters (LangGraph, Claude Agents, PI Agent), tool proxy, proto-convert, and checkpoint logic. Changes here require rebuilding harness Docker images (not just orchestrator).
- **Workspace isolation** — Workspace diff capture/restore during suspend/resume.
- **Container concurrency** — Semaphore limits concurrent sandbox containers (default 20). FIFO queue with 60s timeout.
- **Tool providers** — 5 types: Local (in-process), MCP (stdio/HTTP), HTTP (REST endpoints), Composio (500+ SaaS), Artifact (daemon-handled S3/MinIO upload/download).
- **Agent manifests** — YAML format (`apiVersion: stablehand.io/v1`). Supports `{{knowledge}}` placeholder in instructions, `$secret:KEY_NAME` for secrets.
- **Artifact storage** — S3/MinIO-backed file persistence. Tools (artifact_upload, artifact_download) run at daemon location, bypassing gRPC byte-proxying. Requires S3_ENDPOINT + S3_ACCESS_KEY + S3_SECRET_KEY env vars. The compose `minio` service runs RustFS (S3-compatible; MinIO no longer publishes pullable images).
- **System settings** — Runtime-configurable knobs (timeouts, limits, resource defaults) persisted in `system_settings`. Settings UI at `/settings`. 5-minute cache TTL. No restart required.
- **Container lifecycle policy** — Unified module handling idle checkpoint scheduling, compatibility pause/resume, and reconciliation.
- **Durable HITL** — Interrupt resolution persisted DB-first. Sessions resume from DB state on restart. Replaces in-memory-only interrupt tracking.
- **A2UI render tool** — Intrinsic tool (a2ui-render) for agent-driven structured UI blocks. Replaces legacy inline A2UI extraction from message content.
- **Daemon tools** — Tool location 'daemon' for tools executed by sandbox daemon process (not harness or orchestrator). Currently: artifact_upload, artifact_download.
- **CI matrix** — Node 22 + 24. The test job covers unit/integration gates; browser certification is agent-browser against Docker.
- **Service ports** — UI: 3200, API: 3002 (nginx-proxied 3001), PostgreSQL: 5433, gRPC sandbox: 50051, Sandbox egress proxy: egress:8080 (internal agents network only, not published), PgAdmin: 5050 (debug profile).
- **Local stack URL** — Treat `https://platform.dev.example.com` as the canonical browser entrypoint for the local Docker stack. The direct fallback remains `http://localhost:3200` when the local domain route is unavailable.

<!-- br-agent-instructions-v1 -->

---

## Beads Workflow Integration

This project uses [beads_rust](https://github.com/Dicklesworthstone/beads_rust) (`br`/`bd`) for issue tracking. Issues are stored in `.beads/` and tracked in git.

### Essential Commands

```bash
# View ready issues (open, unblocked, not deferred)
br ready              # or: bd ready

# List and search
br list --status=open # All open issues
br show <id>          # Full issue details with dependencies
br search "keyword"   # Full-text search

# Create and update
br create --title="..." --description="..." --type=task --priority=2
br update <id> --status=in_progress
br close <id> --reason="Completed"
br close <id1> <id2>  # Close multiple issues at once

# Sync with git
br sync --flush-only  # Export DB to JSONL
br sync --status      # Check sync status
```

### Workflow Pattern

1. **Start**: Run `br ready` to find actionable work
2. **Claim**: Use `br update <id> --status=in_progress`
3. **Work**: Implement the task
4. **Complete**: Use `br close <id>`
5. **Sync**: Always run `br sync --flush-only` at session end

### Key Concepts

- **Dependencies**: Issues can block other issues. `br ready` shows only open, unblocked work.
- **Priority**: P0=critical, P1=high, P2=medium, P3=low, P4=backlog (use numbers 0-4, not words)
- **Types**: task, bug, feature, epic, chore, docs, question
- **Blocking**: `br dep add <issue> <depends-on>` to add dependencies

### Session Protocol

**Before ending any session, run this checklist:**

```bash
git status              # Check what changed
git add <files>         # Stage code changes
br sync --flush-only    # Export beads changes to JSONL
git commit -m "..."     # Commit everything
# Push only when the user explicitly asks
```

### Best Practices

- Check `br ready` at session start to find available work
- Update status as you work (in_progress → closed)
- Create new issues with `br create` when you discover tasks
- Use descriptive titles and set appropriate priority/type
- Always sync before ending session

<!-- end-br-agent-instructions -->

<!-- bv-agent-instructions-v2 -->

---

## Beads Viewer (`bv`) — Graph-Aware Triage

`bv` is a graph-aware triage engine for the `.beads/` project ([beads_viewer](https://github.com/Dicklesworthstone/beads_viewer)). It computes PageRank, betweenness, critical path, cycles, HITS, eigenvector, and k-core — use it instead of parsing JSONL or guessing at dependencies.

**Scope:** `bv` decides *what to work on* (triage, priority, planning). `br` creates, modifies, and closes issues.

**CRITICAL: use only `--robot-*` flags. Bare `bv` launches an interactive TUI that will block your session.**

### Single entry point: `bv --robot-triage`

```bash
bv --robot-triage        # THE mega-command: top picks + quick wins + blockers + health
bv --robot-next          # Minimal: single top pick + claim command
bv --robot-triage --format toon   # Token-optimized output for lower LLM context cost
```

`--robot-triage` returns `quick_ref`, `recommendations`, `quick_wins`, `blockers_to_clear`, `project_health`, and copy-pasteable `commands`.

### Other robot commands

| Command | Returns |
|---------|---------|
| `bv --robot-plan` | Parallel execution tracks with unblocks lists |
| `bv --robot-priority` | Priority misalignment detection |
| `bv --robot-insights` | Full metrics: PageRank, betweenness, HITS, eigenvector, critical path, cycles, k-core |
| `bv --robot-alerts` | Stale issues, blocking cascades, priority mismatches |
| `bv --robot-suggest` | Hygiene: duplicates, missing deps, label suggestions, cycle breaks |
| `bv --robot-diff --diff-since <ref>` | New/closed/modified issues since a commit/branch/date |
| `bv --robot-graph --graph-format=mermaid` | Dependency graph export |

### Scoping

```bash
bv --robot-plan --label ptc              # Scope to label subgraph
bv --robot-insights --as-of HEAD~30      # Historical point-in-time
bv --recipe actionable --robot-plan      # Pre-filter: ready to work (no blockers)
bv --recipe high-impact --robot-triage   # Pre-filter: top PageRank scores
```

### Workflow

1. `bv --robot-triage` — find highest-impact actionable work
2. `br update <id> --status=in_progress` — claim it
3. Implement the task
4. `br close <id> --reason="..."`
5. `br sync --flush-only` — export to JSONL before committing

<!-- end-bv-agent-instructions -->
