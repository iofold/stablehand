# packages/ctxmill - Core Runtime

## Overview

Core orchestrator package: Fastify API, API auth, PostgreSQL repository, canonical event spine, sandbox session management, tool registries, artifact metadata, settings, manifests, and workspace helpers. Harness adapters are registered here for type/API compatibility, but live execution happens inside sandbox containers via `@ctxmill/sandbox-daemon`.

## Structure

```text
src/
  a2ui/           A2UI extraction helpers and tests
  agent/          Agent discovery and defineAgent() builder
  artifact/       S3/MinIO artifact store and metadata integration
  cli/            `ctxmill dev` and `ctxmill chat`
  config/         Config resolver, docker preset, DI container
  database/       Drizzle PostgreSQL schema, migrations, repository, row types
  events/         TypedEventBus, triggers, waits
  harness/        Harness registry/types and compatibility adapter classes
  manifest/       YAML manifest parsing, validation, conversion, service
  orchestrator/   Fastify server, auth, routes, canonical log, SSE, HITL, turn and sandbox-session services
  sandbox/        Container managers, accounting, workspace diff, proto conversion helpers
  secrets/        Encrypted per-agent secrets and production master-key guard
  settings/       DB/env-backed runtime settings
  tool/           Built-ins, executors, providers, registry, schema conversion
  util/           Error/retry/sanitize helpers
  workspace/      Session workspace and tar upload helpers
```

`knowledge/` and `learning/` are currently empty/reserved; do not document them as active runtime systems.

## Where To Look

| Task | File(s) | Notes |
|---|---|---|
| Trace an interactive turn | `orchestrator/routes/agents/turns.ts` -> `turn-startup-service.ts` -> `agent-turn-service.ts` -> `sandbox-session-manager.ts` | Turn rows are durable and move queued -> running -> terminal. |
| Trace sandbox lifecycle | `orchestrator/sandbox-session-manager.ts`, `orchestrator/session-manager/*`, `sandbox/container-manager.ts` | Checkpoint/restore, manual restore, retry budgets, accounting. |
| Trace event streaming | `events/bus.ts`, `orchestrator/canonical/*`, `orchestrator/sse.ts`, `orchestrator/routes/agents/stream.ts` | EventBus -> CanonicalLog -> event_store -> SSEManager. No `SSEBroadcaster`. |
| Add an API route | `orchestrator/routes/` and `orchestrator/server.ts` | `/api/*` is bearer-token protected unless route config is public. |
| Add DB shape | `database/schema-pg.ts`, `database/migrations.ts`, `database/repository.ts`, `database/types.ts` | Keep Drizzle row types exported from `database/types.ts`. |
| Add an event type | `events/bus.ts` plus canonical projector behavior if it affects SSE | Custom events can remain verbatim. Run-channel events usually need projection. |
| Add a tool/provider | `tool/types.ts`, `tool/provider.ts`, `tool/providers/*`, `tool/registry.ts` | Use Zod input schemas. Artifact tools are daemon-location metadata. |
| Add/modify HITL | `tool/builtin/request-approval.ts`, `orchestrator/interrupt.ts`, `routes/agents/interrupts.ts`, `session-manager/interrupt-resume-service.ts` | Approval/reject can resume through durable attempts. |
| Modify auth/secrets | `orchestrator/auth.ts`, `orchestrator/grpc/callback-auth.ts`, `secrets/master-key.ts` | Production fails closed without required secrets/tokens. |

## Key Flows

```text
HTTP/API request
  -> registerApiAuth on /api/*
  -> route creates turn/message rows
  -> TurnStartupService builds launch contract
  -> AgentTurnService/SandboxSessionManager opens or reuses sandbox session
  -> sandbox daemon HarnessService streams SessionEvent values
  -> TurnFinalizer writes terminal state
  -> TypedEventBus emits internal events
  -> CanonicalLog persists projected frames before SSE fan-out
```

Startup reconciliation:

- Stranded running turns are failed unless parked on durable HITL.
- Queued turns with persisted user-message ids are re-dispatched.
- Live containers are rehydrated into accounting before reconciliation.
- `RESTORING` sessions with checkpoints roll back to `CHECKPOINTED` for retry.

## Gotchas

- `runId` and `threadId` are AG-UI wire fields. Internally use `turnId`,
  `conversationId`, `sandboxSessionId`, or `interruptId` for their distinct
  concepts.
- `CTXMILL_API_TOKEN` protects `/api/*`; browser SSE uses `?access_token=` only on the stream route.
- ConnectRPC sandbox callbacks use session-scoped HMAC credentials derived from `CTXMILL_CALLBACK_TOKEN_SECRET` or `CTXMILL_API_TOKEN`.
- Secrets are injected at fresh start/restore and must never be serialized into checkpoints.
- `EventQueueImpl`/`scheduled_events` was deleted; durable event work should build on `event_store`.
- `ctxmill chat` is not the same as the repo-local `.codex/skills/ctxmill-cli` tooling; verify auth support before recommending it against protected stacks.
- Backend tests require explicit `TEST_DATABASE_URL`; the dev1 runtime DB is refused unless `CTXMILL_TEST_ALLOW_RUNTIME_DB=1`.

## Verification

- Scoped backend change: run targeted Vitest plus `pnpm -r typecheck`.
- Repository gate: `TEST_DATABASE_URL=postgres://ctxmill:ctxmill@localhost:5433/ctxmill_test pnpm test:backend`, `pnpm lint`, `pnpm -r typecheck`.
- UI/API-shape changes require Docker rebuild and browser verification under `.tmp/`.
