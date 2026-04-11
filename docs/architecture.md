# CTXMill Architecture

> Status: Current shipped architecture as of 2026-03-17.
> Future sandbox work is tracked separately in [docs/plans/2026-03-17-sandbox-execution-requirements.md](/path/to/stablehand/docs/plans/2026-03-17-sandbox-execution-requirements.md).

## Purpose

CTXMill is a self-hosted framework for running tool-using agents behind a Fastify API and a React UI. The current repo ships a Docker-first stack with:

- A Node.js orchestrator process
- PostgreSQL persistence
- A multi-harness agent runtime
- SSE streaming to the UI
- HITL interrupt handling
- Event-triggered background runs
- Session-scoped workspace overlays

Agent harnesses execute inside Docker containers managed by the sandbox subsystem. The orchestrator creates a container per run, communicates with the in-container gRPC daemon, and streams events back to the UI. Firecracker-based sandboxing is not implemented yet.

## Deploy Shape

The supported workflow in this repo is `docker compose`.

```text
+---------------------------+       HTTP/SSE       +----------------------+
| UI (React, nginx)         | <------------------> | Orchestrator         |
| - dashboard               |                      | - Fastify API        |
| - chat                    |                      | - SSE + HITL         |
| - knowledge               |                      | - triggers / runs    |
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

The orchestrator is a Fastify server that wires together the database, SSE manager, interrupt manager, sandbox session manager, knowledge routes, trigger routes, and agent execution services.

Relevant code:

- [server.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/server.ts)
- [agent-session-service.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/agent-session-service.ts)
- [sandbox-session-manager.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/sandbox-session-manager.ts)
- [routes/agents.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/routes/agents.ts)

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

### 4. Event Bus and Triggers

CTXMill uses a typed in-process event bus. It persists events, powers SSE broadcasting, feeds the learning pipeline, drives suspended-session matching, and can fire background runs through persisted event triggers.

The TypedEventBus emits the following events:

- `turn.pending` — Turn accepted before sandbox readiness
- `turn.started` — Turn begins execution
- `turn.completed` — Turn finished (completed, error, or cancelled)
- `user.message` — Canonical user-message append for live SSE bootstrap
- `message.committed` — Canonical assistant/tool message commit
- `run.ag_ui_event` — Forwarded AG-UI events not handled individually
- `run.text_chunk` — Streaming text delta from harness
- `run.tool_started` — Tool call initiated
- `run.tool_result` — Tool call completed
- `run.interrupted` — HITL approval needed
- `run.interrupt_resolved` — HITL approval/rejection received
- `session.paused` — Manual/compatibility session pause event
- `run.resumed` — Suspended run resumed after event match
- `learning.trace_captured` — Execution trace saved for reflection
- `learning.insight_extracted` — Reflector produced new insights
- `learning.knowledge_updated` — Knowledge store updated from learning
- `feedback.received` — User thumbs up/down on a run
- `agent.created` — New agent registered
- `agent.deleted` — Agent removed
- `client.connected` — SSE client connected
- `client.disconnected` — SSE client disconnected
- `trigger.fired` — Event trigger matched and fired background run
- `custom` — User-emitted custom event via emit-event tool

Relevant code:

- [events/bus.ts](/path/to/stablehand/packages/ctxmill/src/events/bus.ts)
- [events/trigger-manager.ts](/path/to/stablehand/packages/ctxmill/src/events/trigger-manager.ts)
- [sse-broadcaster.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/sse-broadcaster.ts)

### 5. HITL and Suspend/Resume

HITL is implemented through durable interrupt records and UI responses. Sandbox sessions can also be paused manually, checkpointed, restored, and resumed through the session manager. Separately, `SuspendedSessionMatcher` can emit `run.resumed` for event-driven resumptions. This is application-level checkpoint/restore of harness and workspace state, not raw Docker memory snapshotting.

Relevant code:

- [interrupt.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/interrupt.ts)
- [suspended-session-matcher.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/suspended-session-matcher.ts)
- [sandbox-session-manager.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/sandbox-session-manager.ts)
- [routes/agents.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/routes/agents.ts)

### 6. Workspace Isolation

Each run can execute against a session-scoped workspace abstraction. The shipped implementations are:

- `MockOverlayEnvironment`
- `FuseOverlayEnvironment`

Sandbox containers use FUSE overlays for workspace isolation when `fuse-overlayfs` is available, falling back to a mock overlay otherwise.

Relevant code:

- [workspace/types.ts](/path/to/stablehand/packages/ctxmill/src/workspace/types.ts)
- [workspace/mock-overlay.ts](/path/to/stablehand/packages/ctxmill/src/workspace/mock-overlay.ts)
- [workspace/fuse-overlay.ts](/path/to/stablehand/packages/ctxmill/src/workspace/fuse-overlay.ts)
- [config/factories.ts](/path/to/stablehand/packages/ctxmill/src/config/factories.ts)

### 7. Knowledge and Learning

The repo ships:

- A `KnowledgeStore` abstraction
- An in-memory knowledge store
- A Mem0-backed store
- A simple context provider
- A learning pipeline that stores traces, reflects on them, and writes insights back into knowledge

The Docker preset currently selects `pgvector`, but the factory still falls back to the in-memory knowledge store because a pgvector-backed knowledge store is not wired into the shipped runtime yet.

Relevant code:

- [knowledge/store.ts](/path/to/stablehand/packages/ctxmill/src/knowledge/store.ts)
- [knowledge/mem0-store.ts](/path/to/stablehand/packages/ctxmill/src/knowledge/mem0-store.ts)
- [learning/pipeline.ts](/path/to/stablehand/packages/ctxmill/src/learning/pipeline.ts)
- [learning/event-subscriber.ts](/path/to/stablehand/packages/ctxmill/src/learning/event-subscriber.ts)
- [config/presets.ts](/path/to/stablehand/packages/ctxmill/src/config/presets.ts)
- [config/factories.ts](/path/to/stablehand/packages/ctxmill/src/config/factories.ts)

### 8. Sandbox Infrastructure

All harness execution routes through the sandbox subsystem. The orchestrator creates a Docker container per sandbox session, injects secrets via tmpfs, waits for gRPC health, opens the session, delivers turns, and streams events back. The subsystem also handles tool call proxying, checkpoint/restore, lifecycle reconciliation, and workspace-diff capture.

Relevant code:

- [sandbox/container-manager.ts](/path/to/stablehand/packages/ctxmill/src/sandbox/container-manager.ts)
- [orchestrator/sandbox-session-manager.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/sandbox-session-manager.ts)
- [orchestrator/container-lifecycle-policy.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/container-lifecycle-policy.ts)
- [sandbox/runner.ts](/path/to/stablehand/packages/sandbox-daemon/src/sandbox/runner.ts)
- [sandbox/daemon.ts](/path/to/stablehand/packages/sandbox-daemon/src/sandbox/daemon.ts)
- [sandbox/tool-proxy.ts](/path/to/stablehand/packages/sandbox-daemon/src/sandbox/tool-proxy.ts)
- [sandbox/checkpoint.ts](/path/to/stablehand/packages/sandbox-daemon/src/sandbox/checkpoint.ts)
- [sandbox/proto-convert.ts](/path/to/stablehand/packages/sandbox-daemon/src/sandbox/proto-convert.ts)

### 9. A2UI Rendering

Structured A2UI blocks are produced through the intrinsic `a2ui-render` tool and rendered in the frontend from tool-call results rather than being parsed out of free-form assistant text.

Relevant code:

- [tool/builtin/a2ui-render.ts](/path/to/stablehand/packages/ctxmill/src/tool/builtin/a2ui-render.ts)
- [ToolCallCard.tsx](/path/to/stablehand/packages/ui/src/components/chat/ToolCallCard.tsx)

### 10. LLM Abstraction Layer

A provider-agnostic LLM interface used by the learning reflector and other subsystems that need direct LLM access outside of harness execution.

Relevant code:

- [llm/factory.ts](/path/to/stablehand/packages/ctxmill/src/llm/factory.ts)
- [llm/langchain.ts](/path/to/stablehand/packages/ctxmill/src/llm/langchain.ts)
- [llm/types.ts](/path/to/stablehand/packages/ctxmill/src/llm/types.ts)

### 11. Skills Loader

Loads skill definitions in SKILL.md format (frontmatter + markdown body) for agent tool augmentation.

Relevant code:

- [skills/loader.ts](/path/to/stablehand/packages/ctxmill/src/skills/loader.ts)

### 12. Configuration and DI

The `docker` execution preset, component factories, and the dependency injection container that wires runtime services together.

Relevant code:

- [config/presets.ts](/path/to/stablehand/packages/ctxmill/src/config/presets.ts)
- [config/factories.ts](/path/to/stablehand/packages/ctxmill/src/config/factories.ts)
- [config/container.ts](/path/to/stablehand/packages/ctxmill/src/config/container.ts)

### 13. Proto Package

Protocol Buffer definitions for sandbox gRPC communication. Defines the `HarnessService` and `OrchestratorService` with streaming RPCs for agent execution, tool results, suspend, and kill operations.

Relevant code:

- [sandbox.proto](/path/to/stablehand/packages/proto/ctxmill/sandbox/v1/sandbox.proto)

## Request and Run Flow

### Interactive message flow

1. The UI posts a message to the orchestrator.
2. The orchestrator creates or reuses a conversation, starts a run, and invokes the selected agent harness.
3. The harness yields streamed events.
4. The run service persists messages, tool calls, and run state.
5. SSE broadcasts stream updates to subscribed clients.
6. If the run requests approval, the run is interrupted and later resumed when the user responds.

### Triggered background flow

1. An event is emitted on the bus.
2. The trigger manager matches persisted triggers for that event type.
3. A background run is created for the target agent.
4. The same run service handles execution, persistence, SSE, and learning side effects.

## Persistence Model

PostgreSQL is the current system of record for:

- `agents` — Agent definitions (name, model, harness, tools, status)
- `conversations` — Chat conversation sessions per agent
- `messages` — Individual messages within conversations
- `knowledgeItems` — Agent-specific knowledge entries
- `executionTraces` — Run execution trace data (steps, outcome)
- `agentRuns` — Run lifecycle (status, timing, errors, session, pause/resume)
- `eventStore` — Persisted event log
- `suspendedRuns` — Runs waiting on external events
- `scheduledEvents` — Time-based scheduled event delivery
- `eventTriggers` — Event-driven agent trigger rules
- `agentVersions` — Agent manifest version history
- `pendingInterrupts` — HITL approval requests in progress
- `feedbackSignals` — User feedback on traces
- `agentCheckpoints` — Sandbox checkpoint/resume state
- `callbackOutbox` — Outbound webhook delivery queue with retry
- `webhooks` — Registered webhook endpoints per agent

Relevant code:

- [schema-pg.ts](/path/to/stablehand/packages/ctxmill/src/database/schema-pg.ts)
- [repository.ts](/path/to/stablehand/packages/ctxmill/src/database/repository.ts)
- [migrations.ts](/path/to/stablehand/packages/ctxmill/src/database/migrations.ts)

## UI Surface

The shipped frontend is broader than a basic dashboard/chat shell. It includes:

- Dashboard
- Chat
- Agent detail
- Run detail
- Events
- Tools
- Agent flow
- Knowledge
- Triggers
- Settings
- Overview, Knowledge, Runs, Tools, Files, Subagents, and Secrets tabs inside agent detail

Relevant code:

- [App.tsx](/path/to/stablehand/packages/ui/src/App.tsx)
- [Sidebar.tsx](/path/to/stablehand/packages/ui/src/components/ui/Sidebar.tsx)
- [AgentDetailPage.tsx](/path/to/stablehand/packages/ui/src/pages/AgentDetailPage.tsx)

## Current Limitations

- Harnesses execute inside Docker containers (one container per run).
- `pgvector` and `AGE` are not part of the active shipped knowledge path.
- The learning pipeline is optional and is disabled when no global learning LLM key is configured.
- Suspend/resume is event-driven run resumption, not compute snapshot restoration.
- Shared knowledge APIs are present, but the default in-memory fallback does not provide full shared-search behavior.

## Roadmap Boundary

If a document describes any of the following as current behavior, treat it as future-state planning unless it explicitly says otherwise:

- Firecracker microVM execution
- VM snapshots or exact process-state resume
- AGE-backed graph knowledge search
- A fully wired pgvector-backed knowledge store

That future work is tracked in plan documents, especially [2026-03-17-sandbox-execution-requirements.md](/path/to/stablehand/docs/plans/2026-03-17-sandbox-execution-requirements.md).
