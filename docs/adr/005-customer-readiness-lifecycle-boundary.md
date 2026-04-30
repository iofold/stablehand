# ADR 005: Customer Readiness Lifecycle Boundary

**Date:** 2026-04-30  
**Status:** Accepted

## Context

The customer-readiness plan tracks non-security issues only. The included set is `ctx-zl8`, `ctx-nh2`, `ctx-tn8`, `ctx-660`, `ctx-6nu`, `ctx-7fz`, `ctx-yci`, reliability-only `ctx-bfj`, `ctx-h99`, `ctx-wrx`, `ctx-bfi`, `ctx-u4p`, `ctx-ssm`, `ctx-0j2`, `ctx-x6b`, `ctx-gg6`, `ctx-kga`, `ctx-1s5`, and `ctx-0zk`. Explicitly security-tagged work and credential/secret remediation beyond functional HTTP-tool config validation remain excluded.

## Decision

Sandbox session lifecycle transitions are owned by a single service boundary centered on `SessionLifecycleService` plus the existing status coordinator/status machine. Route handlers and compatibility endpoints must delegate to that boundary rather than directly mutating persisted sandbox status.

## Transition Matrix

| From | Event / operation | To | Notes |
| --- | --- | --- | --- |
| `ACTIVE` | safe idle pause | `PAUSED` | Idle container pause only. |
| `ACTIVE` | checkpoint/suspend accepted at safe point | `CHECKPOINTED` | Checkpoint must be valid before status changes. |
| `ACTIVE` | terminate | `TERMINATED` | Terminal. |
| `PAUSED` | resume | `ACTIVE` | Compatibility path for legacy paused sessions. |
| `PAUSED` | checkpoint current paused state | `CHECKPOINTED` | Valid checkpoint required. |
| `PAUSED` | terminate | `TERMINATED` | Terminal. |
| `CHECKPOINTED` | start restore | `RESTORING` | Restore lease/failure metadata should be persisted where available. |
| `CHECKPOINTED` | terminate | `TERMINATED` | Terminal. |
| `RESTORING` | restore succeeds | `ACTIVE` | New/reattached runtime is usable. |
| `RESTORING` | retryable restore failure with valid checkpoint | `CHECKPOINTED` | User can retry. |
| `RESTORING` | nonretryable failure or invalid/missing checkpoint | `TERMINATED` | Failure metadata should explain why. |
| `TERMINATED` | any runtime transition | rejected | Terminal state. |

## Consequences

- Stage 2 owns `ctx-tn8`, `ctx-6nu`, and `ctx-7fz`.
- Stage 2 tests must be generated from the matrix above.
- Direct route-level state mutation is a regression unless it is a thin call into the boundary.
