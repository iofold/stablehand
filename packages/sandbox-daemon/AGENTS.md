# packages/sandbox-daemon — Sandbox Daemon Process

**Generated:** 2026-04-06 · **Commit:** c2561f2

## OVERVIEW

gRPC daemon process deployed **inside** sandbox containers (NOT the orchestrator). Implements HarnessService + OrchestratorService RPCs, 3 harness adapters (LangGraph, Claude Agents, PI Agent), tool proxying to orchestrator, proto ↔ internal event conversion, checkpoint serialization. Runs via Bun, not Node.

## STRUCTURE

```
src/
  sandbox/              gRPC server, runner, proto-convert, checkpoint, tool-proxy, PTC codegen (9 files + 8 tests)
  harness/              3 harness adapters + shared utilities + types (7 files + tests)
  artifact/             S3/MinIO artifact upload/download handlers
  tool/                 Tool execution for daemon-location tools
  util/                 Shared utilities
  index.ts              Package entry point
  session-event.ts      Session event types
  types.ts              Shared type definitions
```

## WHERE TO LOOK

| Task | File(s) | Notes |
|------|---------|-------|
| Modify gRPC server | `sandbox/daemon.ts` | HarnessService + OrchestratorService RPCs on port 50051 |
| Fix harness bug | `harness/{langgraph,claude-agents,pi-agent}.ts` | Harness code runs HERE, inside containers |
| Proto ↔ TS conversion | `sandbox/proto-convert.ts` (701 lines) | AgentEvent ↔ proto ↔ AG-UI event mapping |
| Checkpoint format | `sandbox/checkpoint.ts` | Session state serialization (v2 format, 5 MB limit) |
| Tool proxying | `sandbox/tool-proxy.ts` | gRPC RequestTool RPC to orchestrator, 3 retries, exponential backoff |
| Execution phases | `sandbox/execution-phase.ts` | Safe suspend points: idle, before_llm, after_llm, after_tool, hitl_wait |
| Session lifecycle | `sandbox/runner.ts` (582 lines) | Harness resolution, turn execution, event streaming |
| PTC codegen | `sandbox/ptc-codegen.ts` | Programmatic tool calling code generation |
| Artifact handling | `artifact/` + `sandbox/artifact-handler.ts` | S3 upload/download at daemon location |

## KEY DIFFERENCES FROM ORCHESTRATOR

- **Runtime**: Bun (not Node) — entrypoint uses `bun run`
- **Deployed inside Docker containers** — one per agent run, ephemeral
- **No direct DB access** — communicates with orchestrator via gRPC only
- **No SSE** — events flow back to orchestrator via gRPC stream, then SSE
- **Harness adapters live HERE** — `packages/ctxmill/src/harness/` is registry + types only
- **Rebuilding**: Changes here require rebuilding harness images: `docker build --target harness-{name} -t ctxmill/harness-{name} -f Dockerfile.sandbox .`
- **Process management**: tini for Claude/PI agents (signal handling for subprocess cleanup), not for LangGraph

## HARNESS ADAPTER PATTERNS

Each adapter implements the session lifecycle:
1. `createSession(config)` → Initialize harness SDK
2. `executeTurn(messages)` → Yield `AgentEvent` stream
3. `suspend()` → Export state for checkpoint
4. `restore(state)` → Resume from checkpoint

**Claude Agent SDK** — Spawns `node cli.js` subprocess. Needs: SDK package installed, `node` on PATH, writable `cwd`.
**PI Agent SDK** — No `getMessages()` on native session. Use harness's own `transcript` array.
**LangGraph** — LangChain-based, supports OpenAI/Anthropic/Google providers.

## ANTI-PATTERNS

- **NEVER import orchestrator modules** — daemon has no access to orchestrator code at runtime
- **ALWAYS `console.error` in harness catch blocks** — Container stderr is the ONLY place you'll see stack traces. Without it, only "1 events emitted" appears in orchestrator logs
- **NEVER assume /workspace exists** — Pre-created in Dockerfile, may be overlaid at runtime. ENOENT from `spawn()` usually means `cwd` is missing, not the binary
- **NEVER store secrets in checkpoint** — tmpfs mount at `/run/secrets/config.json`, 1 MB, `rw,noexec,nosuid`

## KNOWN RELIABILITY CONCERNS

Key issues in this package:
- `runner.ts:64` — `.catch(() => {})` on mkdir silently hides permission/disk errors
- `daemon.ts:92,140` — Empty catches on JSON parsing default to wrong values
- `ptc-codegen.ts:49` — JSON parse fallback masks tool API failures
- `tool-proxy.ts` — No idempotency key; gRPC connection drop can cause duplicate tool execution
- `claude-agents.ts:930` — JSON parse fallback returns raw string, causing type confusion downstream
