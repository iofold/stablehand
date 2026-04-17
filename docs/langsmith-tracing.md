# LangSmith Tracing

Opt-in agent tracing via [LangSmith](https://smith.langchain.com). When enabled, every agent run produces a trace visible in the LangSmith dashboard with span hierarchy, LLM call details, tool executions, and token usage.

## Quick Start

```bash
# Add to .env
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_sk_...        # or lsv2_pt_...
LANGSMITH_PROJECT=ctxmill
LANGSMITH_WORKSPACE_ID=...           # Required for service account keys (lsv2_sk_)
```

Restart the stack. All subsequent agent runs produce traces in the configured project.

## How It Works

Tracing is **harness-level** — each harness self-instruments using its SDK's native tracing capabilities. The orchestrator passes `LANGSMITH_*` host environment variables to sandbox containers via `SANDBOX_SECRET_ALLOWLIST`.

```
.env → docker-compose → orchestrator → SANDBOX_SECRET_ALLOWLIST → sandbox container → harness
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LANGSMITH_TRACING` | Yes | Set to `true` to enable tracing |
| `LANGSMITH_API_KEY` | Yes | API key from smith.langchain.com/settings |
| `LANGSMITH_PROJECT` | No | Project name (default: `ctxmill`) |
| `LANGSMITH_WORKSPACE_ID` | Conditional | Required for service account keys (`lsv2_sk_`). Not needed for personal keys (`lsv2_pt_`). |

All variables are added to `SANDBOX_SECRET_ALLOWLIST` in `packages/ctxmill/src/config/container.ts` and forwarded to sandbox containers alongside LLM API keys.

If you prefer not to rely on host env passthrough, you can also store these keys as per-agent secrets. The current runtime injects arbitrary per-agent secret keys into the sandbox env, while host env passthrough remains allowlist-only.

## Per-Harness Behavior

### LangGraph

**Zero code changes.** The `@langchain/core` SDK auto-traces when `LANGSMITH_TRACING=true` and `LANGSMITH_API_KEY` are set. Produces detailed traces with:

- Full LangGraph execution flow (nodes, edges)
- ChatOpenAI LLM calls with messages, generations, token usage
- Tool executions (e.g., calculator) with inputs/outputs
- Middleware steps

Example trace:
```
LangGraph (chain) [2.80s]
├── model_request (chain) [1.63s]
│   └── ChatOpenAI (llm) [1.56s]
├── model_request (chain) [1.08s]
│   └── ChatOpenAI (llm) [1.05s]
└── tools (chain) [21ms]
    └── calculator (tool) [4ms]
```

### Claude Agents

Uses `wrapClaudeAgentSDK()` from `langsmith/experimental/anthropic`. The wrapper is applied in `ClaudeAgentsHarness.loadSdkModule()` when `LANGSMITH_TRACING=true`.

- Dynamic import — `langsmith` only loaded when tracing is enabled
- Graceful fallback — if import fails, harness runs without tracing
- SDK wrapper intercepts all Claude API calls and creates spans

Example trace:
```
claude.conversation (chain) [87.68s]
├── claude.assistant.turn (llm) [10.83s]
├── ToolSearch (tool) [12ms]
├── claude.assistant.turn (llm) [4.55s]
└── Bash (tool) [238ms]
```

**File:** `packages/sandbox-daemon/src/harness/claude-agents.ts`

### PI Agent

Custom tracer using the `RunTree` API from the `langsmith` package. The tracer maps PI Agent SDK subscribe events to LangSmith spans.

- Created per `deliverTurn()` call via `createPiLangSmithTracer()`
- Events forwarded from the PI SDK's `subscribe()` callback
- Serialized event chain ensures span ordering
- Explicit `patchRun()` calls ensure end times reach the server
- `Client.awaitPendingTraceBatches()` + drain timeout in flush

**Event → Span mapping:**

| PI SDK Event | LangSmith Span | Data Captured |
|-------------|---------------|---------------|
| `agent_start` | Root chain | agentId, conversationId |
| `turn_start` / `turn_end` | Turn chain | turnIndex, assistant text, usage |
| `message_start` (assistant) | LLM span start | model, provider, api |
| `message_update` | LLM text buffer | Accumulated delta text |
| `message_end` (assistant) | LLM span end | generations, token usage, stopReason |
| `message_start/end` (user) | — | Stored as next LLM span input |
| `tool_execution_start/end` | Tool span | toolName, args, result |
| `agent_end` | Root end | status=completed |

Example trace:
```
pi-agent-{id} (chain) [2.05s]
├── pi-turn (chain) [1.07s]
│   ├── llm-call (llm) [295ms]     ← model=gpt-5.4-mini, usage={in:68,out:68}
│   └── bash (tool) [4ms]
└── pi-turn (chain) [970ms]
    └── llm-call (llm) [264ms]
```

**Files:**
- `packages/sandbox-daemon/src/harness/pi-langsmith-tracer.ts` — Tracer module
- `packages/sandbox-daemon/src/harness/pi-agent.ts` — Wiring (subscribe + flush)

## Disabling Tracing

Remove or unset `LANGSMITH_TRACING` in `.env` and restart. When `LANGSMITH_TRACING` is not `true`:

- LangGraph: no auto-tracing (env var check in `@langchain/core`)
- Claude: `loadSdkModule()` returns unwrapped SDK (no `langsmith` import)
- PI Agent: `createPiLangSmithTracer()` returns `null` (no RunTree created)

No performance overhead when disabled — `langsmith` is never imported.

## Dependency

`langsmith@^0.5.15` is added to `packages/sandbox-daemon/package.json`. It runs inside sandbox containers only (not the orchestrator). The learning pipeline's own `ChatOpenAI` calls (from `@langchain/openai` in the orchestrator) also trace to the same project when `LANGSMITH_TRACING=true`.

## Files Changed

| File | Change |
|------|--------|
| `packages/ctxmill/src/config/container.ts` | Added `LANGSMITH_*` to `SANDBOX_SECRET_ALLOWLIST` |
| `docker-compose.yml` | Pass `LANGSMITH_*` env vars to orchestrator |
| `.env.example` | Documented new env vars |
| `packages/sandbox-daemon/package.json` | Added `langsmith` dependency |
| `packages/sandbox-daemon/src/harness/claude-agents.ts` | Conditional SDK wrapping |
| `packages/sandbox-daemon/src/harness/pi-agent.ts` | Tracer wiring + event logging |
| `packages/sandbox-daemon/src/harness/pi-langsmith-tracer.ts` | New file — PI Agent RunTree tracer |
| `packages/sandbox-daemon/src/harness/index.ts` | Export `createPiLangSmithTracer` |
