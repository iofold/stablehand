# ADR 016: Raw Event Provenance on the Event Spine

**Date:** 2026-07-08
**Status:** Accepted
**Extends:** ADR 006 (Durable Event Persistence), ADR 015 (Canonical Event Log, plan reference)

## Context

The canonical event spine stores AG-UI frames in `event_store`. That is enough for
SSE replay, but it is lossy for non-SSE consumers: one typed bus event can project
to multiple frames, and run-channel frame types do not always reveal the original
bus event name or raw payload.

Durable trigger dispatch, suspended-session matching, and webhook enqueue need a
reconstructable raw event stream so they can replay missed events after an
orchestrator restart.

## Decision

`event_store` carries nullable raw provenance columns:

- `source_type TEXT`
- `source_payload TEXT`

For every `CanonicalLog.ingest(eventName, payload)` call, exactly one inserted
row has both fields set. When one bus event projects to multiple canonical
frames, the first frame carries the provenance. System/custom verbatim events
also carry the fields on their single row.

If a future known run-channel event has no projector mapping, the projector emits
a provenance-only system frame with type `stablehand.raw_event`, so the raw event is
still durable.

The raw stream is reconstructable with:

```sql
SELECT seq, source_type, source_payload
FROM event_store
WHERE source_type IS NOT NULL
ORDER BY seq;
```

No backfill is required. Durable consumers created after this ADR initialize
their cursor against the current spine.

## Retention Constraint

Future event retention must not delete rows with:

```sql
seq > (SELECT min(last_seq) FROM spine_cursors)
```

Once `spine_cursors` exists, retention must treat that minimum as the oldest
unconsumed boundary across durable spine consumers. If there are no cursors,
retention may use its normal age/size policy.

## Consequences

- The canonical frame `payload` remains wire-shaped; raw source data lives in
  columns beside it and does not alter SSE rendering.
- Durable consumers can filter on `source_type` and parse `source_payload`
  without maintaining reverse-projection maps.
- The table keeps one sequence space for both canonical replay and raw durable
  consumers, avoiding joins between separate raw/canonical tables.
