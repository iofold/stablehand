# ADR 021: Durable Turn Queue with a Leased Dispatcher

Date: 2026-08-14 (decision shipped 2026-08-12, ctx-z5k0)
Status: Accepted

## Context

Turn admission used to launch directly: a burst beyond container capacity
either failed the request or parked work in in-process state that died with
the orchestrator. There was no bounded, durable answer to "what happens when
more turns arrive than the sandbox pool can run", and boot-time reconciliation
had to treat queued work as recovery debt behind a startup barrier.

## Decision

1. **The queue is rows.** Accepted turns persist as `turns.status='queued'`;
   there is no in-process waiter list anywhere. Restart loses nothing.
2. **Admission rejects before any write.** Global and per-agent queued-turn
   caps are checked before the user message or turn row is created. Overflow
   returns a typed `429 queue_full` (scope, depth, limit, `Retry-After`);
   `503 dispatch_stalled` fires only when work is queued and the dispatcher
   has not completed a recent pass. A rejected request leaves nothing
   half-accepted — the caller owns the retry.
3. **A single-flight dispatcher loop** (1s poll, kick-coalescing from enqueue
   paths) claims candidates through the existing turn delivery lease
   (monotonic fence, DB clock) plus a per-agent concurrency reservation. The
   lease stays the *authoritative* claim: a stale candidate simply fails its
   claim and is skipped, so the loop takes no row locks.
4. **Temperature is a claim-time predicate, never stored.** A candidate whose
   conversation has an ACTIVE sandbox session dispatches on the warm lane
   regardless of container slots; everything else requires slot headroom.
5. **Fairness** is oldest-turn-of-least-recently-served-agent with
   per-conversation head-of-line ordering, plus a short re-dispatch cooldown
   for launched-but-not-yet-activated turns.
6. **Honest expiry.** Queued turns older than `queuedTurnTimeoutMs` finalize
   as `turn.failed reason=queue_expired` instead of waiting forever.
7. **No boot barrier.** Queued rows are dispatcher work, not boot debt; the
   dispatcher drains any pre-restart backlog in the background after listen,
   claiming the lease and republishing delivery context idempotently.

## Interaction with prior ADRs

ADR 014 (single terminal-turn status writer) and ADR 020 (DB-verified session
status transitions) are preserved: the dispatcher never writes turn status
directly — it launches through the same startup service, and finalization
still flows through the turn finalizer. The admission-time concurrency
reservation must be released on dispatcher handoff (the dispatcher takes its
own at claim time); holding both leaks one unit per admitted turn and starves
the agent at `maxConcurrentSessionsPerAgent` (found live during endurance
certification, fixed in 75adc069).

## Consequences

- Overflow behavior is a typed, documented API contract instead of an
  accident (see docs/api-reference.md, "Queue rejections").
- The durable queue never forgets: anything admitted *will* execute, including
  test debris — operational hygiene (quiescing between benchmark runs) became
  part of the perf-run discipline.
- Certified under load: the ten-wave dev2 endurance run
  (docs/verification/2026-08-13-dev2-endurance-certification.md, 2,430 turns,
  0 failures) is the first live-fire certification of this path.
- Follow-ups tracked: demand-driven idle reclaim when queued turns wait on
  idle-held slots (ctx-v78a); concurrent-admission cap overshoot by in-flight
  requests (ctx-xrrc).

Relevant code: `packages/stablehand/src/orchestrator/turn-queue-admission.ts`,
`packages/stablehand/src/orchestrator/turn-dispatcher.ts`,
`packages/stablehand/src/orchestrator/turn-startup-service.ts`.
