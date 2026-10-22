# Observability Setup Guide

This guide describes the observability features available in stablehand for monitoring, tracing, and debugging agent runs and system performance.

## Overview

stablehand provides several layers of observability:

- **LangSmith Tracing**: Opt-in tracing for agent execution flows, LLM calls, and tool usage.
- **SigNoz / OpenTelemetry Tracing**: Local Docker orchestrator traces via Node auto-instrumentation.
- **Application Logging**: Fastify-based orchestrator logs and harness-level console output.
- **Event Audit Trail**: A persistent record of all system events in PostgreSQL.
- **Container Metrics**: Real-time stats on sandbox container concurrency and lifecycle.
- **SSE Event Stream**: Live execution events streamed to the UI for real-time debugging.

## LangSmith Tracing

stablehand supports opt-in agent tracing via [LangSmith](https://smith.langchain.com). When enabled, every agent run produces a trace with span hierarchy, LLM call details, tool executions, and token usage.

### Setup

Add these variables to your `.env` file and restart the stack:

```bash
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_sk_...        # or lsv2_pt_...
LANGSMITH_PROJECT=stablehand           # Optional, defaults to 'stablehand'
LANGSMITH_WORKSPACE_ID=...           # Required for service account keys (lsv2_sk_)
```

### Per-Harness Behavior

Tracing is implemented at the harness level. All three harnesses share the same
sandbox-daemon `traceAgentEvents()` decorator, which consumes normalized
`AgentEvent` streams and emits one LangSmith span tree per turn. The orchestrator
forwards `LANGSMITH_*` environment variables to sandbox containers.

- **LangGraph**: Traces through the shared AgentEvent tracer. Captures the agent → turn → LLM/tool span shape from normalized events.
- **Claude Agents**: Traces through the same shared AgentEvent tracer. The Claude SDK is **not** wrapped with `langsmith/experimental/anthropic`; spans come from the normalized `AgentEvent` stream.
- **PI Agent**: Traces through the same shared AgentEvent tracer. PI SDK subscribe events are used only for adapter-local event mapping, not for span emission.

See `docs/langsmith-tracing.md` for the full AgentEvent → span mapping.

### Disabling Tracing

To disable tracing, remove or unset `LANGSMITH_TRACING` in your `.env` and restart. When disabled, the `langsmith` package is not imported, ensuring zero performance overhead.

For more details, see [LangSmith Tracing](./langsmith-tracing.md).

## SigNoz / OpenTelemetry Tracing

The Docker Compose orchestrator service can be preloaded with Node OpenTelemetry auto-instrumentation using the optional `docker-compose.signoz.yml` override. Sandbox harness images preload the same instrumentation through Bun. By default the override exports to an OTLP HTTP collector on the Docker host (`http://host.docker.internal:4318`); set `OTEL_EXPORTER_OTLP_ENDPOINT` to send traces to a central collector instead. See [SigNoz for Debugging](signoz-for-debugging.md).

This captures orchestrator-side HTTP, Fastify, PostgreSQL, and related Node spans under `stablehand-orchestrator`, plus sandbox daemon spans under `stablehand-sandbox-<harness>`. Keep `deployment.environment` resource attributes accurate for the source environment so a shared collector can distinguish local, staging, and sandbox traffic.

For setup and trace verification commands, see [SigNoz for Debugging](./signoz-for-debugging.md).

## Application Logging

### Orchestrator Logs

The orchestrator uses the built-in Fastify logger (`logger: true`). These logs capture HTTP requests, database operations, and sandbox container lifecycle events.

The `ContainerManager` also emits `console.debug` messages for container creation, including resource allocations and concurrency stats:
`[ContainerManager] creating container stablehand-sandbox-... (harness=..., cpus=..., mem=...MiB, active=.../...)`

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

Each live sandbox session owns a dedicated Docker container. Multiple turns may
reuse that sandbox session. You can access its logs directly using the Docker
CLI.

### Finding Container IDs

Container names use `stablehand-sandbox-<sandboxSessionId>`, and the canonical
selector is `stablehand.sandbox-session-id=<sandboxSessionId>`.

You can list all managed containers with:

```bash
docker ps --filter "label=stablehand.managed=true"
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

Every significant action in stablehand emits a typed event. These events are persisted to the `events` table in PostgreSQL, providing a full audit trail of system activity.

### Event Types

The current `EventMap` includes turn lifecycle, message-commit, tool, HITL,
sandbox-session, feedback, and trigger events, including:
- `turn.pending` / `turn.started` / `turn.completed`
- `user.message` / `message.committed`
- `tool_call.started` / `tool_call.completed`
- `message.delta`
- `interrupt.requested` / `interrupt.resolved`
- `ag_ui.event`
- `feedback.received`
- `trigger.fired` / `trigger.failed`

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
2. `message.delta`: (Optional) Streaming text deltas from the LLM.
3. `tool_call.started`: The agent calls a tool.
4. `tool_call.completed`: The tool execution completes.
5. `turn.completed`: The run finishes successfully.

If a run hangs, check the event stream to see which step failed to complete. Note that `message_committed` is a harness-level event used for persistence but is not currently emitted on the internal event bus.

## What Doesn't Exist Yet

It's important to note that stablehand currently lacks several standard observability features:

- **No Structured Logging Library**: Logs are plain text or default Fastify JSON; there is no unified Pino or Winston setup across all services.
- **Limited OpenTelemetry**: Local Docker deploys can emit orchestrator and sandbox daemon traces to an OTLP collector; Kubernetes sandbox Jobs receive the same sandbox OTEL environment. Detailed model/provider traces still rely on LangSmith unless a harness adds deeper model-level OTEL export.
- **No Prometheus Exporter**: Metrics are available via JSON API but not exported in Prometheus format.
- **No Grafana Dashboards**: No pre-built dashboards are provided.
- **No Correlation IDs**: There is no unified ID to trace a single request across the orchestrator and sandbox containers.

## Recommended Additions

For production deployments, consider implementing:

- **Structured Logging**: Integrate a library like Pino to provide consistent, searchable JSON logs across all packages.
- **Prometheus Metrics**: Add a `/metrics` endpoint using `prom-client` to export container and application stats.
- **OpenTelemetry**: Instrument the orchestrator with OTEL to provide full distributed tracing from the API down to the sandbox gRPC calls.
- **Log Aggregation**: Use a tool like Vector or FluentBit to collect Docker logs and send them to a central store (e.g., ELK, Loki).
