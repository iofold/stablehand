# packages/ctxmill — Core Runtime

## OVERVIEW

Orchestrator, sandbox container management, tool execution, event bus, PostgreSQL persistence. All execution routes through Docker sandbox containers via gRPC. Harness adapters live in `@ctxmill/sandbox-daemon`, not here. 102 source files, ~75k TS lines.

## STRUCTURE

```
src/
  a2ui/           Structured visual block extraction from agent output (2 files)
  agent/          Agent discovery from filesystem + defineAgent() builder (2 files)
  cli/            `ctxmill dev` and `ctxmill chat` entry points (3 files, dynamic imports)
  config/         DI container, docker preset, factories (6 files + 2 tests)
  database/       Drizzle ORM schema (16 tables), repository, migrations (6 files)
  events/         TypedEventBus (18 events), triggers, wait primitives, queue (8 files + 1 test)
  harness/        Harness registry + types. Adapters live in sandbox-daemon package (7 files)
  knowledge/      KnowledgeStore abstraction — InMemory + Mem0 impls (5 files)
  learning/       Trace collection → reflection → knowledge update pipeline (7 files + 1 test)
  llm/            Provider-agnostic LLM factory for learning reflector (4 files)
  manifest/       YAML agent manifest parsing, validation, conversion (6 files + 1 test)
  orchestrator/   Fastify server, SSE, HITL, routes, session manager (12 files + 7 routes + 8 tests)
  sandbox/        Container lifecycle, gRPC daemon, checkpoint/restore, timeout (15 files + 13 tests)
  secrets/        Encrypted per-agent secret storage via PostgreSQL (4 files)
  skills/         SKILL.md loader (frontmatter + markdown body) (1 file)
  tool/           Tool executor, 4 providers (Local, MCP, HTTP, Composio), registry (7 files + 3 tests)
  util/           Shared error utilities (2 files + 1 test)
  workspace/      Session workspace + tar upload helpers (4 files)
```

## WHERE TO LOOK

| Task | File(s) | Notes |
|------|---------|-------|
| Understand the public API | `src/index.ts` | 60+ exports, 3 factory functions |
| Trace a run execution | `orchestrator/agent-session-service.ts` → `orchestrator/sandbox-session-manager.ts` → `packages/sandbox-daemon/src/sandbox/runner.ts` | All runs go through sandbox containers |
| Add an API endpoint | `orchestrator/routes/*.ts` → register in `orchestrator/server.ts` | Fastify plugin pattern |
| Add a harness | `harness/*.ts` → register in `harness/registry.ts` | Implement `AgentHarness` interface |
| Add a tool provider | `tool/providers/*.ts` → register in `tool/registry.ts` | Implement `ToolProvider` interface |
| Understand DI wiring | `config/container.ts` | `createContainer()` builds all services |
| Add a DB table | `database/schema-pg.ts` + `database/repository.ts` | Drizzle ORM, add query methods |
| Add an event type | `events/bus.ts` EventMap type | Add payload interface, emit via bus |
| Understand proto conversion | `sandbox/proto-convert.ts` | AgentEvent ↔ proto ↔ AG-UI mapping |
| Modify checkpoint format | `sandbox/checkpoint.ts` | Full run state serialization (v2, 5 MB limit) |
| Understand session lifecycle | `orchestrator/sandbox-session-manager.ts` | Session state machine, checkpoint promotion, restoration, and terminal cleanup |
| Track active runs | `orchestrator/run-registry.ts` | In-memory run state, SSE broadcasting, event routing |
| Understand event chaining | `events/trigger-manager.ts` | EventTriggerManager, cascade protection (depth 5) |
| Understand tool proxying | `sandbox/tool-proxy.ts` | gRPC RequestTool RPC, 3 retries, exponential backoff |

## HOT FILES (most imported / most complex)

| File | Imports | Lines | Role |
|------|---------|-------|------|
| `types.ts` | 22 | 82 | Core type definitions (AgentDefinition, HarnessRunConfig, etc.) |
| `database/repository.ts` | 14 | 1262 | All data access — 16 tables, all query methods |
| `orchestrator/routes/agents.ts` | — | 2213 | Agent CRUD, runs, conversations, skills, files, knowledge endpoints |
| `orchestrator/sandbox-session-manager.ts` | — | 969 | Session state machine — pause/freeze/checkpoint promotion |
| `sandbox/container-manager.ts` | 7 | 842 | Docker container lifecycle, concurrency semaphore (max 20) |
| `events/bus.ts` | 12 | — | TypedEventBus with 18 event types |
| `sandbox/proto-convert.ts` | — | 654 | Proto ↔ internal type conversions, AG-UI event mapping |
| `orchestrator/run-registry.ts` | — | 545 | In-memory run state, SSE broadcasting, event routing |
| `tool/types.ts` | 11 | — | Tool definitions, ToolProvider interface |

## CONVENTIONS (beyond root)

- **`private readonly` everywhere** — 209 instances; all injected deps stored this way
- **Local Logger interface** — Each service defines its own; injected via constructor, not imported globally
- **Only 2 custom Error classes** — `EventTimeoutError`, `ContainerLimitError`. All else uses generic `Error`
- **Zod for tool input** — `z.object(...)` schema validation in tool definitions
- **gRPC error codes** — Use `ConnectError` with `Code.*` (InvalidArgument, etc.)
- **No global error handler** — Fastify catches unhandled via `logger: true`

## EXECUTION FLOW

```
User message → orchestrator/agent-session-service.ts
  → orchestrator/sandbox-session-manager.ts (creates container)
    → container-manager.ts (Docker create/start, semaphore acquire)
      → daemon.ts (gRPC server in container, port 50051)
        → runner.ts (harness resolution, session lifecycle)
          → harness/*.ts (LangGraph/Claude/PI agent execution)
            → tool-proxy.ts (orchestrator-location tools via gRPC)
          ← AgentEvent stream back through proto-convert.ts
        ← SSE → React UI
```

## HARNESS DEBUGGING

Harness code runs INSIDE sandbox containers, not in the orchestrator. This changes everything about how you debug.

**Error visibility chain** — Errors travel: harness catch → `{ type: 'error', error: string }` → proto SessionEvent → gRPC → orchestrator. By default, the error string is the ONLY thing that survives. Always `console.error` in harness catch blocks — container stderr is the only place you'll see stack traces.

**"1 events emitted" means the harness errored immediately.** A healthy turn emits 5-100+ events. If you see 1, the single event is the error event. Check container logs with `docker logs <container-id>`.

**ENOENT ≠ missing executable.** Node's `spawn` reports ENOENT when `cwd` doesn't exist, but the error message says "executable not found." If a harness reports "not found at /path/to/binary" and the binary exists, check that `config.workspaceDir` exists inside the container.

**Secrets must be explicitly injected.** `SandboxSessionManager` passes `sandboxSecrets` (allowlisted env vars from orchestrator) to `createContainer()`. Container logs `loaded N secret(s) from env` on success, `no secrets found` on failure. If agents fail silently with 1 event, check secrets first.

**Every harness MUST yield `message_committed`.** The persistence chain is: harness yields `message_committed` → runner converts to proto `messageCommitted` → orchestrator converts to `MESSAGE_COMMITTED` → `db.addMessage()`. If a harness only yields `text_delta` + `done`, text streams to SSE but nothing persists. The harness must accumulate text from deltas and yield `message_committed` with the full content before `done`.

**Mock tests won't catch harness integration bugs.** Unit tests mock `executeSessionTurn` to return fake `MESSAGE_COMMITTED` events — they pass even when no harness emits that event. Real validation requires `npx playwright test tests/e2e/stress-smoke.spec.ts` against the Docker stack.

**Harness images must be rebuilt separately.** `docker compose up --build` only rebuilds the orchestrator. Harness code changes require: `docker build --target harness-{name} -t ctxmill/harness-{name} -f Dockerfile.sandbox .`

**Claude Agent SDK spawns a subprocess.** The `query()` API looks like a simple function call but spawns `node cli.js` under the hood. It resolves cli.js relative to its own package directory. The container needs: the SDK package installed, `node` on PATH, and a writable `cwd` directory.

**PI Agent SDK has no `getMessages()`.** The native session's agent object exposes `replaceMessages()` but NOT `getMessages()`. Use the harness's own `transcript` array for message tracking and `exportState()`.

## SANDBOX INTERNALS

**Container concurrency** — `ContainerSemaphore` in `container-manager.ts`. FIFO queue, 20 concurrent default (`CTXMILL_MAX_CONTAINERS`), 60s queue timeout → `ContainerLimitError` (503).

**Safe suspend phases** — `ExecutionPhaseTracker` in `execution-phase.ts`. Cooperative suspend only at: `idle`, `before_llm`, `after_llm`, `after_tool`, `hitl_wait`. Unsafe phases (`llm_call_in_flight`, `tool_execution`) wait for next safe point.

**Tool proxy** — `createToolProxy()` in `tool-proxy.ts`. Orchestrator-location tools serialized via gRPC `RequestTool` RPC. 3 retries, exponential backoff (100ms/500ms/2s), 5min timeout.

**Session status machine** — `session-status-machine.ts`. States: `ACTIVE` → `CHECKPOINTED` → `RESTORING` → `ACTIVE`, with `PAUSED` kept only as a legacy compatibility state and `TERMINATED` as terminal.

## ANTI-PATTERNS (beyond root)

- **NEVER call harness.run() directly** — All execution goes through `AgentSessionService` → `SandboxSessionManager` → Docker containers
- **NEVER store secrets in checkpoint data** — Injected fresh on resume via tmpfs mount (`/run/secrets/config.json`)
- **NEVER import from path aliases** — Relative `.js` imports only in source. Aliases only in `vitest.config.ts`
- **NEVER exceed checkpoint limits** — 5 MB checkpoint, 100 MB workspace tar. Oversized checkpoints are rejected
- **NEVER assume /workspace exists** — Pre-created in Dockerfile; may be overlaid at runtime. Harnesses that spawn subprocesses with `cwd` will get ENOENT if it's missing
- **NEVER omit console.error in harness catch blocks** — Without it, errors are invisible; only "1 events emitted" appears in logs
