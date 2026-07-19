# ADR 004: Session Architecture Refactor

**Date:** 2026-03-31  
**Status:** Accepted  
**Amended:** 2026-04-07 (runtime-semantics refresh)

## Context

The system previously had three overlapping concepts all labeled "sessions," which led to confusion in the codebase and inconsistencies in the dashboard UI.

1.  **`conversations` table:** Durable chat threads that persist indefinitely.
2.  **`sessions` table + `SessionRegistry`:** Individual execution cycles (one per user message). This table had a full state machine that duplicated the container lifecycle.
3.  **`sandbox_sessions` table + `SandboxSessionManager`:** The lifecycle of the Docker container. These rows were hard-deleted when a session was killed, causing dashboard status counts to never sum to the total number of conversations.

This redundancy meant that two in-memory registries (`SessionRegistry` and `SandboxSessionManager`) tracked overlapping state for the same execution. The dashboard showed "sessions" from three different sources, each meaning something different.

## Decision

We decided to refactor the session architecture to unify the execution state and clarify the lifecycles of conversations, containers, and execution turns.

### 1. Keep `conversations` and `sandbox_sessions` as separate tables

We rejected merging these tables because their lifecycles are different. A conversation is the durable identity of a chat. A sandbox session represents a specific container instance. When a session restores from a checkpoint, it gets a new container (a new `sandbox_sessions` row), but the conversation persists. The relationship is 1:N over time.

### 2. Rename `sessions` table → `turns`

The `sessions` table actually tracked individual user-message to agent-response cycles. We renamed it to `turns` to reflect its role as a lightweight audit log. A turn is either in-flight (`completedAt` is null) or done.

### 3. Remove `SessionRegistry` entirely

`SessionRegistry` was a redundant in-memory mirror of the `sessions` (now `turns`) table. We moved its responsibilities to `SandboxSessionManager`:
*   **Abort control:** `AbortController` per in-flight turn is now stored on the `SessionRecord` in `SandboxSessionManager`.
*   **Concurrency limiting:** Max active sessions per agent is now checked against `sandbox_sessions`.
*   **Event emissions:** `turn.started` and `turn.completed` events are now emitted via the central `eventBus`.

### 4. Use checkpoint/restore for idle lifecycle; model HITL separately

The current runtime does not persist a pause-like sandbox session state.

*   **`CHECKPOINTED`:** The sandbox session runtime has been removed after checkpoint capture and can be restored later.
*   There is **no separate persisted pause-like or frozen state** in the current runtime.
*   Human-in-the-loop (HITL) approval is modeled through durable interrupt records plus `interrupt.requested` / `interrupt.resolved` events, not through a separate sandbox-session status.
*   The `freeze` / `unfreeze` endpoints were removed in Phase 0 dead-code cleanup.

### 5. Soft-delete sandbox sessions (`TERMINATED` state)

Instead of hard-deleting `sandbox_sessions` rows in `killSession()`, we now set their status to `TERMINATED`. This ensures that dashboard status dots sum correctly: `active + checkpointed + restoring + terminated = total`.

### 6. Rename events `session.started` → `turn.started` and `session.completed` → `turn.completed`

These events fire per turn (per user message), not per session. We renamed them to be more accurate. In the current runtime:

*   `turn.pending` is the pre-start UI/event-bus signal
*   `turn.started` and `turn.completed` are the canonical per-turn lifecycle events
*   `interrupt.requested` and `interrupt.resolved` cover HITL

This remains a clean break for webhook subscribers; no backward compatibility layer was added.

### 7. Status is session-level, not turn-level

A turn is an audit log entry and does not have its own state machine. The checkpoint, restore, and termination lifecycle applies to the container (the sandbox session), not the individual message-response cycle. HITL interrupt state is stored separately from sandbox-session status.

## Data Model

```text
[Conversation] 1 ─── N [Sandbox Session] 1 ─── N [Turn]
(Durable Chat)         (Docker Container)        (Audit Log)
```

## State Machine

```text
ACTIVE -> CHECKPOINTED -> RESTORING -> ACTIVE
CHECKPOINTED -> RESTORING -> ACTIVE
ACTIVE -> TERMINATED
CHECKPOINTED -> TERMINATED
```

## Event Mapping

| Old Event | New Event | Level |
| :--- | :--- | :--- |
| `n/a` | `turn.pending` | Turn (pre-start) |
| `session.started` | `turn.started` | Turn |
| `session.completed` | `turn.completed` | Turn |
| `n/a` | `interrupt.requested` / `interrupt.resolved` | Turn / HITL |

## Consequences

### Positive
*   **Clearer Ownership Target:** `SandboxSessionManager` is the primary request-path owner of execution state, while reconciliation logic continues to be cleaned up around it.
*   **UI Consistency:** Dashboard counts are now accurate and sum to the total number of conversations.
*   **Reduced Complexity:** Removing `SessionRegistry` eliminated redundant in-memory state tracking.
*   **Clearer Domain Model:** The distinction between a conversation, a container session, and an execution turn is now explicit.

### Negative / Tradeoffs
*   **Table Growth:** The `sandbox_sessions` table will grow without bound because of soft-deletion.
*   **Breaking Changes:** Renaming events breaks existing webhook integrations.
*   **Migration Complexity:** Renaming a core table and updating foreign keys required a careful database migration.

### Future Work
*   **Retention Policy:** Implement a background job to prune `TERMINATED` sandbox sessions and old `turns` after a certain period (e.g., 30 days).
*   **Checkpoint Cleanup:** Ensure checkpoints are cleaned up when a session is truly no longer needed, as soft-deletion prevents `ON DELETE CASCADE` from firing.

## Alternatives Considered

### Merging `conversations` and `sandbox_sessions`
We considered merging these into a single table, but rejected it because it would conflate the existence of a chat with the existence of a container. A conversation survives container death and resurrection, and a single conversation can be associated with multiple containers over its lifetime (e.g., after restoring from a checkpoint).

### Keeping `SessionRegistry`
We considered keeping `SessionRegistry` but slimming it down. However, it would still have been a redundant in-memory mirror of the database. Moving its logic into `SandboxSessionManager` was cleaner and reduced the number of moving parts in the orchestrator.
