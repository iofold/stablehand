# ADR 024: Crash Takeover of Running Turns

**Date:** 2026-10-22
**Status:** Accepted
**Extends:** ADR 014 (single terminal-turn status writer), ADR 015 (canonical
event log), ADR 017 (at-least-once spine consumers), ADR 021 (durable turn
queue). Supersedes the "stranded turns are failed" rule of ADR 014's startup
reconciliation for turns whose sandbox is still running.

## Context

A running turn was owned by the orchestrator process holding the sandbox's
`DeliverTurn` stream. When that process died, the sandbox saw the stream drop
and aborted the turn; startup reconciliation then failed the turn with
restart copy. Queued turns already survived a restart (ADR 021) and turns
parked on a durable approval already resumed, but a turn that was simply
running was lost, together with the model spend behind it.

The sandbox container outlives the orchestrator (Docker containers and
Kubernetes Jobs keep running), so the work does not have to be lost. What was
missing was a way for the sandbox to keep going without its orchestrator, and
a way for the next orchestrator process to pick the turn back up without
duplicating or dropping anything in the durable event log.

## Decision

### 1. The sandbox keeps the turn running for a bounded window

- Every turn delivery writes its `SessionEvent`s to an in-memory **delivery
  journal**. Each event carries the journal id (`delivery_id`) and its 1-based
  position (`delivery_seq`).
- `DeliverTurn` is one consumer of that journal. Dropping the stream now only
  **detaches** the consumer. The harness keeps running.
- The **orphan grace window** (`STABLEHAND_TURN_ORPHAN_GRACE_MS`, default
  120 s, set on the orchestrator and passed to sandbox containers) starts when
  the consumer detaches or when the delivery capability expires without
  renewal. If no orchestrator re-attaches before it closes, the sandbox aborts
  the turn with explicit copy ("No orchestrator re-attached within 120s ...").
  `0` restores the old behaviour: a dropped stream cancels the turn.
- Callbacks to the orchestrator (orchestrator-side tools) retry while the
  orchestrator is unreachable, with backoff, for at most the window. A
  refusal for stale authority (the old owner's fence) waits until a successor
  installs a new capability, then retries with it. Every retry keeps the same
  request id.
- Since a dropped stream no longer cancels, cancellation is explicit: the new
  `CancelTurn` RPC, refused for a stale fence so a displaced owner cannot
  cancel the turn its successor adopted. The orchestrator sends it on user
  cancel and turn timeout, never on lease loss.
- A journal stays re-attachable for the grace window after the turn finishes,
  because an owner can die after reading the terminal frame but before
  finalizing the turn.

### 2. The next orchestrator re-adopts the turn

- **Lease takeover.** Turn-delivery lease owners are
  `<instance>/<boot>/<uuid>`. The instance id names a slot that runs one
  orchestrator process at a time: the container or pod hostname, or
  `STABLEHAND_INSTANCE_ID`. A booting process takes over any lease held by an
  earlier boot of its own instance at once, because that process is dead.
  Leases held by other instances are claimed only after they expire (at most
  one lease period, 60 s). Every claim bumps the fence token, so a displaced
  owner's database writes and sandbox callbacks are refused.
- **Re-attach.** Startup reconciliation hands each running turn with an
  ACTIVE sandbox session to `TurnTakeoverService`. It reconnects the session
  (startup adoption had deferred it because the dead owner's lease looked
  live) and runs `AgentTurnService` in takeover mode over the new
  `AttachTurn` RPC, which installs the successor's capability in the sandbox
  and replays the journal from the start.
- **Exactly-once effects on replay.** AgentTurnService ends each journaled
  event's processing with at most one fire-and-forget bus emit, and tags it
  with the event's `delivery: { id, seq }` in the source payload. Canonical
  frames persist in emission order, and every awaited message publication
  flushes the emits queued before it. The newest tagged frame for the turn is
  therefore a **watermark**: events at or before it have all their effects
  durable and only rebuild local state; later events are applied. Effects that
  can still be half-applied at the watermark boundary are idempotent:
  canonical messages are written by stable id, re-staging an identical
  assistant projection mints no revision, and message publication is
  watermark-guarded (`published_revision`).
- **Stream ids.** The projector's per-turn text state is rebuilt from the
  turn's durable frames before the first new frame, so an open
  `${turnId}-m${n}` message continues and the next one is `m${n+1}`.
  Reconnecting clients replay from `Last-Event-ID` (ADR 015) and see one
  ordered stream with no gap and no duplicate.
- **Fallback.** If the sandbox cannot be re-attached (session not ACTIVE,
  container gone or unreachable, no journal for the turn, grace window
  exceeded) the turn is closed with copy that names the cause, keeps the
  messages saved before the restart, and asks the user to retry; the sandbox
  is reset so nothing keeps executing the abandoned turn. Re-running the turn
  automatically from saved messages is deliberately not done here (see
  consequences).

## What survives an orchestrator kill

| Survives | Does not survive |
|---|---|
| Running turns whose sandbox stays up and is re-attached within the grace window | Turns whose sandbox container dies with or after the orchestrator |
| Model calls and sandbox-native tools (shell, files) in flight during the outage | A turn whose orchestrator stays down longer than the grace window |
| Orchestrator-side tool calls, retried with the same request id | Turns running on a sandbox image older than this ADR (no `AttachTurn`): they fail with restart copy as before |
| Every event the sandbox produced, in order, exactly once in the canonical log | In-memory approval promises (approvals stay on the durable resume path) |
| Open SSE clients, which reconnect with `Last-Event-ID` | |

## Consequences and caveats

- **At most one repeated model call.** Nothing is re-executed in the normal
  path: the sandbox never stopped. A model call can repeat only on the
  fallback path a future change may add (re-delivering from saved messages),
  which is why that path is not automatic today.
- **Tool side effects.** An orchestrator-side tool that was executing when
  the orchestrator died never recorded a result. Its dedup row is still
  `in_progress` under the old fence; the successor fence reclaims it and the
  tool runs again. Tools with external side effects can therefore run twice
  across a crash; tools that already completed return their recorded result.
  Sandbox-native tools are not affected: they ran once in the sandbox.
- **Daemon-side artifact callbacks** (`RegisterArtifact`, `ResolveArtifact`)
  do not retry yet; an artifact upload that coincides with the outage fails
  and the model sees the error.
- **Memory.** The journal holds one turn's events in sandbox memory until the
  grace window after the turn ends.
- **Upgrade.** Harness images must be rebuilt to get the journal and the new
  RPCs; the orchestrator works with old images (re-attach reports
  "unavailable" and the old failure path runs). The `tool_request_dedup`
  table gains a nullable `delivery_fence_token` column (additive).
- **Same-instance takeover assumes one process per instance id.** Two live
  processes sharing a hostname (for example host networking) lose liveness,
  not safety: each takeover bumps the fence and the displaced owner is
  refused everywhere.

Relevant code: `packages/sandbox-daemon/src/sandbox/turn-delivery-journal.ts`,
`packages/sandbox-daemon/src/sandbox/runner.ts` (`deliverTurn`, `attachTurn`,
`cancelTurn`), `packages/sandbox-daemon/src/sandbox/callback-window.ts`,
`packages/stablehand/src/orchestrator/turn-takeover.ts`,
`packages/stablehand/src/orchestrator/turn-reconciler.ts`,
`packages/stablehand/src/orchestrator/agent-turn-service.ts` (takeover mode),
`packages/stablehand/src/orchestrator/instance-identity.ts`.
