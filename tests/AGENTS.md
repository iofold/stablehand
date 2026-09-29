# tests - Test Infrastructure

## Overview

Vitest covers backend unit/integration/compliance/sandbox behavior. Playwright specs are scripted regression gates, and agent-browser remains the manual browser evidence workflow for release certification. Stress agents/tools live under `tests/stress` and are run by explicit smoke/harness matrix commands, not by every local unit pass.

## Structure

```text
unit/         Component-level backend tests
integration/ Multi-component orchestrator, API, event, lifecycle tests
compliance/  Interface contract suites consumed by implementations
contract/    Empty placeholder; no shipped contract suite
sandbox/     Sandbox/container lifecycle integration-style tests
e2e/         Playwright smoke, harness matrix, visual QA, and regression specs
stress/      Stress agents/tools/fixtures used by E2E gates
utils/       Test DB and event-bus helpers
```

## Required Test DB

Backend tests that touch PostgreSQL require explicit `TEST_DATABASE_URL`; this is intentional because the suite drops and recreates tables.

```bash
docker compose up -d postgres
docker compose exec -T postgres createdb -U stablehand stablehand_test || true
TEST_DATABASE_URL=postgres://stablehand:stablehand@localhost:5433/stablehand_test pnpm test:backend
```

The dev1 runtime DB (`postgres://stablehand:stablehand@localhost:5433/stablehand`) is refused unless `STABLEHAND_TEST_ALLOW_RUNTIME_DB=1`.

`integration/orchestrator-scenarios.test.ts` and `integration/artifact-rest.test.ts` drive a running stack over HTTP and create/delete real agents, turns, and artifacts. They skip unless `STABLEHAND_LIVE_API_URL` points at a stack you mean to exercise (for example `STABLEHAND_LIVE_API_URL=http://localhost:3002`); `STABLEHAND_API_TOKEN` or `.env` supplies auth. `integration/artifact-storage.test.ts` needs MinIO (`S3_ENDPOINT`, default `http://localhost:9000`), and `ops.test.ts` needs `bun` on `PATH`.

## Where To Look

| Task | File(s) | Notes |
|---|---|---|
| Create/reset test DB | `utils/test-db.ts` | Advisory lock ID 424242; no implicit runtime DB default. |
| Mock event bus | `utils/event-bus-test-helpers.ts` | Collect/wait helpers and mock factories. |
| Write compliance suite | `compliance/*.compliance.ts` | Export factory-driven suites. |
| Add E2E helper | `e2e/support.ts`, `e2e/release-gate-fixtures.ts` | Playwright injects bearer auth when `STABLEHAND_API_TOKEN` is exported. |
| Stress event assertions | `e2e/helpers/stress-event.ts` | ADR-012 exactly-one event contract. |

## Conventions

- Unit/integration/compliance files use `*.test.ts`; Playwright files use `*.spec.ts`.
- Store screenshots, traces, logs, and scratch evidence under `.tmp/`.
- Strict mode is enabled in CI through `STABLEHAND_STRICT_TESTS=1`; use `allowConsoleErrors()` only for known expected output.
- Browser certification against dev1 should use `https://platform.dev.example.com` with `http://localhost:3200` as fallback.
- Export `STABLEHAND_API_TOKEN` for local Playwright/CLI runs; `.env` alone configures Docker but does not export shell env.

## Common Commands

```bash
pnpm lint
pnpm -r typecheck
TEST_DATABASE_URL=postgres://stablehand:stablehand@localhost:5433/stablehand_test pnpm test:backend
pnpm test:ui
STABLEHAND_API_TOKEN=$T pnpm test:e2e:required
STABLEHAND_API_TOKEN=$T pnpm test:e2e:harness-matrix:slice1
```
