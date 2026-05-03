# ADR 013: Restore Retry Policy and UI Surface

**Date:** 2026-05-01
**Status:** Accepted
**Extends:** ADR 005 (Customer Readiness Lifecycle Boundary)

## Context

ADR 005 defines the lifecycle transition matrix for sandbox sessions. The matrix has two distinct restore-failure outcomes:

- `RESTORING -> CHECKPOINTED` for retryable failures with a valid checkpoint.
- `RESTORING -> TERMINATED` for non-retryable failures or invalid/missing checkpoints.

It does not say *how often* the orchestrator should retry, *how long* it should wait between attempts, or *where* the failure should be surfaced. Without that, the UI either spins forever or the user has to escalate every transient blip.

## Decision

### Auto-retry budget

Each entry into `RESTORING` from `CHECKPOINTED` may be re-attempted automatically up to **3 times** when the underlying error is classified as retryable. After the third failed attempt the session lands in `CHECKPOINTED` with `last_restore_error` populated; retrying further is the user's choice (Track 4 owns the "Retry" button).

### Backoff schedule

Auto-retries use bounded exponential backoff: **5 s, 15 s, 45 s** before attempts 1, 2, and 3 of the retry loop, respectively. The first restore attempt is immediate; the schedule applies only to subsequent attempts in the same retry loop.

### Retryable vs non-retryable

Retryable errors are transient infrastructure faults that may resolve on their own:

- gRPC `Code.Unavailable`, `Code.DeadlineExceeded`, `Code.Internal`.
- Node socket errors: `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN`.
- Container-manager errors caused by a container that is briefly missing.

Non-retryable errors include anything indicating the checkpoint cannot be restored at all:

- `InvalidCheckpointError` (missing checkpoint, missing workspace, schema mismatch).
- gRPC `Code.InvalidArgument`, `Code.FailedPrecondition`, `Code.PermissionDenied`, `Code.Unauthenticated`.

Non-retryable errors bypass the retry loop and the session lands in `TERMINATED` on the first attempt with `last_restore_error` populated.

### Persistence

The `sandbox_sessions` table grows two columns:

- `restore_attempts INTEGER NOT NULL DEFAULT 0` — number of attempts in the current retry loop. Reset to 0 after a successful restore.
- `last_restore_error TEXT NULL` — short human-readable summary of the most recent failure. Cleared after a successful restore.

These columns are written through `SessionStatusCoordinator.transition({ extra })` so the lifecycle boundary stays the only owner of session-status mutation.

### Crash recovery

If the orchestrator crashes mid-retry, the `RESTORING` row is reconciled at startup. If `restore_attempts < 3`, the row is rolled back to `CHECKPOINTED` so the next user request triggers a fresh retry loop. If `restore_attempts >= 3`, the row stays in `CHECKPOINTED` with the existing `last_restore_error` so the UI can show the failure.

A row whose checkpoint is invalid or missing is moved straight to `TERMINATED` at startup with `last_restore_error` describing why.

### UI surface (Track 4)

The orchestrator exposes `restore_attempts` and `last_restore_error` on the session API payload. The UI shows them on `CHECKPOINTED` sessions so the user knows whether the auto-retry budget was exhausted and what the last error was. Manual user-driven retries reset `restore_attempts` to 0 before kicking off a new retry loop.

## Consequences

- Stage 2 owns the lifecycle wiring (`ctx-tn8`, `ctx-6nu`, `ctx-7fz`) plus the retry policy and persistence work described here.
- Stage 4 (UI) consumes the new fields. UI changes are out of scope for Stage 2.
- The retry classification is centralized in one module (`restore-retry-policy.ts`) so transient/non-retryable expansion does not leak across coordinator code.
- Tests must cover: 3-retries-success, 3-retries-fail-into-`CHECKPOINTED`, non-retryable-into-`TERMINATED`-on-first-try, and stranded-`RESTORING`-after-crash reconciliation.
