# ADR 020: Single Session Status Writer with DB-Verified Transitions

**Date:** 2026-07-08
**Status:** Accepted

## Context

Session status is observed by turn delivery, recovery, lifecycle reconciliation,
interrupt resume, and API readback. Multiple coordinator instances and
unguarded writes can make the in-memory mirror disagree with the database or let
a stale path overwrite a fresher lifecycle transition.

## Decision

Production creates one `SessionStatusCoordinator` in `container.ts` and injects
it into lifecycle and session-manager services.

All sandbox-session status transitions go through the coordinator. The
coordinator verifies transitions with a database compare-and-set:

```sql
UPDATE sandbox_sessions
SET status = $to, ...
WHERE id = $id AND status = $expected_from
RETURNING *
```

If the row is no longer in the expected status, the coordinator raises
`StaleTransitionError` and does not update the in-memory mirror.

## Enforcement

- Production has exactly one `new SessionStatusCoordinator(...)` call.
- `DatabaseRepository.updateSandboxSessionStatus` is called by
  `SessionStatusCoordinator` for production status changes.
- Coordinator tests cover successful transitions, stale transition rejection,
  and mirror update only after a successful DB write.
- Lifecycle/recovery tests assert reconciler transitions use expected statuses.

## Consequences

- Race resolution is explicit: stale writers fail instead of silently
  clobbering newer lifecycle state.
- The in-memory `SessionStateStore` remains a cache/turn-queue helper; status
  truth is the database row updated through the coordinator.
- Future status-changing code must accept a fresh row and call
  `SessionStatusCoordinator.transition(...)` rather than writing the repository
  directly.
