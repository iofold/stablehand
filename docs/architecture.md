# CTXMill Architecture

> Status: Current shipped architecture as of 2026-08-14.
> The sandbox execution migration shipped; its requirements spec is archived at [docs/plans/shipped/2026-03-17-sandbox-execution-requirements.md](plans/shipped/2026-03-17-sandbox-execution-requirements.md).

## Purpose

CTXMill is a self-hosted framework for running tool-using agents behind a Fastify API and a React UI. The current repo ships a Docker-first stack with:

- A Node.js orchestrator process
- PostgreSQL persistence
- Operator master token plus revocable, capability-scoped API keys for `/api/*` (fail-closed: unannotated routes are master-only)
- A multi-harness agent runtime
- Durable canonical SSE streaming to the UI
- Durable HITL interrupt handling
- Event-triggered background runs
- Session-scoped workspace snapshots

Agent harnesses execute inside Docker containers managed by the sandbox subsystem. The orchestrator creates a container per run, communicates with the in-container gRPC daemon, and streams events back to the UI. Firecracker-based sandboxing is not implemented yet.

## Deploy Shape

The supported workflow in this repo is `docker compose`.

```text
+---------------------------+       HTTP/SSE       +----------------------+
| UI (React, nginx)         | <------------------> | Orchestrator         |
| - dashboard               |                      | - Fastify API        |
| - chat                    |                      | - SSE + HITL         |
| - agent management        |                      | - triggers / runs    |
| - triggers / flow / files |                      +----------+-----------+
+---------------------------+                      |          |
                                                   | postgres | Docker socket
                                                   v          v
                                        +----------------+  +-------------------+
                                        | PostgreSQL     |  | Sandbox Containers|
                                        | - agents       |  | - one per run     |
                                        | - runs / msgs  |  | - gRPC daemon     |
                                        | - events       |  | - harness code    |
                                        | - triggers     |  | - tool proxy      |
                                        | - secrets      |  | - workspace       |
                                        +----------------+  +-------------------+
```

## Main Runtime Components

### 1. Orchestrator

The orchestrator is a Fastify server that wires together API auth, the database, the canonical event log, SSE manager, interrupt manager, sandbox session manager, trigger routes, and agent execution services.

Relevant code:

- [server.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/server.ts)
- [agent-session-service.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/agent-session-service.ts)
- [sandbox-session-manager.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/sandbox-session-manager.ts)
- [routes/agents.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/routes/agents.ts)
- [auth.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/auth.ts)

### 2. Multi-Harness Agent Execution

Agents are executed through a harness registry. The shipped harness adapters are:

- LangGraph
- Claude Agents
- PI Agent

Relevant code:

- [harness/index.ts](/path/to/stablehand/packages/ctxmill/src/harness/index.ts)
- [agent-session-service.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/agent-session-service.ts)
- [container.ts](/path/to/stablehand/packages/ctxmill/src/config/container.ts)

### 3. Tool Execution

Tools are registered centrally and executed through the local tool executor. The repo also ships provider abstractions for local, MCP, Composio, and HTTP-backed tools.

Relevant code:

- [tool/executor.ts](/path/to/stablehand/packages/ctxmill/src/tool/executor.ts)
- [tool/providers/index.ts](/path/to/stablehand/packages/ctxmill/src/tool/providers/index.ts)
- [tool/registry.ts](/path/to/stablehand/packages/ctxmill/src/tool/registry.ts)

### 4. Event Bus, Canonical Log, and Triggers

CTXMill uses a typed in-process event bus plus a durable canonical event spine. Internal events are projected by `CanonicalProjector`, batch-persisted to `event_store` by `CanonicalLog`, and only then fanned out to live SSE clients. Browser reconnects replay from durable global sequence ids rather than volatile in-memory history.

User-emitted custom events are persisted with their original type and payload and still drive trigger matching. Run-channel events are projected into canonical AG-UI frames for native SSE streams. The pre-canonical `?wire=legacy` escape hatch was removed (W6c, 2026-07-10); the canonical vocabulary is the only wire.

The TypedEventBus emits the following events:

- `turn.pending` — Turn accepted before sandbox readiness
- `turn.started` — Turn begins execution
- `turn.completed` — Turn finished (completed, error, or cancelled)
- `user.message` — Canonical user-message append for live SSE bootstrap
- `message.committed` — Canonical assistant/tool message commit
- `ag_ui.event` — Forwarded AG-UI events not handled individually
- `message.delta` — Streaming text delta from harness
- `tool_call.started` — Tool call initiated
- `tool_call.completed` — Tool call completed
- `interrupt.requested` — HITL approval needed
- `interrupt.resolved` — HITL approval/rejection received
- `feedback.received` — User thumbs up/down signal for external consumers
- `agent.created` — New agent registered
- `agent.deleted` — Agent removed
- `client.connected` — SSE client connected
- `client.disconnected` — SSE client disconnected
- `trigger.fired` — Event trigger matched and fired background run
- `custom` — User-emitted custom event via emit-event tool

Relevant code:

- [events/bus.ts](/path/to/stablehand/packages/ctxmill/src/events/bus.ts)
- [events/trigger-manager.ts](/path/to/stablehand/packages/ctxmill/src/events/trigger-manager.ts)
- [orchestrator/canonical/canonical-log.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/canonical/canonical-log.ts)
- [orchestrator/canonical/projector.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/canonical/projector.ts)
- [orchestrator/sse.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/sse.ts)
- [orchestrator/routes/agents/stream.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/routes/agents/stream.ts)

### 5. HITL and Suspend/Resume

HITL is implemented through durable interrupt records and UI responses. Sandbox sessions can be checkpointed, restored, and resumed through the session manager. This is application-level checkpoint/restore of harness and workspace state, not raw Docker memory snapshotting.

Relevant code:

- [interrupt.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/interrupt.ts)
- [suspended-session-matcher.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/suspended-session-matcher.ts)
- [sandbox-session-manager.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/sandbox-session-manager.ts)
- [routes/agents/interrupts.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/routes/agents/interrupts.ts)
- [orchestrator/session-manager/interrupt-resume-service.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/session-manager/interrupt-resume-service.ts)

### 6. Workspace Isolation

Each run can execute against a session-scoped workspace abstraction. The shipped implementation uses session workspace capture/restore helpers. Workspace changes are snapshotted into tar archives and restored into fresh containers during checkpoint recovery.

Relevant code:

- [workspace/session-workspace.ts](/path/to/stablehand/packages/ctxmill/src/workspace/session-workspace.ts)
- [workspace/tar-upload.ts](/path/to/stablehand/packages/ctxmill/src/workspace/tar-upload.ts)
- [workspace/ensure.ts](/path/to/stablehand/packages/ctxmill/src/workspace/ensure.ts)

### 7. External Learning Hooks

CTXMill emits run, message, tool, feedback, and custom events that external learning or evaluation services can consume. Core CTXMill does not currently own an active internal memory layer; domain-specific retrieval should live in explicit tools, MCP servers, HTTP providers, artifact workflows, or downstream services connected through webhooks/events.

Relevant code:

- [events/bus.ts](/path/to/stablehand/packages/ctxmill/src/events/bus.ts)
- [orchestrator/webhook-events.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/webhook-events.ts)
- [callback-dispatcher.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/callback-dispatcher.ts)

### 8. Sandbox Infrastructure

All harness execution routes through the sandbox subsystem. The orchestrator creates a Docker container per sandbox session, injects secrets into the sandbox environment, waits for gRPC health, opens the session, delivers turns, and streams events back. The subsystem also handles tool call proxying, checkpoint/restore, lifecycle reconciliation, workspace-diff capture, and direct artifact upload/download through daemon tools rather than orchestrator-side byte proxying.

Relevant code:

- [sandbox/container-manager.ts](/path/to/stablehand/packages/ctxmill/src/sandbox/container-manager.ts)
- [orchestrator/sandbox-session-manager.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/sandbox-session-manager.ts)
- [orchestrator/container-lifecycle-policy.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/container-lifecycle-policy.ts)
- [artifact-store.ts](/path/to/stablehand/packages/ctxmill/src/artifact/artifact-store.ts)
- [sandbox/runner.ts](/path/to/stablehand/packages/sandbox-daemon/src/sandbox/runner.ts)
- [sandbox/daemon.ts](/path/to/stablehand/packages/sandbox-daemon/src/sandbox/daemon.ts)
- [sandbox/tool-proxy.ts](/path/to/stablehand/packages/sandbox-daemon/src/sandbox/tool-proxy.ts)
- [sandbox/checkpoint.ts](/path/to/stablehand/packages/sandbox-daemon/src/sandbox/checkpoint.ts)
- [sandbox/proto-convert.ts](/path/to/stablehand/packages/sandbox-daemon/src/sandbox/proto-convert.ts)

### 9. A2UI Rendering

Structured A2UI blocks are produced through the intrinsic `a2ui-render` tool and rendered in the frontend from tool-call results rather than being parsed out of free-form assistant text.

Relevant code:

- [tool/builtin/a2ui-render.ts](/path/to/stablehand/packages/ctxmill/src/tool/builtin/a2ui-render.ts)
- [ToolCallCard.tsx](/path/to/stablehand/packages/ui/src/components/session/ToolCallCard.tsx)

### 10. Harness Model Configuration

Models are configured per agent/harness. Core CTXMill does not own a global LLM provider; direct model access belongs inside harnesses, tools, or external modules.

Relevant code:

- [manifest/index.ts](/path/to/stablehand/packages/manifest/src/index.ts)
- [harness/index.ts](/path/to/stablehand/packages/ctxmill/src/harness/index.ts)

### 10a. Per-Turn Fan-out Caps

Admission counts sandbox containers, but one sandbox can multiply provider and
tool concurrency without bound (parallel Task subagents, parallel tool
batches, unbounded agentic loops). Every turn therefore runs under fan-out
caps enforced inside the sandbox daemon: model calls, tool executions, and
subagent spawns are counted per turn against bounded defaults
(200/500/16), overridable upward per agent via `limits` in the harness
config. The model-call cap always cancels the turn — it is the universal
backstop, since even denied tool calls consume a model call. Tool and
subagent caps soft-deny on harnesses with a deny channel (LangGraph
middleware) and cancel elsewhere. A tripped cap emits one
`harness.fanout.limit` telemetry event and a plain-language error naming the
config knob. This is the first real implementation of the harness enforcement
seam reserved by [cost-control-and-model-gateway.md](specs/cost-control-and-model-gateway.md).

Relevant code:

- [enforcement/fanout.ts](/path/to/stablehand/packages/sandbox-daemon/src/harness/enforcement/fanout.ts)
- [contracts harness.ts `HarnessTurnLimitsSchema`](/path/to/stablehand/packages/contracts/src/harness.ts)

### 11. Configuration and DI

The `docker` execution preset, config resolver, and dependency injection container wire runtime services together.

Relevant code:

- [config/presets.ts](/path/to/stablehand/packages/ctxmill/src/config/presets.ts)
- [config/resolve.ts](/path/to/stablehand/packages/ctxmill/src/config/resolve.ts)
- [config/container.ts](/path/to/stablehand/packages/ctxmill/src/config/container.ts)

### 12. Proto Package

Protocol Buffer definitions for sandbox gRPC communication. Defines the `HarnessService` and `OrchestratorService` with streaming RPCs for agent execution, tool results, suspend, and kill operations.

Relevant code:

- [sandbox.proto](/path/to/stablehand/packages/proto/ctxmill/sandbox/v1/sandbox.proto)

## Request and Run Flow

### Interactive message flow

1. The UI posts a message to the orchestrator.
2. The orchestrator creates or reuses a conversation, starts a run, and invokes the selected agent harness.
3. The sandbox daemon yields streamed events over gRPC.
4. The orchestrator persists messages, tool calls, turn state, and canonical event frames.
5. SSE streams canonical AG-UI frames to subscribed clients, replaying by durable seq on reconnect.
6. If the run requests approval, the run is interrupted and later resumed when the user responds.

### Triggered background flow

1. An event is emitted on the bus.
2. The trigger manager matches persisted triggers for that event type.
3. A background run is created for the target agent.
4. The same run service handles execution, persistence, and SSE.

### Turn admission, durable queue, and dispatch (ctx-z5k0)

1. Admission checks global and per-agent queue depth **before any write** and rejects with `429 queue_full` (typed body, `Retry-After`) or `503 dispatch_stalled` — a rejected request leaves no message and no turn row behind; the caller owns the retry.
2. Accepted turns land as `turns.status='queued'` rows — the queued rows *are* the queue; there is no in-process waiter list.
3. A single-flight dispatcher loop (1s poll, batch 32, kick-coalescing from enqueue paths) claims candidates through the delivery lease and a per-agent concurrency reservation. Lane temperature is a claim-time predicate, never stored: a conversation with an ACTIVE sandbox session dispatches on the warm lane regardless of container slots; everything else needs slot headroom.
4. Fairness is oldest-turn-of-least-recently-served-agent, with per-conversation head-of-line ordering. Stale candidates simply fail their lease claim and are skipped — the loop takes no row locks.
5. Queued turns past `queuedTurnTimeoutMs` finalize honestly as `turn.failed reason=queue_expired`.
6. Startup reconciliation fails stranded running turns and skips HITL-parked turns; queued rows are dispatcher work, not boot debt — the dispatcher drains any pre-restart backlog in the background after listen. `turn.started` emission stays idempotent for pre-boot recoveries, so replay does not double-count run starts.

Relevant code: `packages/ctxmill/src/orchestrator/turn-queue-admission.ts`, `packages/ctxmill/src/orchestrator/turn-dispatcher.ts`, `packages/ctxmill/src/orchestrator/turn-startup-service.ts`.

## Persistence Model

PostgreSQL is the current system of record for:

- `agents` — Agent definitions (name, model, harness, and tools)
- `conversations` — Chat conversation sessions per agent
- `messages` — Individual messages within conversations
- `sandbox_sessions` — Sandbox session per conversation (status, restore attempts)
- `turns` — Per-turn run lifecycle (status, timing, errors, session link, pause/resume)
- `event_store` — Durable canonical event log and operational event API source
- `suspended_sessions` — Sessions waiting on external events
- `eventTriggers` — Event-driven agent trigger rules
- `pendingInterrupts` — HITL approval requests in progress
- `interruptResumeAttempts` — Durable restart-safe HITL resume attempts
- `agentCheckpoints` — Sandbox checkpoint/resume state
- `callbackOutbox` — Outbound webhook delivery queue with retry
- `webhooks` — Registered webhook endpoints per agent
- `artifacts` — S3/MinIO artifact metadata
- `api_keys` — Scoped API key hashes, capabilities, expiry, and revocation state
- `turn_delivery_leases` — Dispatcher claim leases (monotonic fence) for queued turns
- Model-gateway spend ledger tables — per-call spend attribution, reconciliation watermarks, and quarantine (see [docs/specs/cost-control-and-model-gateway.md](specs/cost-control-and-model-gateway.md))
- `systemSettings` — Runtime configuration overrides

Relevant code:

- [schema-pg.ts](/path/to/stablehand/packages/ctxmill/src/database/schema-pg.ts)
- [repository.ts](/path/to/stablehand/packages/ctxmill/src/database/repository.ts)
- [migrations.ts](/path/to/stablehand/packages/ctxmill/src/database/migrations.ts)

## UI Surface

The shipped frontend is broader than a basic dashboard/chat shell. It includes:

- Dashboard
- Chat
- Agent detail
- Events
- Tools
- Agent flow
- Triggers
- Artifacts
- Settings
- Overview, Sessions, Tools, Files, Artifacts, and Secrets tabs inside agent detail

Relevant code:

- [App.tsx](/path/to/stablehand/packages/ui/src/App.tsx)
- [Sidebar.tsx](/path/to/stablehand/packages/ui/src/components/ui/Sidebar.tsx)
- [AgentDetailPage.tsx](/path/to/stablehand/packages/ui/src/pages/AgentDetailPage.tsx)

## Current Limitations

- Harnesses execute inside Docker containers (one container per run).
- Learning/reflection is external to core CTXMill; use webhooks/events plus explicit tools or services for that layer.
- Suspend/resume is event-driven run resumption, not compute snapshot restoration.

## Roadmap Boundary

If a document describes any of the following as current behavior, treat it as future-state planning unless it explicitly says otherwise:

- Firecracker microVM execution
- VM snapshots or exact process-state resume
- Graph or vector-backed retrieval as a first-class runtime subsystem

That future work is tracked in plan documents; the original sandbox migration spec is archived at [2026-03-17-sandbox-execution-requirements.md](plans/shipped/2026-03-17-sandbox-execution-requirements.md).
