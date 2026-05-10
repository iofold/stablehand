# HITL Approval Flow

This document describes the current human-in-the-loop approval path in CTXMill. It reflects the durable interrupt model in the orchestrator and the AG-UI stream exposed to the dashboard.

## Core Ownership

- `packages/ctxmill/src/orchestrator/grpc/orchestrator-service.ts`
  Registers the built-in `request-approval` tool and delegates pending approvals to `InterruptManager`.
- `packages/ctxmill/src/orchestrator/interrupt.ts`
  Owns pending interrupt tracking, persistence, timeout handling, and the `run.interrupted` / `run.interrupt_resolved` bus events.
- `packages/ctxmill/src/orchestrator/routes/agents.ts`
  Accepts human approval or rejection, resolves the interrupt durably, and resumes the session when needed.
- `packages/ctxmill/src/orchestrator/sandbox-session-manager.ts`
  Restores or reconnects the sandbox session and delivers the continuation turn after approval is resolved.
- `packages/ctxmill/src/orchestrator/sse-broadcaster.ts`
  Maps internal interrupt events onto AG-UI SSE frames for the dashboard.

## Runtime Flow

1. A tool path reaches the built-in `request-approval` tool in the orchestrator gRPC service.
2. `OrchestratorService` calls `interruptManager.waitForApproval(...)` with the current turn ID, agent ID, tool call ID, tool args, and sandbox session ID when available.
3. `InterruptManager` stores the pending interrupt in memory, persists it to the database when configured, and emits `run.interrupted`.
4. `SSEBroadcaster` maps `run.interrupted` to the AG-UI `HITL_PAUSE` event so the dashboard can render the approval UI.
5. The human resolves the interrupt through the agent interrupt route.
6. The route writes the resolution to the database first, then attempts the in-memory fast path via `interrupts.resolve(...)`.
7. If the session is still live, the in-memory interrupt resolves immediately and the original tool path continues.
8. If the session had already been checkpointed, the route calls `resumeWithInterruptResolution(...)` so the session manager can restore the session and inject continuation messages representing the approval result.

## Timeout And Durability

- The default HITL wait timeout is 5 minutes.
- On timeout, `InterruptManager` resolves the interrupt as `suspend` and invokes its timeout callback for cooperative session suspension/checkpointing.
- Pending interrupts are reloaded from the database on orchestrator startup.
- Resolved interrupts can be replayed into a restored session through `resumeWithInterruptResolution(...)`.

## Event Mapping

Internal bus events:

- `run.interrupted`
- `run.interrupt_resolved`

AG-UI stream behavior:

- `run.interrupted` becomes `HITL_PAUSE`
- `run.interrupt_resolved` is emitted as `CUSTOM`

HITL state is driven by durable interrupt records. Dedicated session pause APIs and the old session-paused event are no longer supported runtime surfaces.

## Resolution Outcomes

- `approve`
  The tool call proceeds.
- `reject`
  The tool call receives a rejected result and the run continues with that outcome.
- `suspend`
  The session is checkpointed while waiting for a later human decision.
- `timeout`
  Used when the interrupt deadline expires and the system records a timeout resolution.

## Operational Notes

- The resumption path is DB-first. A human resolution can succeed even if the original in-memory interrupt owner is gone, as long as the interrupt record and sandbox session can be recovered.
