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
