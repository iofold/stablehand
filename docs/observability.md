# Observability Setup Guide

This guide describes the observability features available in ctxmill for monitoring, tracing, and debugging agent runs and system performance.

## Overview

ctxmill provides several layers of observability:

- **LangSmith Tracing**: Opt-in tracing for agent execution flows, LLM calls, and tool usage.
- **Application Logging**: Fastify-based orchestrator logs and harness-level console output.
- **Event Audit Trail**: A persistent record of all system events in PostgreSQL.
- **Container Metrics**: Real-time stats on sandbox container concurrency and lifecycle.
- **SSE Event Stream**: Live execution events streamed to the UI for real-time debugging.

## LangSmith Tracing

ctxmill supports opt-in agent tracing via [LangSmith](https://smith.langchain.com). When enabled, every agent run produces a trace with span hierarchy, LLM call details, tool executions, and token usage.

### Setup

Add these variables to your `.env` file and restart the stack:

```bash
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_sk_...        # or lsv2_pt_...
LANGSMITH_PROJECT=ctxmill           # Optional, defaults to 'ctxmill'
LANGSMITH_WORKSPACE_ID=...           # Required for service account keys (lsv2_sk_)
```

### Per-Harness Behavior

Tracing is implemented at the harness level. The orchestrator forwards `LANGSMITH_*` environment variables to sandbox containers.

- **LangGraph**: Auto-traces via `@langchain/core`. No code changes required. Captures full graph flow, ChatOpenAI calls, and tool executions.
- **Claude Agents**: Uses `wrapClaudeAgentSDK()` from `langsmith/experimental/anthropic`. The wrapper intercepts Claude API calls and creates spans for assistant turns and tool usage.
- **PI Agent**: Uses a custom `RunTree` tracer that maps PI SDK events (e.g., `agent_start`, `turn_start`, `tool_execution_start`) to LangSmith spans.

### Disabling Tracing

To disable tracing, remove or unset `LANGSMITH_TRACING` in your `.env` and restart. When disabled, the `langsmith` package is not imported, ensuring zero performance overhead.

For more details, see [LangSmith Tracing](./langsmith-tracing.md).

## Application Logging

### Orchestrator Logs

The orchestrator uses the built-in Fastify logger (`logger: true`). These logs capture HTTP requests, database operations, and sandbox container lifecycle events.

The `ContainerManager` also emits `console.debug` messages for container creation, including resource allocations and concurrency stats:
`[ContainerManager] creating container ctxmill-run-... (harness=..., cpus=..., mem=...MiB, active=.../...)`

Access orchestrator logs via Docker Compose:

```bash
docker compose logs -f orchestrator
```

### Harness Logs

Harnesses run inside isolated sandbox containers. They use standard `console.log`, `console.debug`, and `console.error` for logging.

- **stdout**: General execution info. For example, the PI Agent harness logs every SDK event: `[pi-agent] SDK event: <type> keys=[...]`.
- **stderr**: Critical errors and stack traces.

If an agent run fails with "1 events emitted," it usually indicates a harness-level crash. Check the container stderr for the stack trace.

## Container Logs

Each agent run or session spawns a dedicated Docker container. You can access these logs directly using the Docker CLI.

### Finding Container IDs

Container names follow these patterns:
- **Runs**: `ctxmill-run-<sessionId>`
- **Sessions**: `ctxmill-session-<conversationIdHash>`

You can list all managed containers with:

```bash
docker ps --filter "label=ctxmill.managed=true"
```

### Accessing Logs

Once you have the container ID or name:

```bash
docker logs <container-id>
```

To tail logs for an active run:

```bash
docker logs -f <container-id>
```

## Event Audit Trail

Every significant action in ctxmill emits a typed event. These events are persisted to the `events` table in PostgreSQL, providing a full audit trail of system activity.

### Event Types

The current `EventMap` includes turn lifecycle, message-commit, tool, HITL, session, learning, and trigger events, including:
- `turn.pending` / `turn.started` / `turn.completed`
- `user.message` / `message.committed`
- `run.tool_started` / `run.tool_result`
- `run.text_chunk`
- `run.interrupted` / `run.interrupt_resolved`
- `session.paused` / `run.resumed`
- `run.ag_ui_event`
- `learning.trace_captured`
- `trigger.fired`

### Querying Events

You can query events via the API:

```bash
GET /api/events?limit=100
```

Or directly in PostgreSQL:

```sql
SELECT * FROM events ORDER BY created_at DESC LIMIT 100;
```

## Container Metrics

The `ContainerManager` tracks real-time metrics for sandbox containers. These metrics are useful for monitoring system load and concurrency limits.

### Available Metrics

- **active**: Currently running containers.
- **queued**: Requests waiting for a concurrency slot.
- **peak**: Highest concurrent count observed.
- **totalCreated**: Lifetime counter of containers created.
- **byHarness**: Active count breakdown per harness type (e.g., `langgraph`, `claude-agents`).
- **averageLifetimeMs**: Average duration of completed containers.

### Accessing Metrics

Metrics are included in the health check response:

```bash
GET /api/health
```

Or via the dedicated sandbox metrics endpoint:

```bash
GET /api/sandbox/metrics
```

## Debugging with Events

The internal event bus is the primary tool for tracing execution flow. A typical healthy turn follows this sequence:

1. `turn.started`: The orchestrator begins the run.
2. `run.text_chunk`: (Optional) Streaming text deltas from the LLM.
3. `run.tool_started`: The agent calls a tool.
4. `run.tool_result`: The tool execution completes.
5. `turn.completed`: The run finishes successfully.

If a run hangs, check the event stream to see which step failed to complete. Note that `message_committed` is a harness-level event used for persistence but is not currently emitted on the internal event bus.

## What Doesn't Exist Yet

It's important to note that ctxmill currently lacks several standard observability features:

- **No Structured Logging Library**: Logs are plain text or default Fastify JSON; there is no unified Pino or Winston setup across all services.
- **No OpenTelemetry**: Distributed tracing is limited to LangSmith for agents; there is no OTEL collector or instrumentation for the orchestrator.
- **No Prometheus Exporter**: Metrics are available via JSON API but not exported in Prometheus format.
- **No Grafana Dashboards**: No pre-built dashboards are provided.
- **No Correlation IDs**: There is no unified ID to trace a single request across the orchestrator and sandbox containers.

## Recommended Additions

For production deployments, consider implementing:

- **Structured Logging**: Integrate a library like Pino to provide consistent, searchable JSON logs across all packages.
- **Prometheus Metrics**: Add a `/metrics` endpoint using `prom-client` to export container and application stats.
- **OpenTelemetry**: Instrument the orchestrator with OTEL to provide full distributed tracing from the API down to the sandbox gRPC calls.
- **Log Aggregation**: Use a tool like Vector or FluentBit to collect Docker logs and send them to a central store (e.g., ELK, Loki).
