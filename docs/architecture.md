# Stablehand Architecture

> Describes the architecture shipped on `master`. Last full review: 2026-08-14.

## Purpose

Stablehand runs tool-using agents, on a schedule or on demand, behind a Fastify API and a React UI. The repository ships a Docker Compose stack with:

- a Node.js orchestrator
- PostgreSQL for agents, turns, messages, events, approvals, budgets and secrets
- an operator master token plus revocable, capability-scoped API keys for `/api/*` (routes without a capability annotation are master-only)
- three agent loops (harnesses): LangGraph, the Claude Agent SDK and Pi
- an event log that is written before it is streamed, so clients replay it after a reload
- approvals stored in the database, so they survive restarts
- schedules and triggers that start background runs
- session workspaces that are snapshotted and restored with each checkpoint
- an egress proxy that is each sandbox's only route to the internet

Agent loops run inside Docker containers managed by the sandbox subsystem. The orchestrator starts a container per agent session, talks to the gRPC daemon inside it, and streams its events to clients. Sandboxes are containers; there is no microVM (Firecracker) runtime.

## Deploy Shape

The supported install is `docker compose`.

```text
+---------------------------+       HTTP/SSE       +----------------------+
| UI (React, nginx)         | <------------------> | Orchestrator         |
| - dashboard               |                      | - Fastify API        |
| - chat                    |                      | - SSE + approvals    |
| - agent management        |                      | - schedules/triggers |
| - triggers / flow / files |                      +----------+-----------+
+---------------------------+                      |          |
                                                   | postgres | Docker socket, gRPC
                                                   v          v
                                        +----------------+  +-------------------+     +--------------+
                                        | PostgreSQL     |  | Sandbox Containers|---->| Egress proxy |--> allowed hosts
                                        | - agents       |  | - one per session |     | (mitmproxy)  |
                                        | - turns / msgs |  | - gRPC daemon     |     +--------------+
                                        | - events       |  | - agent loop      |
                                        | - triggers     |  | - tool proxy      |---->  S3-compatible
                                        | - secrets      |  | - workspace       |       artifact store
                                        +----------------+  +-------------------+
```

## Main Runtime Components

### 1. Orchestrator

The orchestrator is a Fastify server that wires together API auth, the database, the canonical event log, SSE manager, interrupt manager, sandbox session manager, trigger routes, and agent execution services.

Relevant code:

- [server.ts](../packages/stablehand/src/orchestrator/server.ts)
- [agent-turn-service.ts](../packages/stablehand/src/orchestrator/agent-turn-service.ts)
- [sandbox-session-manager.ts](../packages/stablehand/src/orchestrator/sandbox-session-manager.ts)
- [routes/agents.ts](../packages/stablehand/src/orchestrator/routes/agents.ts)
- [auth.ts](../packages/stablehand/src/orchestrator/auth.ts)

### 2. Multi-Harness Agent Execution

Agents are executed through a harness registry. The shipped harness adapters are:

- LangGraph (`langgraph`, built on deepagents)
- Claude Agent SDK (`claude-agents`)
- Pi (`pi-agent`)

Relevant code:

- [harness/index.ts](../packages/stablehand/src/harness/index.ts)
- [agent-turn-service.ts](../packages/stablehand/src/orchestrator/agent-turn-service.ts)
- [container.ts](../packages/stablehand/src/config/container.ts)

### 3. Tool Execution

Tools are registered centrally and executed through the local tool executor. The default container registers the Local, Artifact and Browser providers, and each agent gets its own HTTP tool provider and one provider per declared MCP server (`mcp/`). MCP clients run in the orchestrator, so server tokens stay out of sandboxes; see [mcp-servers.md](mcp-servers.md). Tools that declare `requiresApproval` pause on a durable approval in the orchestrator before they run. Composio is not wired.

Relevant code:

- [tool/executor.ts](../packages/stablehand/src/tool/executor.ts)
- [tool/providers/index.ts](../packages/stablehand/src/tool/providers/index.ts)
- [tool/registry.ts](../packages/stablehand/src/tool/registry.ts)

### 4. Event Bus, Canonical Log, and Triggers

Stablehand uses a typed in-process event bus plus a durable canonical event spine. Internal events are projected by `CanonicalProjector`, batch-persisted to `event_store` by `CanonicalLog`, and only then fanned out to live SSE clients. On the agent SSE route, browser reconnects replay from durable global sequence ids rather than volatile in-memory history. The AG-UI compat route does not yet support cursor-based reconnect replay — a reconnect there can miss frames (tracked as ctx-psax).

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
- `trigger.failed` — Event trigger matched but no run started: the target refused it (for example an `interactive`-only agent) or retries ran out. The firing is kept as a failed row, listed by `GET /api/triggers/failures`
- `custom` — User-emitted custom event via emit-event tool

Relevant code:

- [events/bus.ts](../packages/stablehand/src/events/bus.ts)
- [events/trigger-manager.ts](../packages/stablehand/src/events/trigger-manager.ts)
- [orchestrator/canonical/canonical-log.ts](../packages/stablehand/src/orchestrator/canonical/canonical-log.ts)
- [orchestrator/canonical/projector.ts](../packages/stablehand/src/orchestrator/canonical/projector.ts)
- [orchestrator/sse.ts](../packages/stablehand/src/orchestrator/sse.ts)
- [orchestrator/routes/agents/stream.ts](../packages/stablehand/src/orchestrator/routes/agents/stream.ts)

### 5. HITL and Suspend/Resume

HITL is implemented through durable interrupt records and UI responses. Sandbox sessions can be checkpointed, restored, and resumed through the session manager. This is application-level checkpoint/restore of harness and workspace state, not raw Docker memory snapshotting.

Relevant code:

- [interrupt.ts](../packages/stablehand/src/orchestrator/interrupt.ts)
- [sandbox-session-manager.ts](../packages/stablehand/src/orchestrator/sandbox-session-manager.ts)
- [routes/agents/interrupts.ts](../packages/stablehand/src/orchestrator/routes/agents/interrupts.ts)
- [orchestrator/session-manager/interrupt-resume-service.ts](../packages/stablehand/src/orchestrator/session-manager/interrupt-resume-service.ts)

### 6. Workspace Isolation

Each run can execute against a session-scoped workspace abstraction. The shipped implementation uses session workspace capture/restore helpers. Workspace changes are snapshotted into tar archives and restored into fresh containers during checkpoint recovery.

Relevant code:

- [workspace/session-workspace.ts](../packages/stablehand/src/workspace/session-workspace.ts)
- [workspace/tar-upload.ts](../packages/stablehand/src/workspace/tar-upload.ts)
- [workspace/ensure.ts](../packages/stablehand/src/workspace/ensure.ts)

### 7. External Learning Hooks

Stablehand emits run, message, tool, feedback, and custom events that external learning or evaluation services can consume. Core Stablehand does not currently own an active internal memory layer; domain-specific retrieval should live in explicit tools, MCP servers, HTTP providers, artifact workflows, or downstream services connected through webhooks/events.

Relevant code:

- [events/bus.ts](../packages/stablehand/src/events/bus.ts)
- [orchestrator/webhook-events.ts](../packages/stablehand/src/orchestrator/webhook-events.ts)
- [callback-dispatcher.ts](../packages/stablehand/src/orchestrator/callback-dispatcher.ts)

### 8. Sandbox Infrastructure

All harness execution routes through the sandbox subsystem. The orchestrator creates a Docker container per sandbox session, injects secrets into the sandbox environment, waits for gRPC health, opens the session, delivers turns, and streams events back. The subsystem also handles tool call proxying, checkpoint/restore, lifecycle reconciliation, workspace-diff capture, and direct artifact upload/download through daemon tools rather than orchestrator-side byte proxying.

Relevant code:

- [sandbox/container-manager.ts](../packages/stablehand/src/sandbox/container-manager.ts)
- [orchestrator/sandbox-session-manager.ts](../packages/stablehand/src/orchestrator/sandbox-session-manager.ts)
- [orchestrator/container-lifecycle-policy.ts](../packages/stablehand/src/orchestrator/container-lifecycle-policy.ts)
- [artifact-store.ts](../packages/stablehand/src/artifact/artifact-store.ts)
- [sandbox/runner.ts](../packages/sandbox-daemon/src/sandbox/runner.ts)
- [sandbox/daemon.ts](../packages/sandbox-daemon/src/sandbox/daemon.ts)
- [sandbox/tool-proxy.ts](../packages/sandbox-daemon/src/sandbox/tool-proxy.ts)
- [sandbox/checkpoint.ts](../packages/sandbox-daemon/src/sandbox/checkpoint.ts)
- [sandbox/proto-convert.ts](../packages/sandbox-daemon/src/sandbox/proto-convert.ts)

### 8a. Sandbox Egress Boundary

Sandboxes run on an internal Docker network with no route to the internet. The `egress` service (mitmproxy plus the Stablehand policy addon in `packages/egress-proxy`) is the only dual-homed member and therefore the only way out. Each sandbox receives `HTTP(S)_PROXY`, `NO_PROXY` and the deployment CA through its environment plus a read-only mount of the public CA; the orchestrator, MinIO and the model gateway stay direct on the internal network. Policy is a default-deny allowlist by method, host, port and path glob, judged on the destination the proxy really connects to: the CONNECT authority or request-target authority, with Host headers, HTTP/2 `:authority` and TLS SNI required to agree with it. IP literals need a rule naming that exact address; private, link-local and cloud-metadata destinations, including hostnames whose DNS answers are private, are refused unless a rule carries `!internal`, and connections are pinned to the vetted address. Raw TCP and DNS tunnels are refused. Denied requests return `403` with `X-Stablehand-Egress: denied` (see [packages/egress-proxy/README.md](../packages/egress-proxy/README.md) for the exceptions). Secrets still enter the sandbox environment today (see `SECURITY.md`); moving credential injection into the egress proxy so sandboxes hold no secrets is planned. Kubernetes deployments do not yet get the boundary (no NetworkPolicy or CA projection).

Relevant code:

- [packages/egress-proxy/addon/policy.py](../packages/egress-proxy/addon/policy.py)
- [packages/egress-proxy/addon/stablehand_egress.py](../packages/egress-proxy/addon/stablehand_egress.py)
- [runtime/spec.ts `buildSandboxEgressEnv`](../packages/stablehand/src/sandbox/runtime/spec.ts)
- [sandbox-daemon browser-handler.ts](../packages/sandbox-daemon/src/sandbox/browser-handler.ts)

### 9. A2UI Rendering

Structured A2UI blocks are produced through the intrinsic `a2ui-render` tool and rendered in the frontend from tool-call results rather than being parsed out of free-form assistant text.

Relevant code:

- [tool/builtin/a2ui-render.ts](../packages/stablehand/src/tool/builtin/a2ui-render.ts)
- [ToolCallCard.tsx](../packages/ui/src/components/session/ToolCallCard.tsx)

### 10. Harness Model Configuration

Models are configured per agent/harness. Core Stablehand does not own a global LLM provider; direct model access belongs inside harnesses, tools, or external modules.

Relevant code:

- [manifest/index.ts](../packages/manifest/src/index.ts)
- [harness/index.ts](../packages/stablehand/src/harness/index.ts)

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

- [enforcement/fanout.ts](../packages/sandbox-daemon/src/harness/enforcement/fanout.ts)
- [contracts harness.ts `HarnessTurnLimitsSchema`](../packages/contracts/src/harness.ts)

### 11. Configuration and DI

The config resolver and dependency injection container wire runtime services together.

Relevant code:

- [config/resolve.ts](../packages/stablehand/src/config/resolve.ts)
- [config/container.ts](../packages/stablehand/src/config/container.ts)

### 12. Proto Package

Protocol Buffer definitions for sandbox gRPC communication. Defines the `HarnessService` and `OrchestratorService` with streaming RPCs for agent execution, tool results, suspend, and kill operations.

Relevant code:

- [sandbox.proto](../packages/proto/stablehand/sandbox/v1/sandbox.proto)

## Request and Run Flow

### Interactive message flow

1. The UI posts a message to the orchestrator.
2. The orchestrator creates or reuses a conversation, starts a run, and invokes the selected agent harness.
3. The sandbox daemon yields streamed events over gRPC.
4. The orchestrator persists messages, tool calls, turn state, and canonical event frames.
5. SSE streams canonical AG-UI frames to subscribed clients, replaying by durable seq on reconnect (agent SSE route; the AG-UI compat route lacks reconnect replay — ctx-psax).
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

Relevant code: `packages/stablehand/src/orchestrator/turn-queue-admission.ts`, `packages/stablehand/src/orchestrator/turn-dispatcher.ts`, `packages/stablehand/src/orchestrator/turn-startup-service.ts`.

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
- `model_gateway_campaign_keys` / `model_gateway_campaign_spend` — gateway keys minted for a campaign (hash only) and the calls made with them, attributed to the campaign's tags with no turn ([ADR 026](adr/026-campaign-gateway-keys.md))
- `systemSettings` — Runtime configuration overrides

Schema migrations are one idempotent pass (`runMigrations`) under an advisory
lock. After a pass completes, the orchestrator records a fingerprint of the
migration source in `stablehand_schema_version` (row `schema-fingerprint`).
Later starts of the same build find it and skip the pass. A new build, a new
database, or a pass that failed part-way runs it again. One-time data
migrations (contract rewrites, adoption of pre-revision message history)
carry their own version rows, so they run once per database even when the
pass runs again. To force a pass on an unchanged build, delete the
`schema-fingerprint` row.

Relevant code:

- [schema-pg.ts](../packages/stablehand/src/database/schema-pg.ts)
- [repository.ts](../packages/stablehand/src/database/repository.ts)
- [migrations.ts](../packages/stablehand/src/database/migrations.ts)

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

- [App.tsx](../packages/ui/src/App.tsx)
- [Sidebar.tsx](../packages/ui/src/components/ui/Sidebar.tsx)
- [AgentDetailPage.tsx](../packages/ui/src/pages/AgentDetailPage.tsx)

## Current Limitations

- Harnesses execute inside Docker containers (one container per run).
- Learning/reflection is external to core Stablehand; use webhooks/events plus explicit tools or services for that layer.
- Suspend/resume is event-driven run resumption, not compute snapshot restoration.

## Roadmap Boundary

If a document describes any of the following as current behavior, treat it as future-state planning unless it explicitly says otherwise:

- Firecracker microVM execution
- VM snapshots or exact process-state resume
- Graph or vector-backed retrieval as a first-class runtime subsystem

That future work is tracked separately.
