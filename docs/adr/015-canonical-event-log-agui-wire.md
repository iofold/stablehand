# ADR 015: Canonical Event Log as the Durable AG-UI Wire Spine

**Date:** 2026-07-10
**Status:** Accepted (backfilled 2026-07-10 — decision predates this record; wire transition complete)
**Extends:** ADR 006 (Durable Event Persistence)

## Context

The dashboard, external AG-UI clients, and durable consumers (trigger dispatch,
webhook enqueue) all need to observe an agent's run as an ordered event stream
that survives reconnects and orchestrator restarts. Internal `TypedEventBus`
events are neither wire-shaped (AG-UI) nor durable, and an in-memory SSE buffer
cannot replay past its cap or across a restart. We also needed to migrate the
SSE wire from its pre-canonical vocabulary to canonical AG-UI frames without
breaking the one external proxy still pinned to the old shape.

## Decision

A single durable **canonical event log** is the spine for both persistence and
the SSE wire.

- **Projector → canonical AG-UI vocabulary.** `CanonicalProjector`
  (`orchestrator/canonical/projector.ts`) maps internal bus events onto the
  canonical frame set — the 12 AG-UI spec event types plus `CUSTOM`
  (`canonical/frames.ts`); orchestrator-specific signals ride as
  `CUSTOM { name: 'stablehand.*' }`. One server-side instance synthesizes message
  boundaries exactly once with stable ids (`${turnId}-m${n}`) and detects
  `a2ui-render` blocks, so replay reproduces in-flight partials rather than
  minting new ids per connection.
- **Persist-then-fan-out with a global seq.** `CanonicalLog.ingest()`
  (`canonical/canonical-log.ts`) projects, batch-persists the frames in one
  round trip (each frame gets its own global `seq`), and only then fans out to
  in-process subscribers. No downstream consumer observes a frame that is not
  already durable, and `ingest()` resolves after the batch insert commits
  (ADR 006).
- **Durable replay via `Last-Event-ID`.** The `/:id/stream` route
  (`routes/agents/stream.ts`) opens with a snapshot of open turns plus a
  `CUSTOM name: stablehand.sandbox_session.snapshot` for each
  `ACTIVE`/`RESTORING` session, replays from the
  durable log when the client presents a seq-format `Last-Event-ID`, then tails
  the database from the same cursor. Replay is paginated through a fixed
  committed watermark. In-process broadcasts provide a low-latency wake, and a
  database watermark poll observes commits made by other orchestrator
  processes. Replay and handoff therefore work past any in-memory cap, across
  restarts, and across replicas.
- **Per-agent commit ordering.** Every canonical `event_store` writer locks the
  corresponding `agent_event_heads` row before allocating sequence values and
  advances its committed watermark in the same transaction. Same-agent batches
  cannot expose a higher committed cursor while a lower sequence is still
  uncommitted; different agents remain independent.

## Consequences

- SSE, trigger chaining, and webhook enqueue all read one ordered, durable
  stream; reconnect replay from a seq is exact.
- Conversation snapshots rewind before the earliest open turn's first run
  frame, then expand that cut to a fixed point over every turn interval that
  crosses it. They omit open-turn projections and every projection whose frame
  interval starts at or after the final cut. Interactive user prompts are
  omitted with their turn; background prompts remain projected because
  background turns intentionally publish no `user.message` frames. Snapshot
  hydration plus replay therefore reconstructs text and tool state exactly once
  in either direction of interleaved turn completion.
- Startup reconciliation republishes a missing interactive `user.message`
  triplet before redispatching a queued turn. This closes the crash window
  between creating the message/turn rows and the original canonical publish;
  durable provenance makes repeated recovery idempotent.
- Startup repair is cross-replica safe. A renewable
  `turn_reconciliation_leases` row elects one owner, and a live-lease
  authorization check fences redispatch immediately before side effects. The
  turn remains queued until the normal delivery boundary marks it running, so
  owner death after authorization is takeover-retryable. Lease loss or expiry
  aborts an in-flight session delivery. Pending/timed-out HITL interrupts and
  pending, in-progress, or failed durable resume attempts take precedence at
  both claim and authorization; the resume worker can therefore start in
  Fastify's `onReady` hook without racing general turn reconciliation.
- The migration that introduces `agent_event_heads` requires an atomic
  orchestrator rollout (stop old writers before starting the new binary).
  Mixed-version rolling operation is unsupported because an old writer does not
  advance the committed watermark.
- The canonical frame set is the contract for every AG-UI client; a new
  orchestrator signal must map to an existing type or a `stablehand.*` CUSTOM frame.
- The `?wire=legacy` transition mechanism this ADR originally staged — dual
  rendering, `WireMode` negotiation, and the `formatNativeLegacy` converter — was
  removed on 2026-07-10 (commit `baa2c7a`) once the last external proxy moved to
  the canonical default. Clients now always receive canonical frames.
- ADR 016 (Raw Event Provenance) extends this spine with nullable `source_type` /
  `source_payload` columns so non-SSE consumers can reconstruct the raw event
  stream without maintaining reverse-projection maps.
