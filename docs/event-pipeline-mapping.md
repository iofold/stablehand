# CTXMill Protocol Mapping Spec

> Working reference for how AG-UI wire events and gRPC proto fields map to current ctxmill runtime behavior.
> Updated: 2026-04-07 (post `turn.pending`, broadcaster centralization, and durable HITL refinements)

## Core Entities

Table of the 4 key identifiers:
- `conversationId` — Persistent conversation. 1:1 with a conversation DB row. Used across sessions.
- `turnId` — Single request→response cycle within a session. Created per user message. This is what becomes `runId` on the AG-UI wire.
- `sessionId` — Sandbox container session. Persists across turns for the same conversation. Maps to `sandbox_sessions` DB table.
- `runId` (wire only) — AG-UI protocol field. NOT an internal entity. Exists only in SSE events sent to the browser. Populated from `turnId` (for run events) or `conversationId` (for user message events).

## Section 1: AG-UI Protocol Mapping

### Wire Format

The AG-UI protocol defines `runId` as a required field on all events. In ctxmill:

Bootstrap SSE frames such as `CONNECTED` and `state_snapshot` are written directly by the stream route and are not part of the standard AG-UI run-lifecycle table below.

| AG-UI Event Type | Wire `runId` value | Source location |
|---|---|---|
| TURN_PENDING | turnId | SSEBroadcaster (from bus `turn.pending`) |
| RUN_STARTED | turnId | SSEBroadcaster (from bus `turn.started`) |
| RUN_FINISHED | turnId | SSEBroadcaster (from bus `turn.completed`) |
| RUN_ERROR | turnId | Usually SSEBroadcaster (from `turn.completed` with `status = error/cancelled`); low-level `RUN_ERROR` AG-UI events may also be forwarded via `run.ag_ui_event` |
| TEXT_MESSAGE_START | conversationId (user msg) or turnId (assistant) | SSEBroadcaster (from `user.message` for user echoes or `run.ag_ui_event` for assistant events) |
| TEXT_MESSAGE_CONTENT | turnId | SSEBroadcaster (from bus `run.text_chunk` or forwarded `run.ag_ui_event`) |
| TEXT_MESSAGE_END | conversationId (user msg) or turnId (assistant) | SSEBroadcaster (from `user.message` for user echoes or `run.ag_ui_event` for assistant events) |
| TOOL_CALL_START | turnId | SSEBroadcaster (from bus `run.tool_started`) |
| TOOL_CALL_ARGS | turnId | SSEBroadcaster (synthetic, emitted after TOOL_CALL_START) |
| TOOL_CALL_RESULT | turnId | SSEBroadcaster (from bus `run.tool_result`) |
| MESSAGE_COMMITTED | turnId | SSEBroadcaster (from bus `message.committed`; source commit event is created by `AgentSessionService`) |
| CUSTOM | varies (turnId, sessionId, or agentId) | Mixed: `session.paused`, `run.interrupt_resolved`, `run.ag_ui_event`, and direct stream-route bootstrap snapshots |

### SSE Broadcast Resolution

SSEBroadcaster resolves the wire `runId` with a fallback chain:
```
payload.turnId ?? payload.sessionId ?? payload.runId
```

### Emission Paths

1. **EventBus → SSEBroadcaster → SSE** — Most run-lifecycle, preview, and committed-message events. This includes `turn.pending`, `turn.started`, `run.text_chunk`, `run.tool_*`, `message.committed`, `session.paused`, and `turn.completed`.
2. **SessionTurnService → AgentSessionService** — Sandbox `message_committed` events first become internal AG-UI `MESSAGE_COMMITTED` events in the turn service, then `AgentSessionService` persists them and re-emits a canonical `message.committed` bus event.
3. **AgentSessionService → `run.ag_ui_event` → SSEBroadcaster** — AG-UI events that are not individually normalized onto first-class bus events are forwarded through `run.ag_ui_event`.
4. **Stream route → direct SSE** — Bootstrap frames only (`CONNECTED`, `state_snapshot`).
5. **gRPC `EmitEvent` / `emit-event` tool → raw event-bus subscribers** — Custom agent-emitted events are persisted and dispatched to matching subscribers (for example triggers). They are not part of the standard AG-UI run-lifecycle mapping unless another layer explicitly re-emits them.

## Section 2: Internal Event Bus Mapping

Key runtime event types from `packages/ctxmill/src/events/bus.ts` that affect AG-UI mapping:

| Internal Event | Key Fields | AG-UI Mapping | Notes |
|---|---|---|---|
| turn.pending | turnId, agentId, conversationId, mode | TURN_PENDING | Pre-start indicator emitted before full session readiness |
| turn.started | turnId, sessionId, agentId, conversationId, mode | RUN_STARTED | — |
| user.message | agentId, conversationId, messageId, content | TEXT_MESSAGE_START / CONTENT / END | SSEBroadcaster synthesizes user-message echo events |
| run.text_chunk | turnId, agentId, messageId, content | TEXT_MESSAGE_CONTENT | — |
| run.tool_started | turnId, agentId, toolCallId, toolName, args | TOOL_CALL_START + TOOL_CALL_ARGS | — |
| run.tool_result | turnId, agentId, toolCallId, toolName, result, durationMs | TOOL_CALL_RESULT | — |
| run.interrupted | turnId, agentId, toolCallId, toolName, args, interruptId | HITL_PAUSE | Durable HITL pause signal |
| run.interrupt_resolved | turnId, agentId, interruptId, action | CUSTOM | Interrupt resolution marker |
| session.paused | sessionId, agentId, conversationId, reason | CUSTOM | Idle-only session pause event; uses sessionId rather than turnId |
| message.committed | turnId, agentId, conversationId, messageSeq, role, content | MESSAGE_COMMITTED | Canonical assistant/tool commit emitted by `AgentSessionService` |
| run.ag_ui_event | turnId, agentId, conversationId?, event | Passthrough | Forwards AG-UI events not otherwise normalized |
| turn.completed | turnId, sessionId, agentId, conversationId, status, durationMs | RUN_FINISHED (+ RUN_ERROR on error/cancelled) | Terminal lifecycle event |
| run.resumed | turnId, agentId, triggeredBy, suspendedDurationMs | Not mapped to AG-UI | — |
| feedback.received | feedbackId, turnId, agentId, type | Not mapped to AG-UI | External learning/analytics signal |
| trigger.fired | triggerId, agentId, eventType, turnId | Not mapped to AG-UI | — |
| agent.created/deleted | agentId | Not mapped to AG-UI | Internal only |
| client.connected/disconnected | agentId, clientId | Not mapped to AG-UI | Internal only |
| custom | type, agentId, payload | Not part of standard AG-UI run-lifecycle mapping | Persisted/dispatched to raw subscribers such as triggers |

## Section 3: gRPC Proto Mapping

### Services

**HarnessService** (Orchestrator → Sandbox):

| RPC | Proto Request | Proto Response | Key Field Mapping |
|---|---|---|---|
| OpenSession | session_id, agent_id, conversation_id, bootstrap (fresh or restore) | stream SessionEvent | session_id → sessionId |
| DeliverTurn | session_id, messages[], turn_id, tools[] | stream SessionEvent | turn_id → turnId (becomes runId in harness) |
| SuspendSession | session_id, reason | SessionCheckpoint | session_id → sessionId |
| KillSession | session_id, reason | Empty | session_id → sessionId |

**OrchestratorService** (Sandbox → Orchestrator):

| RPC | Proto Request | Proto Response | Key Field Mapping |
|---|---|---|---|
| RequestTool | tool_name, arguments_json, request_id | ToolCallResult | orchestrator-side tool execution |
| EmitEvent | event_type, payload (JSON) | Empty | payload.runId = sessionId (injected by orchestrator) |
| RegisterArtifact | metadata, upload_url | ArtifactRecord | S3/MinIO registration |
| ResolveArtifact | artifact_id | ArtifactRecord | S3/MinIO lookup |

### Proto → Harness Internal Mapping

The conversion functions in `packages/sandbox-daemon/src/sandbox/proto-convert.ts`:

| Proto Field | Internal Type | Field Name | Notes |
|---|---|---|---|
| DeliverTurnRequest.turn_id | HarnessTurnInput.turnId | turnId | Becomes `runId` in harness tool context |
| DeliverTurnRequest.session_id | (used for gRPC context) | sessionId | — |
| FreshBootstrap.agent_id | HarnessSessionConfig.agentId | agentId | — |
| FreshBootstrap.conversation_id | HarnessSessionConfig.conversationId | conversationId | — |
| FreshBootstrap.instructions | HarnessSessionConfig.instructions | instructions | — |
| ToolMetadata.location | ToolDefinition.location | SANDBOX / ORCHESTRATOR / DAEMON | Determines where tool executes |

### Harness runId Usage

Each harness receives `turnId` from proto and passes it as `runId` to tool handlers:
- **Claude Agents**: `runId` parameter in `createToolContext()`, `runTurn()`, `handleToolResult()`
- **PI Agent**: `this.turnRef.runId = input.turnId` — stores turnId as runId on session ref
- **LangGraph**: `instanceId: input.turnId` — uses turnId as the LangGraph instance ID

### Data Flow: Turn Execution

```
User sends message
  → POST /api/agents/:id/message
    → Creates conversation (if new) + turn row in DB
    → SSE broadcast: TEXT_MESSAGE_* (runId = conversationId)
    → AgentSessionService.executeSession(turnId)
      → SandboxSessionManager.ensureSession(conversationId)
        → gRPC DeliverTurn(session_id, turn_id, messages[])
          → Sandbox converts: turnId → HarnessTurnInput.turnId
            → Harness executes with runId = turnId
              → Yields AgentEvent stream
            → Sandbox converts: AgentEvent → proto SessionEvent
          → Orchestrator receives SessionEvent stream
        → SessionTurnService converts: SessionEvent → AGUIEvent (runId = turnId)
      → AgentSessionService broadcasts AGUIEvent via SSE
      → EventBus emits: run.text_chunk, run.tool_started, etc. (turnId in payload)
        → SSEBroadcaster maps: turnId → AG-UI runId
```

## Section 4: The `runId` Contract

`runId` exists at 3 boundaries:
1. **AG-UI wire format** (SSE events to browser) — MUST be `runId`, protocol-mandated
2. **Proto/gRPC** (between orchestrator and sandbox) — Does NOT exist in proto. Injected by orchestrator into EmitEvent payloads.
3. **Harness internal** (inside sandbox containers) — Used as the tool execution context identifier. Set from proto `turn_id`.

**Rule**: Internal code NEVER uses `runId` as a variable name. Use `turnId`, `sessionId`, or `conversationId` as appropriate. The `runId` field name appears ONLY when constructing AG-UI wire events or reading them from SSE.
