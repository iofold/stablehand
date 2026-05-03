# ADR 012: Stress Event Determinism Contract

**Date:** 2026-05-01
**Status:** Accepted

## Context

`tests/e2e/stress-smoke.spec.ts` currently treats `stress.<harness>.complete` events as optional — missing emissions emit a `console.warn` and the test still passes. `ctx-kga` requires deterministic stress emission so green smoke means the harness reached its terminal contract.

## Decision

### Emission semantics
**Required.** Missing `stress.<harness>.complete` for a required-matrix run is a test FAIL. Console-warn-and-pass is removed.

### Delivery semantics
**Exactly-once observed.** Tests dedup on `(sessionId, eventType)` and assert exactly one match per session. The orchestrator's existing `tool_request_dedup` table is the model; stress events get the same dedup discipline at the listener boundary.

### Schema versioning
**Versioned.** `payload.schemaVersion: number` is required on every emitted stress event. Tests assert `payload.schemaVersion >= 1`. Additive payload fields are allowed without version bump; removed/renamed fields require a bump and a migration window.

### Required payload shape (v1)
```ts
{
  schemaVersion: 1,
  status: 'ok' | 'error',
  harness: 'langgraph' | 'pi-agent' | 'claude-agents' | string,
  model?: string,
  durationMs?: number,
  // additional harness-specific fields allowed
}
```

## Consequences

- Affected files:
  - `tests/e2e/stress-smoke.spec.ts` (remove console.warn fallbacks; assert dedup + schemaVersion).
  - Sandbox harness emit-event tool wrappers in `packages/sandbox-daemon/src/harness/` (ensure agents emit with required shape).
  - Stress agent prompts (system messages embed the schema requirement so the LLM emits the right payload).
- A small validator helper at `tests/e2e/helpers/stress-event.ts` should expose a single `assertStressComplete(sessionId, eventType, expectedHarness)` so all three required-matrix specs converge on the same contract.
- Extended-matrix combos (`stress.gemini.*`, `stress.pi-gemini.*`) follow the same schema but their emission failure remains FAIL only in extended runs.
- Closes `ctx-kga` once tests land.
