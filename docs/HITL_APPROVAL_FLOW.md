# HITL Approval Flow

This document describes the current human-in-the-loop approval path in Stablehand. It reflects the durable interrupt model in the orchestrator and the AG-UI stream exposed to the dashboard.

## Core Ownership

- `packages/stablehand/src/orchestrator/grpc/orchestrator-service.ts`
  Registers the built-in `request-approval` tool and delegates pending approvals to `InterruptManager`.
- `packages/stablehand/src/orchestrator/interrupt.ts`
  Owns pending interrupt tracking, persistence, timeout handling, and the `interrupt.requested` / `interrupt.resolved` bus events.
- `packages/stablehand/src/orchestrator/routes/agents/interrupts.ts`
  Accepts human approval or rejection, resolves the interrupt durably, and resumes the session when needed.
- `packages/stablehand/src/orchestrator/sandbox-session-manager.ts`
  Restores or reconnects the sandbox session and delivers the continuation turn after approval is resolved.
- `packages/stablehand/src/orchestrator/session-manager/interrupt-resume-service.ts`
  Owns durable resume attempts when the original in-memory interrupt waiter is gone.
- `packages/stablehand/src/orchestrator/canonical/projector.ts`
  Maps internal interrupt events onto canonical AG-UI frames for the dashboard.

## Runtime Flow

1. A tool path reaches the built-in `request-approval` tool in the orchestrator gRPC service.
2. `OrchestratorService` calls `interruptManager.waitForApproval(...)` with the current turn ID, agent ID, tool call ID, tool args, and sandbox session ID when available.
3. `InterruptManager` stores the pending interrupt in memory, persists it to the database when configured, and emits `interrupt.requested`.
4. `CanonicalProjector` maps `interrupt.requested` to `CUSTOM name: stablehand.interrupt.requested` on the canonical wire, which is the only wire the projector emits.
5. The human resolves the interrupt through the agent interrupt route.
6. The route writes the resolution to the database first, then attempts the in-memory fast path via `interrupts.resolve(...)`.
7. If the session is still live, the in-memory interrupt resolves immediately and the original tool path continues.
8. If the session had already been checkpointed or the original owner disappeared, the route creates/updates a durable resume attempt so the session manager can restore the session and inject continuation messages representing the approval result.

## Timeout And Durability

- The default HITL wait timeout is 5 minutes.
- On timeout, `InterruptManager` resolves the interrupt as `suspend` and invokes its timeout callback for cooperative session suspension/checkpointing.
- Pending interrupts are reloaded from the database on orchestrator startup.
- Resolved interrupts can be replayed into a restored session through durable interrupt resume attempts.

## Event Mapping

Internal bus events:

- `interrupt.requested`
- `interrupt.resolved`

AG-UI stream behavior:

- Canonical wire (the only wire): `interrupt.requested` becomes `CUSTOM name: stablehand.interrupt.requested`; `interrupt.resolved` becomes `CUSTOM name: stablehand.interrupt.resolved`.

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

- Inbox-style consumers should poll `GET /api/interrupts` for durable cross-agent discovery and subscribe to `interrupt.requested` / `interrupt.resolved` webhooks for prompt updates. The list reads only persisted rows, defaults to actionable records, and never merges transient in-memory state.
- The resumption path is DB-first. A human resolution can succeed even if the original in-memory interrupt owner is gone, as long as the interrupt record and sandbox session can be recovered.
- Live waiter resolutions complete synchronously; durable resume work can return `202 Accepted` and continue through `interrupt_resume_attempts`.
- Both `approve` and `reject` can resume a checkpointed session. Timed-out rows remain actionable if a human later resolves the interrupt.
