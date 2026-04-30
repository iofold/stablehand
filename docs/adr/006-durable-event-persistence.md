# ADR 006: Durable Event Persistence and Listener Dispatch

**Date:** 2026-04-30  
**Status:** Accepted

## Context

Durable event listeners and trigger chaining can currently observe events whose persistence fails. This weakens replay, audit, and downstream trigger semantics for `ctx-660`.

## Decision

Durable events use persist-then-post-commit-dispatch semantics. Listener dispatch starts only after the repository/service boundary reports successful durable persistence. Listener failures do not retroactively mark persistence failed.

If the current repository boundary cannot express post-persist dispatch cleanly, the implementation may introduce a transactional outbox. Direct durable emit paths that bypass persistence are forbidden.

## Consequences

- Stage 3 owns `ctx-660` and waits for the accepted lifecycle boundary.
- Required tests: persistence failure prevents listener dispatch, persistence success dispatches once, listener failure does not undo persistence, trigger chaining only sees persisted events, and startup/event cleanup still passes after Stage 2.
