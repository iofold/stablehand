# Event Spine Provenance Inventory

Current as of 2026-07-08. This inventory covers every `EventMap` name in
[bus.ts](../packages/stablehand/src/events/bus.ts).

For each `CanonicalLog.ingest(eventName, payload)` call, exactly one persisted
`event_store` row has `source_type = eventName` and `source_payload` set to the
JSON-serialized bus payload. Frame counts below describe canonical rows emitted
for a single bus event.

| EventMap name | Channel | Baseline projected frames | Notes |
|---|---:|---:|---|
| `turn.started` | `run` | 1 | `RUN_STARTED`. |
| `message.delta` | `run` | 2 | First chunk opens text: `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`; later chunks in the same open message emit 1 content frame. |
| `tool_call.started` | `run` | 2 | `TOOL_CALL_START`, `TOOL_CALL_ARGS`; emits an additional `TEXT_MESSAGE_END` if assistant text is open. |
| `tool_call.completed` | `run` | 2 | `TOOL_CALL_END`, `TOOL_CALL_RESULT`; successful `a2ui-render` results add one replayable `CUSTOM` frame. |
| `interrupt.requested` | `run` | 1 | `CUSTOM name: stablehand.interrupt.requested`. |
| `interrupt.resolved` | `run` | 1 | `CUSTOM name: stablehand.interrupt.resolved`. |
| `turn.completed` | `run` | 1 | `RUN_FINISHED`; error/cancelled turns also emit `RUN_ERROR`, and open text adds `TEXT_MESSAGE_END`. |
| `feedback.received` | `system` | 1 | Verbatim typed bus payload. |
| `agent.created` | `system` | 1 | Verbatim typed bus payload. |
| `agent.deleted` | `system` | 1 | Verbatim typed bus payload. |
| `client.connected` | `system` | 1 | Verbatim typed bus payload. |
| `client.disconnected` | `system` | 1 | Verbatim typed bus payload. |
| `trigger.fired` | `system` | 1 | Verbatim typed bus payload. |
| `message.committed` | `run` | 1 | `CUSTOM name: stablehand.message.committed`. |
| `turn.pending` | `run` | 1 | `CUSTOM name: stablehand.turn.pending`. |
| `ag_ui.event` | `run` | 1 | Passthrough AG-UI frame type from `payload.event.type`, defaulting to `CUSTOM`. |
| `user.message` | `run` | 3 | User echo triplet: start, content, end. |
| `custom` | `system` | 1 | Verbatim typed `custom` bus payload. User-defined custom event names outside `EventMap` persist as `custom` channel rows. |

Fallback rule: a future known run-channel event that has no projector case emits
one system frame of type `stablehand.raw_event` so `source_type/source_payload`
remain durable.
