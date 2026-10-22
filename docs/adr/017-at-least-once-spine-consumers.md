# ADR 017: At-Least-Once Spine Consumers

**Date:** 2026-07-08
**Status:** Accepted
**Extends:** ADR 006 (Durable Event Persistence), ADR 016 (Raw Event Provenance)

## Context

ADR 016 makes the original bus event stream reconstructable from `event_store`.
SSE already replays from the canonical spine, but non-SSE business consumers
used to subscribe directly to the in-process bus. Direct listeners are
at-most-once: a process restart after persistence but before listener execution
can lose trigger firings, suspended-session resumes, or webhook enqueue work.

## Decision

Non-SSE durable business consumers read source-bearing `event_store` rows through
`SpineConsumerRunner`.

Each consumer has:

- a stable `name`;
- a `wants(sourceType)` filter;
- a `handle(rawEvent)` effect;
- one `spine_cursors` row storing the highest ordered catch-up `seq` completed.

The runner has two delivery paths:

- live fan-out from `CanonicalLog.subscribe` for low latency;
- ordered catch-up on boot and periodic rescan for durability.

Live delivery never advances cursors. Ordered catch-up advances a consumer cursor
only after that consumer's handler resolves for the row. If a handler throws, the
cursor stays behind the event and a future rescan retries it.

Consumer effects must be idempotent by event sequence. Trigger dispatch uses
`trigger_firings UNIQUE(trigger_id, event_seq)` plus deterministic triggered turn
IDs. Suspended-session matching keeps the wait row until resume succeeds and
throws on retryable resume failures so the cursor does not advance.

## Enforcement

- `EventTriggerManager` and `SuspendedSessionMatcher` do not subscribe directly
  to `TypedEventBus`; production delivery is through `SpineConsumerRunner`.
- Focused tests cover live delivery without cursor advancement, downtime
  catch-up with cursor advancement, and retryable matcher failures keeping the
  cursor behind the event.
- Future retention must honor ADR 016's `min(spine_cursors.last_seq)` boundary.

## Consequences

- Delivery is at-least-once, not exactly-once. Duplicate live/rescan/restart
  delivery is expected and must converge through idempotent consumer effects.
- A single-instance orchestrator can use simple per-consumer cursors. If the
  orchestrator becomes multi-instance, this ADR should be extended with
  claim/lease or `FOR UPDATE SKIP LOCKED` semantics.
- New business consumers should use the runner instead of adding bus listeners
  or separate polling tables.

## Amendment: bounded retries and dead letters (2026-10-22, ctx-v6ef)

Holding the cursor on every failure made one poison event block a consumer's
catch-up forever: a trigger whose target refused background runs
(`agent_mode_not_allowed`) was retried every 30 s indefinitely, and every event
behind it waited.

- **Consumers settle non-retryable failures themselves.** The trigger consumer
  classifies each fire error. Errors that retrying cannot fix (target mode,
  budget or tag policy, missing or misconfigured agent, invalid input) are
  written at once as a `trigger_firings` row with `status = 'failed'`,
  `error_code`, `error` and `attempts`, a `trigger.failed` event is published,
  and `handle` resolves. The row settles `(trigger_id, event_seq)` just like a
  successful firing, so replays skip it.
- **The runner bounds retryable failures.** A failed catch-up delivery holds
  the cursor and is retried with exponential backoff (5 s doubling to a 5 min
  cap) instead of on every rescan. After 8 deliveries (about ten minutes) the
  runner calls the consumer's optional `deadLetter(event, error, attempts)`;
  once that resolves, the cursor moves past the event. If the dead letter
  cannot be written, the cursor still holds. Retry state is in memory, so a
  restart grants a fresh attempt budget.
- **Consumers without a `deadLetter` hook never skip.** They keep the
  original hold-and-retry semantics, now with capped backoff. The webhook
  relay is one: its failures are database faults, and it must not drop
  deliveries.
- **Failures are visible.** `GET /api/triggers/failures` lists dead-lettered
  firings (newest first, filterable by trigger or agent), and the Triggers page
  shows them on each trigger card. A dead-lettered firing is not replayed
  automatically; fix the cause and re-emit the event if the run is still
  wanted.
