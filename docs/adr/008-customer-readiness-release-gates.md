# ADR 008: Customer Readiness Release Gates

**Date:** 2026-04-30  
**Status:** Accepted

## Context

A green run is not release-meaningful while Playwright discovery, console-error handling, terminal error states, and harness/stress coverage are ambiguous.

## Decision

Required release gates are narrow, deterministic, and reproducible:

```bash
pnpm typecheck
pnpm -r build
pnpm lint
pnpm test
pnpm test:e2e -- --project=chromium --grep @smoke
```

If `@smoke` is not adopted during implementation, this ADR and CI docs must be updated with the actual required-smoke command. Extended gates include the full Playwright visual/e2e suite, full harness matrix, provider-heavy scenarios, and longer stress tests.

Required green evidence means build/type/lint/unit/integration pass, required UI smoke passes, no unexpected terminal error states, strict UI console gate passes, and selected stress smoke is deterministic.

## Consequences

- Stage 5 owns `ctx-0j2`, `ctx-x6b`, `ctx-gg6`, `ctx-kga`, `ctx-1s5`, and `ctx-0zk`.
- Extended failures must be tracked but do not silently weaken the required release gate.
