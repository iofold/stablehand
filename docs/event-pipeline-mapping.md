# CTXMill Event Pipeline Mapping

> Current reference as of 2026-07-06. This document describes the shipped
> canonical event spine. Historical plans and audits may still mention the
> deleted `SSEBroadcaster`, `AGUIEventNormalizer`, or
> `CTXMILL_CANONICAL_EVENTS` flag; those are no longer runtime surfaces.

## Core Identifiers

| Identifier | Meaning |
|---|---|
| `conversationId` | Persistent conversation/thread row. |
| `turnId` | One user request and agent response cycle. This becomes AG-UI `runId` for run-scoped frames. |
| `sessionId` | Sandbox session/container lifecycle identity in `sandbox_sessions`. |
| `seq` | Global durable `event_store.seq`; SSE ids are zero-padded with `formatSeqId(seq)`. |
| `runId` | AG-UI wire field only. Internal code should prefer `turnId`, `conversationId`, or `sessionId`. |

## Runtime Pipeline

```text
TypedEventBus event
  -> CanonicalProjector.project(...)
  -> CanonicalLog.saveEventBatch(...)
  -> event_store rows with seq/type/channel/payload/turnId/conversationId/source_type/source_payload
  -> CanonicalLog fan-out
  -> SSEManager.broadcastFrame(...)
  -> GET /api/agents/:id/stream
```

The persistence-before-fan-out rule matters: live SSE clients should not observe
a canonical run frame that cannot be replayed from `event_store`.

Source code:

- [bus.ts](/path/to/stablehand/packages/ctxmill/src/events/bus.ts)
- [projector.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/canonical/projector.ts)
- [canonical-log.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/canonical/canonical-log.ts)
- [sse.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/sse.ts)
- [stream.ts](/path/to/stablehand/packages/ctxmill/src/orchestrator/routes/agents/stream.ts)

## Channels

| Channel | Source | Persistence and consumers |
|---|---|---|
| `run` | Run lifecycle, text, tool, HITL, message commit, passthrough AG-UI events | Projected into AG-UI frames and used by SSE replay. |
| `custom` | Agent/user custom events such as `emit-event` output | Persisted with type/payload unchanged; triggers and `/api/events` consume this vocabulary directly. |
| `system` | Non-run operational events | Persisted for diagnostics and event APIs. |

## Raw Provenance

Every bus event ingested by `CanonicalLog` leaves exactly one source-bearing row
in `event_store`: `source_type` is the original bus event name and
`source_payload` is the JSON-serialized bus payload. When a bus event fans out to
multiple canonical frames, the first frame carries the provenance; the remaining
frames have null provenance. Verbatim system/custom events are single-row events
and carry provenance on that row.

The raw durable stream for future trigger, matcher, and webhook consumers is:

```sql
SELECT seq, source_type, source_payload
FROM event_store
WHERE source_type IS NOT NULL
ORDER BY seq;
```

See [docs/event-spine-provenance-inventory.md](/path/to/stablehand/docs/event-spine-provenance-inventory.md)
and [ADR 016](/path/to/stablehand/docs/adr/016-raw-event-provenance-on-event-spine.md).

## Run-Channel Projection

| Internal event | Canonical frame(s) | Notes |
|---|---|---|
| `turn.pending` | `CUSTOM name: ctxmill.turn.pending` | Pre-start queued/accepted signal. |
| `turn.started` | `RUN_STARTED` | `runId = turnId`, `threadId = conversationId`. |
| `user.message` | `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END` | User echo uses `runId = conversationId` because it is conversation-scoped. |
| `run.text_chunk` | `TEXT_MESSAGE_START` if needed, then `TEXT_MESSAGE_CONTENT` | Assistant message ids are stable server-side ids: `${turnId}-m${n}`. |
| `run.tool_started` | `TOOL_CALL_START`, `TOOL_CALL_ARGS` | Closes an open assistant text message before the tool call. |
| `run.tool_result` | `TOOL_CALL_END`, `TOOL_CALL_RESULT`, optional `CUSTOM name: ctxmill.a2ui.render` | A2UI blocks are detected from `a2ui-render` tool results and become replayable. |
| `run.interrupted` | `CUSTOM name: ctxmill.hitl.requested` | HITL pause signal on the canonical wire. |
| `run.interrupt_resolved` | `CUSTOM name: ctxmill.hitl.resolved` | Resolution marker. |
| `message.committed` | `CUSTOM name: ctxmill.message.committed` | Durable message commit signal. |
| `turn.completed` | Optional `RUN_ERROR`, then `RUN_FINISHED` | Error/cancelled turns emit AG-UI `RUN_ERROR.message`, then terminal finish. |
| `run.ag_ui_event` | Passthrough frame type | Used for harness frames not otherwise normalized. |

## SSE Stream Behavior

`GET /api/agents/:id/stream` writes:

1. A `CONNECTED` bootstrap frame with `latestSeq`.
2. `CUSTOM subtype: state_snapshot` frames for live/restoring sandbox sessions.
3. Durable replay frames when `Last-Event-ID` parses as a seq id.
4. Live frames through `SSEManager.subscribeDurable(...)`.

Bootstrap frames are direct route writes, not persisted run frames.

SSE ids use a zero-padded global seq:

```text
id: 000000000042
data: {"type":"RUN_STARTED","runId":"turn_123","threadId":"conv_123"}
```

Unknown or legacy-format `Last-Event-ID` values are treated as a fresh connect.
Replay is served from `event_store`, not volatile in-memory history. The current
single replay query uses the repository default frame limit; very large reconnect
windows should be paged if they become a product requirement. A small per-agent
ring buffer only closes the replay-to-live attach race.

The canonical AG-UI vocabulary is the only wire. The pre-canonical
`?wire=legacy` rendering was removed (W6c, 2026-07-10).

## gRPC Proto Mapping

**HarnessService** (orchestrator to sandbox):

| RPC | Purpose | Important fields |
|---|---|---|
| `OpenSession` | Initialize fresh or restored harness session. | `session_id`, `agent_id`, `conversation_id`, bootstrap payload. |
| `DeliverTurn` | Deliver user/tool continuation messages to a session. | `session_id`, `turn_id`, `messages`, `tools`. |
| `SuspendSession` | Export harness/runner checkpoint state. | `session_id`, `reason`. Workspace capture happens in the orchestrator after this RPC. |
| `KillSession` | Stop a sandbox session. | `session_id`, `reason`. |

**OrchestratorService** (sandbox to orchestrator):

| RPC | Purpose | Notes |
|---|---|---|
| `RequestTool` | Execute orchestrator-location tools. | Sandbox callback auth is session-scoped HMAC. |
| `EmitEvent` | Emit custom events from the sandbox. | Payload is persisted/triggered as custom event data. |
| `RegisterArtifact` | Register uploaded artifact metadata. | Daemon tools upload bytes near the sandbox. |
| `ResolveArtifact` | Resolve artifact metadata/download info. | Used by daemon-side artifact tools. |

Proto definitions live in
[sandbox.proto](/path/to/stablehand/packages/proto/ctxmill/sandbox/v1/sandbox.proto);
conversion lives in
[proto-convert.ts](/path/to/stablehand/packages/sandbox-daemon/src/sandbox/proto-convert.ts).

## Gotchas

- `runId` is a wire/API term. Do not introduce internal `runId` state when the value is actually a `turnId`.
- `/api/events` is an operational event log over `event_store`; custom events retain their original type strings.
- The deleted scheduled-event queue is not the active run dispatch path; durable event work should build on `event_store`.
- The canonical stream is durable, but trigger dispatch cursoring is still tracked separately in beads.
