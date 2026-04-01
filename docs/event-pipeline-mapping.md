# CTXMill Protocol Mapping Spec

> Authoritative reference for how AG-UI wire events and gRPC proto fields map to ctxmill internal abstractions.
> Updated: 2026-03-31 (post runId→sessionId/turnId migration)

## Core Entities

Table of the 4 key identifiers:
- `conversationId` — Persistent conversation. 1:1 with a conversation DB row. Used across sessions.
- `turnId` — Single request→response cycle within a session. Created per user message. This is what becomes `runId` on the AG-UI wire.
- `sessionId` — Sandbox container session. Persists across turns for the same conversation. Maps to `sandbox_sessions` DB table.
- `runId` (wire only) — AG-UI protocol field. NOT an internal entity. Exists only in SSE events sent to the browser. Populated from `turnId` (for run events) or `conversationId` (for user message events).

## Section 1: AG-UI Protocol Mapping

### Wire Format

The AG-UI protocol defines `runId` as a required field on all events. In ctxmill:

| AG-UI Event Type | Wire `runId` value | Source location |
|---|---|---|
| RUN_STARTED | turnId | SSEBroadcaster (from bus `turn.started`) or direct broadcast in routes |
| RUN_FINISHED | turnId | SSEBroadcaster (from bus `turn.completed`) |
| RUN_ERROR | turnId | AgentSessionService catch block |
| TEXT_MESSAGE_START | conversationId (user msg) or turnId (assistant) | Route handler (user), SSEBroadcaster (assistant) |
| TEXT_MESSAGE_CONTENT | turnId | SSEBroadcaster (from bus `run.text_chunk`) |
| TEXT_MESSAGE_END | conversationId (user msg) or turnId (assistant) | Route handler (user), SSEBroadcaster (assistant) |
| TOOL_CALL_START | turnId | SSEBroadcaster (from bus `run.tool_started`) |
| TOOL_CALL_ARGS | turnId | SSEBroadcaster (synthetic, emitted after TOOL_CALL_START) |
| TOOL_CALL_RESULT | turnId | SSEBroadcaster (from bus `run.tool_result`) |
| MESSAGE_COMMITTED | turnId | SessionTurnService |
| CUSTOM | varies (turnId, sessionId, or agentId) | Various direct broadcasts and EmitEvent RPC |

### SSE Broadcast Resolution

SSEBroadcaster resolves the wire `runId` with a fallback chain:
```
payload.turnId ?? payload.sessionId ?? payload.runId
```

### Emission Paths

1. **EventBus → SSEBroadcaster → SSE** — Most run events (text, tool, started, finished). SSEBroadcaster subscribes to internal events and re-emits as AG-UI.
2. **SessionTurnService → AGUIEvent yield** — `MESSAGE_COMMITTED` events are yielded directly from the turn service as AGUIEvents.
3. **AgentSessionService → direct SSE** — `RUN_ERROR` on unhandled exceptions during turn execution.
4. **Route handlers → direct SSE** — User message events (`TEXT_MESSAGE_*`) and session control (`CUSTOM` interrupt_resolved, run_cancelled).
5. **gRPC EmitEvent → EventBus → SSEBroadcaster** — Custom events emitted by sandbox harnesses via the `emit-event` tool.

## Section 2: Internal Event Bus Mapping

Table of all 18 event types from `packages/ctxmill/src/events/bus.ts`:

| Internal Event | Key Fields | AG-UI Mapping | Notes |
|---|---|---|---|
| turn.started | turnId, sessionId, agentId, conversationId, mode | RUN_STARTED | — |
| run.text_chunk | turnId, agentId, messageId, content | TEXT_MESSAGE_CONTENT | — |
| run.tool_started | turnId, agentId, toolCallId, toolName, args | TOOL_CALL_START + TOOL_CALL_ARGS | — |
| run.tool_result | turnId, agentId, toolCallId, toolName, result, durationMs | TOOL_CALL_RESULT | — |
| run.interrupted | turnId, agentId, toolCallId, toolName, args, interruptId | CUSTOM | — |
| run.interrupt_resolved | turnId, agentId, interruptId, action | CUSTOM | — |
| session.paused | sessionId, agentId, conversationId, reason | CUSTOM | Uses sessionId not turnId |
| turn.completed | turnId, sessionId, agentId, conversationId, status, durationMs | RUN_FINISHED | — |
| run.resumed | turnId, agentId, triggeredBy, suspendedDurationMs | Not mapped to AG-UI | — |
| feedback.received | feedbackId, turnId, agentId, type | Not mapped to AG-UI | — |
| trigger.fired | triggerId, agentId, eventType, turnId | Not mapped to AG-UI | — |
| learning.* (3 events) | varies | Not mapped to AG-UI | Internal only |
| agent.created/deleted | agentId | Not mapped to AG-UI | Internal only |
| client.connected/disconnected | agentId, clientId | Not mapped to AG-UI | Internal only |
| custom | type, agentId, payload | CUSTOM | Passthrough |

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
| RefreshSecrets | — | SecretsPayload | P2+ stub |
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
