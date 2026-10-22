# Stablehand Codebase Map

> Current as of 2026-08-14. This is the compact map for agents and engineers
> checking what the repo ships today, where code lives, and which gotchas matter.

## Package Map

| Package | Purpose | Key Entry Points |
|---|---|---|
| `packages/stablehand` | Core runtime: Fastify orchestrator, auth, DB, canonical event log, routes, sandbox lifecycle, tools, settings, manifests, artifacts. | `src/config/container.ts`, `src/orchestrator/server.ts`, `src/orchestrator/agent-session-service.ts`, `src/orchestrator/sandbox-session-manager.ts`, `src/database/schema-pg.ts` |
| `packages/sandbox-daemon` | Process inside harness containers. Runs harness adapters, exposes gRPC `HarnessService`, proxies tools, handles daemon tools, exports checkpoints. | `src/sandbox/daemon.ts`, `src/sandbox/runner.ts`, `src/harness/*.ts`, `src/sandbox/proto-convert.ts`, `src/sandbox/tool-proxy.ts` |
| `packages/ui` | React operations dashboard. Auth TokenGate, agent/session/event/tool/artifact/settings UI, SSE stores, A2UI rendering. | `src/App.tsx`, `src/lib/api.ts`, `src/lib/useSSE.ts`, `src/stores/conversation.ts`, `src/pages/*` |
| `packages/shared` | Shared API/event/status types consumed by UI/server/client packages. | `src/api.ts`, `src/events.ts`, `src/status.ts` |
| `packages/client` | Lightweight AG-UI/Stablehand streaming client for embeddings. | `src/index.ts` |
| `packages/react` | Lightweight React chat/embed components on top of `@stablehand/client`. Not the full dashboard. | `src/components.tsx`, `src/state.ts` |
| `packages/proto` | ConnectRPC/protobuf definitions and generated code for sandbox IPC. | `stablehand/sandbox/v1/sandbox.proto` |
| `packages/create-stablehand` | Project scaffold CLI. | `src/index.ts`, `src/scaffold.ts` |
| `packages/examples/kitchen-sink` | Maintained multi-harness example with shared tools and event chaining. | `agents/*/agent.yaml`, `tools/*` |

## Runtime Flow

```text
HTTP/UI request
  -> Fastify API auth (master token or capability-scoped key) for /api/*
  -> queue admission (global/per-agent caps; 429 queue_full before any write)
  -> route creates/loads conversation, user message, queued turn row
  -> TurnDispatcher claims via delivery lease + concurrency reservation
  -> TurnStartupService builds launch contract
  -> AgentSessionService coordinates turn execution
  -> SandboxSessionManager opens/reuses/restores sandbox session
  -> sandbox daemon runs LangGraph / Claude Agents / PI Agent harness
  -> daemon streams SessionEvent values over gRPC
  -> orchestrator persists messages/tool calls/turn state
  -> TypedEventBus emits internal events
  -> CanonicalLog projects + persists event_store frames
  -> SSEManager streams canonical AG-UI frames to dashboard clients
```

## Main Capabilities

| Area | Shipped Capability |
|---|---|
| Harnesses | LangGraph, Claude Agents, PI Agent. Models are configured per agent/manifest/harness config. |
| API auth | Operator master token plus revocable, capability-scoped API keys (`cmk_` tokens, sha256-only storage, 12-verb vocabulary, fail-closed: unannotated routes are master-only; an 82-route coverage test enforces total classification). `GET /health` and `GET /api/health` are public. |
| Sandbox callback auth | Session-scoped HMAC callback credentials derived from `STABLEHAND_CALLBACK_TOKEN_SECRET` or `STABLEHAND_API_TOKEN`. |
| Secrets | Per-agent encrypted secrets are injected at start/restore. Per-turn secrets use a terminally deleted encrypted envelope and travel only with `DeliverTurn`. Neither form is checkpointed; production fails closed without a strong `SECRET_MASTER_KEY`. |
| Streaming | Canonical AG-UI frames persisted to `event_store`; SSE ids are zero-padded durable seq values. The `?wire=legacy` escape hatch was removed (W6c, 2026-07-10); the canonical vocabulary is the only wire. |
| HITL | Durable pending interrupts, approve/reject/timeout/suspend outcomes, restart-safe resume attempts. |
| Checkpoint/restore | Harness state plus orchestrator-captured workspace tar. Manual restore route resets retry budget and supports async restore. |
| Queued turns | Durable queue (ctx-z5k0): admission rejects 429 queue_full/503 dispatch_stalled before any write; queued rows are the queue; a single-flight dispatcher claims via delivery lease with claim-time warm/slot lanes and least-recently-served-agent fairness; queue-expired turns finalize honestly. Startup fails stranded running turns unless HITL-parked; queued rows drain post-listen. |
| Tools | Local, HTTP, MCP, Composio, and Artifact providers. Built-ins include `emit-event`, `request-approval`, `a2ui-render`, and `stablehand-guide`. |
| Programmatic tools | Eligible `programmatic: true` tools generate helper scripts in `/workspace/.tools` that call the daemon-local API. |
| Artifacts | S3/MinIO metadata in Postgres; daemon-location upload/download avoids gRPC byte proxying. |
| Cost control | Budget policies (per-agent/tag), model-gateway routing via LiteLLM, spend reconciliation with watermarked ingestion, quarantine, and auto-settlement of turns whose spend evidence is permanently lost (coverage=unpriced, detector stays armed). |
| A2UI | Structured UI blocks are produced by `a2ui-render` tool calls and rendered by the dashboard. HITL UI is separate from A2UI. |
| Settings | DB/env-backed runtime knobs for timeouts, limits, resource defaults, and tar sizes. |
| Webhooks | `callback_outbox` with claim/retry for subscribed run/tool/message/feedback/custom events. |
| Schedules | Persistent recurring Croner clocks emit canonical `custom.*` events into triggers, event history, and webhooks. |
| Deployment | Docker-first local stack (`docker-compose.yml`); the orchestrator also has a Kubernetes driver. |

## Important Boundaries

- Core Stablehand does not currently ship a first-class internal memory/knowledge retrieval subsystem. Use explicit tools, MCP/HTTP providers, artifacts, or external services.
- Skill docs in older plans are historical. Current skill-like behavior is SDK/workspace-native, especially Claude `.claude/skills`.
- Firecracker/microVM execution is not the shipped runtime in this repo; Docker containers are the supported local path.
- Schedules are single-orchestrator, in-process Croner clocks backed by the `schedules` table. Missed downtime fires are skipped; schedules feed the event/trigger spine and never dispatch turns directly.
- The React embed package is intentionally lightweight and does not provide dashboard feature parity.

## Current Gotchas

### Auth and Environment

- Docker Compose reads `.env`; Playwright, curl, and CLI processes need `STABLEHAND_API_TOKEN` exported in the shell too.
- `STABLEHAND_AUTH_DISABLED=true` only opens auth when no token/secret is configured. If a token exists, auth enforces.
- Browser `EventSource` cannot send headers, so dashboard SSE uses `?access_token=`. Other API routes reject query tokens.
- `stablehand chat` is not the same as the repo-local `.codex/skills/stablehand-cli` scripts; verify auth support before using it against protected stacks.

### Testing

- `pnpm test` is backend Vitest only. Run `pnpm test:ui` separately.
- Backend DB tests require explicit `TEST_DATABASE_URL` and drop/recreate schema.
- Do not point tests at the dev1 runtime DB unless deliberately setting `STABLEHAND_TEST_ALLOW_RUNTIME_DB=1`.
- `STABLEHAND_API_TOKEN` must be exported for local Playwright gates.

### Streaming and Events

- `CONNECTED` and `CUSTOM name: stablehand.sandbox_session.snapshot` SSE
  bootstrap frames are direct route writes, not persisted canonical AG-UI
  frames.
- Canonical replay is durable but the current reconnect call uses the repository default replay limit; huge replay windows should be paged before treating replay as unbounded.
- `/api/events` is an operational event log over `event_store`; custom event type strings remain open vocabulary.

### Sandbox Lifecycle

- Harness image changes require rebuilding harness images. This repo's compose file wires build-only services, but foreign compose stacks must preserve that or build manually.
- Claude and PI Agent containers have a 2048 MiB memory floor even when lower defaults are configured.
- Container accounting rehydrates live containers on boot and may temporarily exceed max until reconciliation frees stale slots.
- Manual restore only supports `POST /api/agents/:id/sandbox-sessions/:sessionId/restore`; older route shapes are intentionally unsupported.

### Tools and Workspaces

- `ToolContext` has agent/conversation/request/workspace/event fields; it does not expose a `knowledge` object.
- Inline manifest tool references do not create executable handlers by themselves.
- Workspace tar uploads reject `.git/` and `.stablehand/`, as well as symlinks, hardlinks, absolute paths, and traversal.
- There is no shipped session promote endpoint today; workspace diff/promote/discard APIs are tracked separately.

## Docs Most Likely To Drift

- `docs/architecture.md`
- `docs/event-pipeline-mapping.md`
- `docs/api-reference.md`
- `docs/container-lifecycle.md`
- `docs/environment-variables.md`
- package-local `AGENTS.md` files

Historical plans, audits, and research docs should keep their original context, but add a status note when they are easy to mistake for current behavior.
