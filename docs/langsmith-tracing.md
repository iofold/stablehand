# LangSmith Tracing

Opt-in agent tracing via [LangSmith](https://smith.langchain.com). When enabled, every agent run produces a trace visible in the LangSmith dashboard with span hierarchy, LLM call details, tool executions, and token usage.

## Quick Start

```bash
# Add to .env
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_sk_...        # or lsv2_pt_...
LANGSMITH_PROJECT=stablehand
LANGSMITH_WORKSPACE_ID=...           # Required for service account keys (lsv2_sk_)
```

Restart the stack. All subsequent agent runs produce traces in the configured project.

## How It Works

Tracing is **harness-level**. LangGraph, Claude Agents, and PI Agent all use the shared sandbox-daemon `traceAgentEvents` decorator, which consumes normalized `AgentEvent` streams and emits one LangSmith span tree per turn. The orchestrator passes `LANGSMITH_*` host environment variables to sandbox containers via `SANDBOX_SECRET_ALLOWLIST`.

```
.env → docker-compose → orchestrator → SANDBOX_SECRET_ALLOWLIST → sandbox container → harness
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LANGSMITH_TRACING` | Yes | Set to `true` to enable tracing |
| `LANGSMITH_API_KEY` | Yes | API key from smith.langchain.com/settings |
| `LANGSMITH_PROJECT` | No | Project name (default: `stablehand`) |
| `LANGSMITH_WORKSPACE_ID` | Conditional | Required for service account keys (`lsv2_sk_`). Not needed for personal keys (`lsv2_pt_`). |

All variables are added to `SANDBOX_SECRET_ALLOWLIST` in `packages/stablehand/src/config/container.ts` and forwarded to sandbox containers alongside LLM API keys.

If you prefer not to rely on host env passthrough, you can also store these keys as per-agent secrets. The current runtime injects arbitrary per-agent secret keys into the sandbox env, while host env passthrough remains allowlist-only.

## Per-Harness Behavior

### LangGraph

Uses the shared AgentEvent tracer through `traceAgentEvents()` when `LANGSMITH_TRACING=true`.

- Root span: `langgraph-agent-<agentId>`
- Turn span: `langgraph-turn`
- LLM span: normalized `text_delta` + `message_committed`
- Tool spans: normalized `tool_call_start`/`tool_call_end`
- Token usage: normalized `done.usage`

Example trace:
```
langgraph-agent-{id} (chain)
└── langgraph-turn (chain)
    ├── llm-call (llm)
    └── calculator (tool)
```

### Claude Agents

Uses the same shared AgentEvent tracer as LangGraph and PI Agent. The Claude SDK is not wrapped with `langsmith/experimental/anthropic`; the parity tests prove the normalized Claude `AgentEvent` stream produces the same agent → turn → LLM/tool span shape as the other harnesses.

- Dynamic import — `langsmith` only loaded when tracing is enabled
- Graceful fallback — if import fails, harness runs without tracing
- Root span: `claude-agents-agent-<agentId>`
- Turn span: `claude-agents-turn`
- LLM span: normalized `text_delta` + `message_committed`
- Tool spans: normalized `tool_call_start`/`tool_call_end`
- Token usage: normalized `done.usage`

> **Stability note**: the shared AgentEvent tracer depends on the stable but pre-1.0 `RunTree` API. Pin `langsmith` to a known-good minor (currently `^0.5.25`) and review the [LangSmith JS releases](https://github.com/langchain-ai/langsmith-sdk/releases) before bumping.

Example trace:
```
claude-agents-agent-{id} (chain)
└── claude-agents-turn (chain)
    ├── llm-call (llm)
    └── Bash (tool)
```

**Files:**
- `packages/sandbox-daemon/src/harness/kit/agent-event-langsmith-tracer.ts` — Shared tracer module
- `packages/sandbox-daemon/src/harness/kit/trace-agent-events.ts` — HarnessSession decorator
- `packages/sandbox-daemon/src/harness/claude-agents.ts` — Decorator wiring

### PI Agent

Uses the same shared AgentEvent tracer as LangGraph. PI SDK subscribe events are still used only for adapter-local event mapping and extension hooks; LangSmith spans are emitted from normalized `AgentEvent`s after mapping.

**AgentEvent → Span mapping:**

| AgentEvent | LangSmith Span | Data Captured |
|-------------|---------------|---------------|
| `text_delta` | LLM span | Accumulated assistant text |
| `tool_call_start` | Tool span | toolName, args, toolCallId |
| `tool_call_end` | Tool span end | result, error, durationMs |
| `message_committed` | LLM span end | final assistant text, toolCalls |
| `done` | Turn/root span end | token usage, status=completed |
| `error` | Turn/root span end | error, status=errored |

Example trace:
```
pi-agent-agent-{id} (chain)
└── pi-agent-turn (chain)
    ├── llm-call (llm)
    └── bash (tool)
```

**Files:**
- `packages/sandbox-daemon/src/harness/kit/agent-event-langsmith-tracer.ts` — Shared tracer module
- `packages/sandbox-daemon/src/harness/kit/trace-agent-events.ts` — HarnessSession decorator
- `packages/sandbox-daemon/src/harness/pi-agent.ts` — Decorator wiring

## Subagent visibility

| Harness | Subagent invocation | Subagent internals | Tokens |
|---|---|---|---|
| LangGraph | Visible only if the adapter maps it into normal AgentEvents | Not traced by the shared AgentEvent tracer | Only aggregate `done.usage` when available |
| Claude Agents | Visible only if the SDK stream folds it into normal AgentEvents | Not traced by the shared AgentEvent tracer | Only aggregate `done.usage` when available |

The shared tracer intentionally records the normalized STABLEHAND event contract, not SDK-private execution graphs. If subagent-internal token attribution becomes critical, add a second explicit reconciler that reads each harness' persisted transcript/log format and posts separate RunTrees, rather than reintroducing harness-specific live tracing paths.

Workaround options if subagent token attribution becomes critical:
- Implement local transcript reconciliation in our harness (read `~/.claude/projects/<sanitized>/sessions/<conversationId>.jsonl` after each run, post fresh `RunTree`s for missing subagent turns, patch usage on existing LLM runs).
- Adopt upstream SDK-level tracing only if it can preserve the normalized agent → turn → LLM/tool parity guaranteed by the shared tracer.

PI Agent does not currently support subagents.

## Verifying It Works

After setting the env vars and restarting the stack, send one test message:

```bash
curl -sS -XPOST -H 'Content-Type: application/json' \
  -d '{"content":"hi"}' \
  http://localhost:3002/api/agents/<any-agent-id>/message
```

Then in LangSmith (`https://smith.langchain.com`):

1. Open the project named in `LANGSMITH_PROJECT` (default `stablehand`).
2. The run should appear within 5–15s of the agent completing.
3. The root span name reflects the harness: `langgraph-agent-<id>` (chain), `claude-agents-agent-<id>` (chain), or `pi-agent-agent-<id>` (chain).

**Common reasons traces don't appear:**

| Symptom | Likely cause |
|---|---|
| Run never appears in any project | `LANGSMITH_TRACING` not exactly `"true"` (case-sensitive), or `LANGSMITH_API_KEY` empty |
| `403`/`401` warnings in sandbox logs | Service-account key (`lsv2_sk_…`) without `LANGSMITH_WORKSPACE_ID` set |
| Run appears in `default` project, not yours | `LANGSMITH_PROJECT` only forwarded to the sandbox via `SANDBOX_SECRET_ALLOWLIST` — orchestrator restart picks it up; sandbox containers are launched per run, so the next run will pick it up |
| Tool spans missing | The harness did not emit normalized `tool_call_start`/`tool_call_end` events, or an old sandbox image is still running |
| `[harness-trace] Failed to ...` warnings | Sandbox egress to `api.smith.langchain.com` is blocked by external network policy, DNS, firewall, or proxy configuration |

To see what the sandbox logged during a run:

```bash
docker logs $(docker ps --filter "label=stablehand.managed=true" --format "{{.Names}}" | head -1)
```

## Disabling Tracing

Remove or unset `LANGSMITH_TRACING` in `.env` and restart. When `LANGSMITH_TRACING` is not `true`:

- LangGraph: shared AgentEvent tracer returns `null`
- Claude: shared AgentEvent tracer returns `null` (no RunTree created)
- PI Agent: shared AgentEvent tracer returns `null` (no RunTree created)

No performance overhead when disabled — `langsmith` is never imported.

## Dependency

`langsmith@^0.5.25` is added to `packages/sandbox-daemon/package.json`. It runs inside sandbox containers only, not the orchestrator.

## Files Changed

| File | Change |
|------|--------|
| `packages/stablehand/src/config/container.ts` | Added `LANGSMITH_*` to `SANDBOX_SECRET_ALLOWLIST` |
| `docker-compose.yml` | Pass `LANGSMITH_*` env vars to orchestrator |
| `.env.example` | Documented new env vars |
| `packages/sandbox-daemon/package.json` | Added `langsmith` dependency |
| `packages/sandbox-daemon/src/harness/kit/agent-event-langsmith-tracer.ts` | Shared AgentEvent RunTree tracer |
| `packages/sandbox-daemon/src/harness/kit/trace-agent-events.ts` | HarnessSession tracing decorator |
| `packages/sandbox-daemon/src/harness/langgraph.ts` | Shared tracer decorator wiring |
| `packages/sandbox-daemon/src/harness/claude-agents.ts` | Shared tracer decorator wiring |
| `packages/sandbox-daemon/src/harness/pi-agent.ts` | Shared tracer decorator wiring + event logging |
