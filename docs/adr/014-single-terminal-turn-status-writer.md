# ADR 014: Single Terminal-Turn Status Writer

**Date:** 2026-07-10
**Status:** Accepted (backfilled 2026-07-10 — decision predates this record)
**Extends:** ADR 005 (Customer Readiness Lifecycle Boundary)

## Context

A turn is the unit of agent execution that the UI, webhooks, and the durable
event spine observe. Many code paths can end a turn:

- live completion when the sandbox stream finishes,
- startup reconciliation of turns stranded by an orchestrator restart,
- turn-startup failures before the sandbox is ever reached,
- explicit cancellation.

When more than one of these can write the terminal row — or when they race each
other — a turn could flip status after it was already terminal, emit
`turn.completed` twice, or record a false success over an earlier failure. The
webhook contract also froze the terminal status vocabulary to
`completed | error | cancelled`, so an ad-hoc writer emitting anything else would
break downstream consumers.

## Decision

`TurnFinalizer.finalize()` is the single writer of terminal turn state
(`packages/stablehand/src/orchestrator/turn-finalizer.ts`). Every path that ends a
turn calls it; no other code writes a turn's terminal status directly.

- **Idempotence is enforced at the database.** `finalize()` delegates to
  `DatabaseRepository.finalizeTurnIfOpen()`, which transitions only a turn that
  is still open. A finalizer that loses the race sees `finalized: false`, logs
  an "already terminal; skipping" line, and does not emit — so a second finalize
  can neither overwrite the first outcome nor double-signal `turn.completed`.
- **The completion signal fires only when this call finalized the turn.** The
  live path passes `emitCompletion`, routing the signal through
  `SandboxSessionManager.completeTurn` (which also drains queues and schedules
  idle timeouts); other paths emit `turn.completed` on the bus directly. A
  throwing completion signal is caught and logged — the turn stays finalized.
- **Status vocabulary is frozen.** `deriveTurnStatus()` maps every outcome to
  exactly `completed | error | cancelled`, keeping the webhook contract stable.

Startup reconciliation (`orchestrator/turn-reconciler.ts`) builds on the same
primitive to close turns stranded by a restart, using cause-accurate error copy.

## Consequences

- Turn-terminal writes have one owner, so terminal races resolve to a single
  outcome with a single `turn.completed` emission.
- Callers must route cancellation, failure, and completion through `finalize()`;
  direct terminal writes to the turn row are disallowed (see the guard comment in
  `orchestrator/agent-session-service.ts`).
- The turn-level rule mirrors the session-level rule in ADR 020 (single session
  status writer); together they keep lifecycle mutation centralized.
- Tests cover the terminal write + emit, already-terminal skip (idempotence),
  `emitCompletion` routing, a throwing signal leaving the turn finalized, and the
  frozen status vocabulary (`__tests__/turn-finalizer.test.ts`), plus
  stranded-turn reconciliation (`__tests__/turn-reconciler.test.ts`).
