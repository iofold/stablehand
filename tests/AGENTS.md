# tests/ — Test Infrastructure

## OVERVIEW

96+ test files across 7 categories. Vitest for unit/integration/compliance/contract/sandbox, Playwright for E2E. Compliance suites enforce interface contracts via pluggable factory functions. Additionally, 33 colocated test files live in `__tests__/` directories within `packages/ctxmill/src/`.

## STRUCTURE

```
unit/                 51 files — Component-level tests (harness, tools, events, DB, LLM, learning, workspace, sandbox)
integration/          19 files — Multi-component workflows (orchestrator, CRUD, lifecycle, event flows, HITL)
compliance/           13 files — Interface contract suites (event bus, queue, learning, knowledge, context, executor)
contract/             EMPTY — no shipped contract suite currently
sandbox/              4 files — Container manager, suspend/resume, harness subagents (mocked Docker)
e2e/                  8 Playwright specs + visual snapshots — Chat, background runs, dashboard, session lifecycle
stress/               Stress test agents and tools — NOT in main test suite, run separately
utils/                Shared helpers — test-db.ts, event-bus-test-helpers.ts
setup-strict.ts       Strict mode — console.error/warn interception
```

**Colocated tests** (in `packages/ctxmill/src/*/__tests__/`):
- `sandbox/__tests__/` — 13 files (checkpoint, container-manager, proto-convert, session-recovery, session-status-machine, etc.)
- `orchestrator/__tests__/` — 7 files (webhook-routes, session-manager, session-recovery-coordinator, pilot-integration, etc.)
- `tool/__tests__/` — 4 files (metadata, schema-convert, executor)
- `events/__tests__/`, `config/__tests__/`, `learning/__tests__/`, `manifest/__tests__/`, `util/__tests__/`

## WHERE TO LOOK

| Task | File(s) | Notes |
|------|---------|-------|
| Create a test database | `utils/test-db.ts` | `createTestDb()` — fresh schema per test, advisory locks (ID: 424242) |
| Mock event bus | `utils/event-bus-test-helpers.ts` | `createTestBus()`, `collectEvents()`, `waitForEmit()`, mock factories |
| Write a compliance suite | `compliance/*.compliance.ts` | Export factory function, consumers pass their implementation |
| Opt out of strict mode | Call `allowConsoleErrors()` in `beforeEach` | Suppresses CRITICAL/FOREIGN KEY/mount failure detection |
| Add an E2E test | `e2e/*.spec.ts` + `e2e/support.ts` | Playwright, select by `data-testid`, requires Docker stack |
| Add visual regression | `e2e/visual.spec.ts` | Snapshots in `visual.spec.ts-snapshots/` |
| Add colocated unit test | `packages/ctxmill/src/{module}/__tests__/*.test.ts` | For module-specific tests close to source |

## CONVENTIONS (differs from source)

- **Unit/Integration/Compliance** — `*.test.ts` naming (never `.spec.ts`)
- **E2E** — `*.spec.ts` naming (Playwright convention)
- **Compliance suites** — `*.compliance.ts` — export function that takes factory options, consumers call with their implementation
- **Mocking** — Factory functions returning objects with `vi.fn()` methods (no class mocks). Pattern: `createMock*()` functions
- **Async testing** — `await settle()` for event propagation; never callbacks. `waitForEmit()` for event-driven assertions
- **Timer testing** — `vi.useFakeTimers()` / `vi.useRealTimers()` for timeout/pause tests
- **Path aliases** — `@ctxmill/shared` and `@ctxmill/proto/sandbox/v1` available (vitest.config.ts only)
- **Inline deps** — `@langchain/*` inlined in vitest to avoid module resolution issues

## STRICT TEST MODE

`CTXMILL_STRICT_TESTS=1` (enabled in CI, optional locally).

**Setup file:** `setup-strict.ts` — intercepts `console.error()` and `console.warn()`, fails test if suspicious patterns detected:
- `CRITICAL`, `FOREIGN KEY`, `No trace found`, `mount failure`, `unmount failure`, `DB persistence failed`, `constraint failed`

**Opt out per-test:** Call `allowConsoleErrors()` in `beforeEach`. Still prints to stderr for debugging.

## SHARED UTILITIES

**`test-db.ts`** — PostgreSQL test database factory
- `createTestDb()` → `{ conn, repo, close }`
- Drops/recreates 16 tables in dependency order
- Advisory lock (ID: 424242) prevents concurrent schema resets
- Returns `DatabaseRepository` instance ready for queries
- Connection URL: `postgres://ctxmill:ctxmill@localhost:5433/ctxmill` (configurable via `TEST_DATABASE_URL`)

**`event-bus-test-helpers.ts`** (330 lines) — Event bus testing toolkit
- `createTestBus()` — Fresh TypedEventBus instance
- `collectEvents(bus, eventType)` — Accumulates events into array
- `waitForEmit(bus, eventType)` — Promise that resolves on first emission (5s timeout default)
- Mock factories: `createMockSSEManager()`, `createMockDatabase()`, `createMockLearningPipeline()`, `createMockSuspendDb()`, `createMockTriggerDb()`
- Event builders: `RunStarted`, `RunCompleted`, `TextChunk`, `ToolStarted`, `ToolResult`, `FeedbackReceived`, `AgentCreated`, `RunResumed`

**`e2e/support.ts`** (233 lines) — E2E test helpers
- API helpers: `createTestAgent()`, `deleteTestAgent()`, `startBackgroundRun()`, `sendAgentMessage()`
- Polling: `waitForRunStatus()`, `waitForNonUserMessage()`, `getConversationMessages()`
- Interrupts: `getInterrupts()`, `resolveInterrupt()`

## E2E REQUIREMENTS

- Docker stack must be running (`docker compose up --build -d`)
- Sequential execution: `fullyParallel: false`, `workers: 1`
- Timeout: 120 seconds per test
- Base URL: `http://localhost:3200` (configurable via `PLAYWRIGHT_BASE_URL`)
- API URL: `http://localhost:3002` (configurable via `PLAYWRIGHT_API_BASE_URL`)
- Artifacts on failure: traces, screenshots, videos
- CI retries: 1 retry in CI, 0 locally
- Install browsers: `npx playwright install chromium`
