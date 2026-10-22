# Stablehand API Reference

## 1. Overview

- **Base URL:** `http://localhost:3002` by default
- **Content-Type:** `application/json` for almost all endpoints
- **Exceptions:**
  - `GET /api/agents/:id/stream` uses `text/event-stream`
  - `POST /api/agents/:id/workspace` expects `application/gzip` or `application/x-gzip`
- **Authentication:** `STABLEHAND_API_TOKEN` is the operator master token. Capability-scoped `cmk_...` keys are available for extensions. Production startup fails without a master token unless `STABLEHAND_AUTH_DISABLED=true` is explicitly set.
- **Canonical API contracts:** Stablehand exports strict schemas and inferred types from `@stablehand/contracts` (for example `AgentSchema`, `TurnSchema`, `ConversationSummarySchema`, `Agent`, and `Turn`). Streaming-only types remain in `@stablehand/shared`.

### Authentication

Set `STABLEHAND_API_TOKEN` to a high-entropy value and pass it on operator control-plane requests:

```bash
curl -H "Authorization: Bearer $STABLEHAND_API_TOKEN" \
  http://localhost:3002/api/agents
```

Create a separate scoped key for each extension or integration. Scoped keys are
deployment-wide but capability-bounded; they cannot administer keys, settings,
secrets, workspaces, or other master-only routes. See the complete
[capability map and lifecycle guide](scoped-api-keys.md).

`GET /health` and `GET /api/health` are public for load balancers and container health checks. Other `/api/*` routes return `401 Unauthorized` when the token is missing, invalid, expired, or revoked. A valid scoped key receives `403 Forbidden` when it lacks the route capability or attempts a master-only route.

Browser `EventSource` cannot set custom headers, so `GET /api/agents/:id/stream` also accepts `?access_token=...` for SSE clients. Query-token authentication is intentionally limited to that route. Prefer an authorization header whenever the client permits it because query values can escape into browser history and intermediary logs; Stablehand redacts the value in its own request logs.

Capability scoping is not resource or tenant isolation. Keep reverse-proxy auth, network allowlists, TLS, and rate limits in front of any shared deployment. Sandbox ConnectRPC callbacks are additionally protected by session-scoped HMAC credentials derived from `STABLEHAND_CALLBACK_TOKEN_SECRET` or `STABLEHAND_API_TOKEN`, but the ConnectRPC surface should still remain on private networks.

### Breaking changes: 2026-08-19 contract normalization

This was one breaking change with no deprecated aliases. Integrators update in a single step:

- `GET /health` / `GET /api/health`: `timestamp` is now an epoch-milliseconds integer (was the API's sole ISO string); `sandbox` keys are camelCase (`executionMode`, `totalCreated`, `maxGlobalContainers`).
- `GET /api/sandbox/metrics`: camelCase keys — `executionMode`, `totalCreated`, `byHarness`, `averageLifetimeMs`, `maxGlobalContainers`.
- `GET /api/config`: `system.uptime` → `system.uptimeMs`.
- Artifact signed URLs: `expiresIn` → `expiresInSec` in both responses and in the `download-url` query parameter.
- Agent `httpTools`: `timeout` → `timeoutMs` (integer milliseconds, minimum `100`); stored agent definitions were migrated in place.
- Workspace file routes: `size` → `sizeBytes`; the read-too-large error carries `maxSizeBytes`.
- Schedules: `nextRun` → `nextRunAt`.
- Messages: `createdAt` is epoch-milliseconds only (the ISO union is gone).
- Triggers: `createdAt` is served as an epoch-milliseconds integer.
- Turns: new `queuedAt` (queue-admission time); `startedAt` now means execution start (it previously recorded admission time). `sandboxSessionId`, `completedAt`, `error`, and `taskDescription` are null-and-present. The background turn-start response no longer includes `sandboxSessionId`.
- Interrupts: the entity primary key is `id` (was `interruptId`; event/webhook payloads keep `interruptId` as the cross-reference); `toolCallName` → `toolName`; resolve actions are `approve` | `reject` only (`submit` removed); query param `include_resolved` → `includeResolved`.
- Webhooks: payload `toolCallName` → `toolName`; `turn.completed` `status` now uses the REST TurnStatus values verbatim (`COMPLETED` | `ERROR` | `CANCELLED` — was lowercase); new subscribable builtin events `turn.cancelled`, `artifact.deleted`, `agent.deleted`.
- Errors: `required_capability` → `requiredCapability`; validation failures carry `issues: [{ path, message }]`; the 413 payload-too-large and invalid-custom-event bodies use the standard `{ error, code, ... }` envelope; `POST /api/catalogs/tools/test` rejects invalid bodies with the standard envelope; `POST /api/triggers/emit` can now shed load with `429 ingest_queue_full`.
- Deletes: `DELETE /api/artifacts/:id` and `DELETE /api/triggers/:id` return `204 No Content` (previously JSON bodies).

Turn and conversation lifecycle statuses were always served SCREAMING_CASE by REST; earlier revisions of this document wrongly showed lowercase values in examples. That is a documentation fix, not a wire change.

## 2. Quick Reference Table

| METHOD | Path | Description |
|---|---|---|
| **Health & Config** |  |  |
| GET | `/health` | Health check |
| GET | `/api/health` | Health check under API prefix |
| GET | `/api/config` | Runtime config summary |
| **Agents** |  |  |
| GET | `/api/agents` | List agents |
| POST | `/api/agents` | Create agent |
| GET | `/api/agents/:id` | Get agent detail |
| PATCH | `/api/agents/:id` | Update agent |
| DELETE | `/api/agents/:id` | Delete agent |
| **Agent Execution** |  |  |
| POST | `/api/agents/:id/message` | Send interactive message |
| POST | `/api/agents/:id/turns` | Start a background turn |
| POST | `/api/agents/:id/turns/:turnId/cancel` | Cancel a running turn |
| GET | `/api/agents/:id/turns/:turnId` | Get a turn plus its conversation messages |
| GET | `/api/agents/:id/turns` | List agent turns |
| **Conversation & Sandbox Lifecycle** |  |  |
| POST | `/api/agents/:id/sandbox-sessions/:sandboxSessionId/suspend` | Checkpoint a sandbox session |
| POST | `/api/agents/:id/sandbox-sessions/:sandboxSessionId/restore` | Manually restore a checkpointed sandbox session |
| POST | `/api/agents/:id/sandbox-sessions/:sandboxSessionId/kill` | Terminate a sandbox session |
| GET | `/api/conversations?status=active` | List active conversation summaries |
| GET | `/api/sandbox-sessions?status=active` | List active sandbox sessions |
| **SSE Streaming** |  |  |
| GET | `/api/agents/:id/stream` | Subscribe to live agent events |
| **AG-UI Protocol** |  |  |
| POST | `/api/ag-ui/:id/run` | AG-UI protocol endpoint — accepts `RunAgentInput` and returns run-scoped SSE ([docs](ag-ui-compat.md)) |
| **Conversations & Messages** |  |  |
| GET | `/api/agents/:id/conversations` | List conversations |
| GET | `/api/agents/:id/conversations/summary` | List enriched conversation summaries |
| GET | `/api/agents/:id/conversations/:convId/snapshot` | Read ordered messages and their exact SSE replay boundary |
| **Human-in-the-Loop** |  |  |
| GET | `/api/agents/:id/interrupts` | List pending interrupts |
| POST | `/api/agents/:id/interrupt` | Resolve an interrupt |
| GET | `/api/interrupts` | List durable interrupts across agents |
| **Files & Workspace** |  |  |
| GET | `/api/agents/:id/files` | List workspace directory entries |
| GET | `/api/agents/:id/files/read` | Read a workspace file |
| POST | `/api/agents/:id/files` | Create a workspace file |
| PUT | `/api/agents/:id/files` | Update a workspace file |
| DELETE | `/api/agents/:id/files` | Delete a workspace file |
| POST | `/api/agents/:id/workspace` | Replace base workspace from tarball |
| **Secrets** |  |  |
| GET | `/api/agents/:id/secrets` | List secret keys |
| POST | `/api/agents/:id/secrets` | Set secret |
| DELETE | `/api/agents/:id/secrets/:key` | Delete secret |
| **Webhooks** |  |  |
| GET | `/api/agents/:id/webhooks` | List webhooks |
| POST | `/api/agents/:id/webhooks` | Create webhook |
| PATCH | `/api/agents/:id/webhooks/:webhookId` | Update webhook |
| DELETE | `/api/agents/:id/webhooks/:webhookId` | Delete webhook |
| **Feedback** |  |  |
| POST | `/api/agents/:id/feedback` | Submit thumbs-up/thumbs-down feedback |
| **Settings** |  |  |
| GET | `/api/settings` | Get system settings |
| PUT | `/api/settings` | Update system settings |
| **Access Keys** |  |  |
| GET | `/api/keys` | List scoped keys (master-only) |
| POST | `/api/keys` | Create a scoped key and return its token once (master-only) |
| DELETE | `/api/keys/:id` | Revoke a scoped key (master-only) |
| **Artifacts** |  |  |
| GET | `/api/artifacts` | List artifacts |
| GET | `/api/artifacts/:id` | Get artifact metadata |
| GET | `/api/artifacts/:id/download` | Download artifact bytes |
| GET | `/api/artifacts/:id/download-url` | Get signed download URL |
| POST | `/api/artifacts/upload-url` | Get signed upload URL |
| POST | `/api/artifacts/upload` | Upload artifact bytes as multipart form data |
| DELETE | `/api/artifacts/:id` | Delete artifact |
| **Events** |  |  |
| GET | `/api/events` | List persisted events |
| GET | `/api/events/stats` | Event stats |
| GET | `/api/events/types` | Distinct event types |
| **Triggers** |  |  |
| GET | `/api/triggers` | List triggers |
| POST | `/api/triggers` | Create trigger |
| GET | `/api/triggers/:id` | Get trigger |
| PUT | `/api/triggers/:id` | Update trigger |
| DELETE | `/api/triggers/:id` | Delete trigger |
| POST | `/api/triggers/emit` | Emit custom event |
| **Schedules** |  |  |
| GET | `/api/schedules` | List cron schedules |
| POST | `/api/schedules` | Create cron schedule |
| GET | `/api/schedules/:id` | Get cron schedule |
| PATCH | `/api/schedules/:id` | Update cron schedule |
| DELETE | `/api/schedules/:id` | Delete cron schedule |
| **Catalogs & Tools** |  |  |
| GET | `/api/catalogs/tools` | List tools |
| POST | `/api/catalogs/tools/test` | Test-run a tool |
| **Sandbox Metrics** |  |  |
| GET | `/api/sandbox/metrics` | Container metrics |

## 3. Conventions

### Response envelopes

- **Raw arrays** are used for some list endpoints, including:
  - `GET /api/agents`
  - `GET /api/agents/:id/conversations`
  - `GET /api/conversations?status=active`
  - `GET /api/sandbox-sessions?status=active`
  - `GET /api/agents/:id/webhooks`
  - `GET /api/triggers`
  - `GET /api/catalogs/tools`
- **Wrapped objects** are used elsewhere, for example:
  - `{ conversationId, eventCursor, messages: [...] }`
  - `{ turns: [...] }`
  - `{ conversations: [...] }`
  - `{ artifacts: [...], total }`
  - `{ schedules: [...] }`
  - `{ keys: [...] }`
  - `{ events: [...], nextCursor }`
  - `{ interrupts: [...] }`

### Error format

The standard envelope is:

```json
{ "error": "Human-readable message", "code": "machine_token" }
```

Grammar:

- `error` is always the human-readable sentence; `code` is the stable machine token. Simple 400/404s may carry `{ "error": ... }` alone; machine-actionable errors always include `code`.
- Validation failures add `issues`: an array of `{ "path": "...", "message": "..." }`.
- Throttles add `retryAfterSec`, mirroring the `Retry-After` header.
- Endpoint-specific context keys are camelCase, for example `turnId`, `sandboxSessionId`, `agentId`, `artifactId`, `validEvents`, `activeSessions`, `sizeBytes`, `maxSizeBytes`, `detail`.

Scoped authorization failures add `requiredCapability`:

```json
{
  "error": "Forbidden: this route requires the 'events:read' capability",
  "requiredCapability": "events:read"
}
```

`requiredCapability: null` means the route requires the master token.

### Status codes

Common codes used across the API:

- `200 OK`
- `201 Created`
- `202 Accepted`
- `204 No Content`
- `401 Unauthorized`
- `403 Forbidden`
- `400 Bad Request`
- `404 Not Found`
- `500 Internal Server Error`
- `501 Not Implemented`
- `503 Service Unavailable`

Also used by specific endpoints:

- `409 Conflict`
- `413 Payload Too Large`
- `415 Unsupported Media Type`

### Pagination

- **Events:** cursor-based via `cursor` / `nextCursor`
- **Artifacts:** offset-based via `limit` + `offset`
- **Everything else:** no pagination

### Shared types

Useful exported types from `@stablehand/shared`:

- API resources: `Agent`, `Turn`, `ConversationSummary`, `Message`
- Streaming: `AgentSessionEvent`, `AgentSessionEventType`, `MessageCommittedEvent`

### Field conventions

- **Identifiers:** every entity's primary key is `id`; cross-references are `<entity>Id` (`agentId`, `turnId`, `sandboxSessionId`, ...). Ids are opaque strings — never parse or construct them. API-key ids carry a `key_` prefix and their bearer tokens a `cmk_` prefix; both are still opaque.
- **Timestamps:** integer epoch-milliseconds UTC with an `At` suffix (`createdAt`, `startedAt`, `expiresAt`). Sole exception: the `X-Webhook-Timestamp` delivery header is Unix **seconds** (signing convention); webhook payload `timestamp` fields are epoch-milliseconds like everything else.
- **Durations:** milliseconds with an `Ms` suffix (`durationMs`, `uptimeMs`, `averageLifetimeMs`). Sanctioned seconds fields always carry a `Sec` suffix: `retryAfterSec` (mirrors `Retry-After`), `expiresInSec` (signed-URL convention), `timeoutSec`/`defaultTimeoutSec` (container limits).
- **Sizes:** bytes with a `Bytes` suffix (`sizeBytes`, `maxSizeBytes`, `totalBytes`, `maxBytes`). `memoryMb` is mebibytes (MiB).
- **Enums:** lifecycle machine states are SCREAMING_CASE — turns `QUEUED | RUNNING | COMPLETED | ERROR | CANCELLED`, sandbox sessions `ACTIVE | CHECKPOINTED | RESTORING | TERMINATED`, conversations `ACTIVE | CHECKPOINTED | RESTORING | COMPLETED | ERROR | CANCELLED | IDLE`. Everything else is lowercase_snake (`pending`, `resolved`, `thumbs_up`). Webhook payloads use the REST values verbatim. Accepted legacy word-form: tool-call `status` uses `complete`, not `completed`.
- **Null vs omitted:** entity fields with no value are `null` and present; a field is omitted only when it does not apply to that projection. No sentinel values.
- **Turn timing:** `queuedAt` is queue-admission time; `startedAt` is execution start; `durationMs` = `completedAt − startedAt`.
- **`checkpointAt`:** on turn readback this is the sandbox-session row's `updatedAt` while the session is `CHECKPOINTED` — a proxy for checkpoint time, not an independently stamped instant.

### Validation ranges

Per-agent sandbox resource limits:

- `cpus`: `0.5` to `4.0`
- `memoryMb`: integer `256` to `4096` (MiB)
- `pidsLimit`: integer `64` to `512`
- `timeoutSec`: integer `60` to `3600`

## 4. Endpoint Reference

### a. Health & Config

#### `GET /health`

- **Description:** Direct health check.
- **Query params:** None.
- **Response:**

```json
{
  "status": "ok",
  "timestamp": 1712140000000,
  "sandbox": {
    "executionMode": "sandbox",
    "containers": {
      "active": 1,
      "queued": 0,
      "peak": 4,
      "totalCreated": 25
    },
    "limits": {
      "maxGlobalContainers": 20
    }
  },
  "modelGateway": {
    "enabled": true,
    "state": "healthy",
    "lagMs": 120,
    "awaitingTurns": 0,
    "lastError": null
  }
}
```

- **Notes:** `/api/health` returns the same payload. `timestamp` is epoch
  milliseconds. The `sandbox` arm is present only when sandbox container
  management is enabled; the `modelGateway` arm only when the model gateway
  is configured.

#### `GET /api/health`

- **Description:** Health check under the API prefix.
- **Query params:** None.
- **Response:** Same as `/health`.
- **Notes:** Use this when you only expose `/api/*` through a reverse proxy.

#### `GET /api/config`

- **Description:** Returns runtime config that is safe to expose to operators and UI clients.
- **Query params:** None.
- **Response:**

```json
{
  "system": {
    "version": "0.1.0",
    "uptimeMs": 123456,
    "dbPath": ".stablehand"
  },
  "agentDefaults": {
    "harness": "langgraph",
    "temperature": 0.7,
    "maxTokens": 4096
  },
  "authentication": {
    "mode": "enforced"
  }
}
```

- **Notes:** `uptimeMs` is milliseconds since process start. `authentication.mode`
  is `enforced` or `disabled`. This route is master-only, so extensions should
  probe a capability-bearing endpoint they actually use instead of treating
  config as scoped-key introspection.

### b. Agents (`/api/agents`)

#### `GET /api/agents`

- **Description:** Lists all agents with runtime summary data.
- **Query params:** None.
- **Response:** raw array.

```json
[
  {
    "id": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
    "name": "Support Agent",
    "status": "idle",
    "harness": "langgraph",
    "harnessConfig": { "model": "gpt-5.4-mini" },
    "tools": ["web_search", "artifact_upload"],
    "resourceLimits": { "cpus": 1, "memoryMb": 1024 },
    "conversationCount": 12,
    "turnCount": 22,
    "completedTurnCount": 20,
    "failedTurnCount": 1,
    "activeTurnCount": 1,
    "sseClients": 2,
    "hasPendingInterrupt": false,
    "sandboxSessionsByStatus": {
      "ACTIVE": 1,
      "CHECKPOINTED": 0,
      "RESTORING": 0,
      "TERMINATED": 0
    }
  }
]
```

- **Notes:** Returns a denormalized operational view, not just the stored agent row. Counters are one-per-concept: `conversationCount` counts durable conversations, the `*TurnCount` fields count execution turns, and `sandboxSessionsByStatus` counts sandbox sessions (containers).

#### `POST /api/agents`

- **Description:** Creates an agent.
- **Request body:**

```json
{
  "name": "Support Agent",
  "harness": "langgraph",
  "harnessConfig": { "model": "gpt-5.4-mini" },
  "systemPrompt": "You help customers troubleshoot Stablehand deployments.",
  "tools": ["web_search"],
  "httpTools": [
    {
      "name": "crm_lookup",
      "description": "Look up a customer in CRM",
      "endpoint": "https://crm.example.com/api/customers/lookup",
      "method": "POST",
      "headers": { "X-App": "stablehand" },
      "timeoutMs": 15000
    }
  ],
  "description": "Customer support assistant",
  "metadata": { "team": "support" },
  "resourceLimits": {
    "cpus": 1,
    "memoryMb": 1024,
    "pidsLimit": 256,
    "timeoutSec": 600
  }
}
```

- **Query params:** None.
- **Response:** created agent object.

```json
{
  "id": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "name": "Support Agent",
  "harness": "langgraph",
  "harnessConfig": { "model": "gpt-5.4-mini" },
  "systemPrompt": "You help customers troubleshoot Stablehand deployments.",
  "tools": ["web_search", "crm_lookup"],
  "workspaceDir": "/data/agents/1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e/base",
  "resourceLimits": {
    "cpus": 1,
    "memoryMb": 1024,
    "pidsLimit": 256,
    "timeoutSec": 600
  }
}
```

- **Notes:**
  - `name`, `harness`, `harnessConfig`, `systemPrompt`, and `tools` are required.
  - `model` and `modelConfig` are rejected.
  - `httpTools` entries must include `name`, `description`, and `endpoint`. `timeoutMs` is integer milliseconds with a minimum of `100`.
  - An invalid body returns `400` with `code: "invalid_agent_definition"` (or `"invalid_agent_update"` on PATCH) and `issues: [{ "path": "...", "message": "..." }]`.
  - An invalid `harnessConfig` returns `400` with `code: "invalid_harness_config"` and `issues: [{ "path": "...", "message": "..." }]`.
  - If workspaces are enabled, Stablehand creates and seeds a base workspace automatically.

#### `GET /api/agents/:id`

- **Description:** Gets one agent plus operational summary fields.
- **Query params:** None.
- **Response:**

```json
{
  "id": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "name": "Support Agent",
  "harness": "langgraph",
  "harnessConfig": { "model": "gpt-5.4-mini" },
  "tools": ["web_search", "crm_lookup"],
  "conversationCount": 12,
  "turnCount": 12,
  "completedTurnCount": 10,
  "failedTurnCount": 1,
  "activeTurnCount": 1,
  "sseClients": 1,
  "hasPendingInterrupt": false,
  "sandboxSessionsByStatus": {
    "ACTIVE": 1,
    "CHECKPOINTED": 0,
    "RESTORING": 0,
    "TERMINATED": 0
  }
}
```

- **Notes:** `404` if the agent does not exist.

#### `PATCH /api/agents/:id`

- **Description:** Updates mutable agent fields.
- **Request body:** any subset of the create fields.

```json
{
  "description": "Updated description",
  "tools": ["web_search"],
  "httpTools": [],
  "resourceLimits": {
    "cpus": 2,
    "memoryMb": 2048,
    "pidsLimit": 256,
    "timeoutSec": 900
  }
}
```

- **Query params:** None.
- **Response:** updated agent object.

```json
{
  "id": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "description": "Updated description",
  "resourceLimits": {
    "cpus": 2,
    "memoryMb": 2048,
    "pidsLimit": 256,
    "timeoutSec": 900
  }
}
```

- **Notes:**
  - Request body must contain at least one field.
  - If you change `harness`, you must also send `harnessConfig`.
  - `resourceLimits` updates are metadata overrides and take precedence over manifest defaults on future sandbox starts.
  - Set `resourceLimits` to `null` to clear the metadata override and fall back to manifest/default limits.

#### `DELETE /api/agents/:id`

- **Description:** Deletes an agent and associated data.
- **Query params:** None.
- **Response:** no body.
- **Notes:** Returns `204`. Removes associated HTTP tool provider registrations.

### c. Agent Execution

#### `POST /api/agents/:id/message`

- **Description:** Sends an interactive user message to an agent.
- **Request body:**

```json
{
  "content": "Summarize the last 24 hours of production alerts.",
  "conversationId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20"
}
```

- **Query params:** None.
- **Response:**

```json
{
  "messageId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04-m3",
  "conversationId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
  "turnId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04"
}
```

- **Notes:**
  - If `conversationId` is omitted, Stablehand creates one.
  - The actual run starts asynchronously through the durable turn queue.
  - SSE clients receive `TEXT_MESSAGE_*` user-message bootstrap events plus
    `CUSTOM name: stablehand.turn.pending` before the canonical `RUN_STARTED`.
- **Queue rejections** (applies to every turn-creating route — this one,
  `POST /api/agents/:id/turns`, and trigger-driven starts):
  - `429` with body `{ "error": <human message>, "code": "queue_full",
    "scope": "global" | "agent", "agentId": <id>, "queued": <n>,
    "limit": <n>, "retryAfterSec": 5 }` and a `Retry-After` header when the
    global or per-agent queued-turn cap is reached. Rejection happens
    **before any write**: no message and no turn row are created, and the
    caller owns the retry — nothing is half-accepted.
  - `503` with body `{ "error": <human message>, "code": "dispatch_stalled",
    "retryAfterSec": 15 }` when turns are queued but the dispatcher has not
    completed a pass recently. Accepted turns are durable and survive
    restarts.

#### `POST /api/agents/:id/turns`

- **Description:** Starts a background run using `task` as the synthetic user message.
- **Request body:**

```json
{
  "task": "Index the uploaded artifacts and prepare a summary.",
  "mode": "background",
  "sandboxSecrets": {
    "MYAPP_SERVICE_TOKEN": "jwt-or-token-value"
  }
}
```

- **Query params:** None.
- **Response (`201`):**

```json
{
  "turnId": "4e8a2c17-95bd-4f60-a3b9-6c1d7e0f5a28",
  "conversationId": "f0c1b2a3-6d5e-4c4b-9a8f-7e6d5c4b3a21"
}
```

- **Notes:**
  - Updates the agent status to `running` and returns before the run completes. No sandbox session exists yet at accept time, so the response carries only the turn and conversation identities; read `sandboxSessionId` back from the turn once dispatch assigns one.
  - `sandboxSecrets` is optional and scoped to the created turn. Stablehand carries the exact map on that turn's `DeliverTurn` RPC as immutable harness context. Harness adapters pass it explicitly to the relevant model or child-process environment without mutating the daemon's stable process environment.
  - To support queued restart and checkpointed HITL continuation, Stablehand retains an authenticated encrypted envelope while the turn is open and deletes it atomically when terminal finalization succeeds. Plaintext is never written to task messages, agent records, container startup configuration, events, or checkpoints.
  - Use per-agent stored secrets for model/provider credentials initialized when a persistent harness session opens. Use per-turn values for short-lived integration credentials consumed by that turn.
  - `STABLEHAND_*`, `ORCHESTRATOR_URL`, `SANDBOX_PORT`, `PTC_PORT`, and `NODE_OPTIONS` are reserved runtime controls and are rejected.

#### `POST /api/agents/:id/turns/:turnId/cancel`

- **Description:** Cancels a running turn.
- **Request body:** None.
- **Query params:** None.
- **Response:**

```json
{
  "cancelled": true,
  "turnId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04"
}
```

- **Notes:** Returns `404` if the turn or live sandbox session cannot be found.

#### `GET /api/agents/:id/turns/:turnId`

- **Description:** Returns a turn plus all messages in its conversation.
- **Query params:** None.
- **Response:**

```json
{
  "turn": {
    "id": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
    "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
    "conversationId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
    "sandboxSessionId": "b61b41f2-7c3d-4a5e-8f90-1a2b3c4d5e6f",
    "status": "RUNNING",
    "mode": "interactive",
    "taskDescription": "Summarize alerts",
    "queuedAt": 1712139999000,
    "startedAt": 1712140000000,
    "completedAt": null,
    "error": null,
    "usage": null
  },
  "messages": [
    {
      "id": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04-m0",
      "role": "user",
      "content": "Summarize alerts",
      "messageRevision": 0,
      "createdAt": 1712140000000
    }
  ]
}
```

- **Notes:** `queuedAt` is queue-admission time; `startedAt` is execution
  start. `sandboxSessionId`, `completedAt`, `error`, and `taskDescription`
  are null-and-present when they have no value. When present, `checkpointAt`
  is the sandbox-session row's `updatedAt` while that session is
  `CHECKPOINTED` (a proxy for checkpoint time).

### d. Turns and sandbox lifecycle

#### `GET /api/agents/:id/turns`

- **Description:** Returns normalized execution summaries for an agent.
- **Query params:** None.
- **Response:** `{ "turns": [...] }`.

```json
{
  "turns": [
    {
      "id": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
      "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
      "conversationId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
      "sandboxSessionId": "b61b41f2-7c3d-4a5e-8f90-1a2b3c4d5e6f",
      "sandboxStatus": "CHECKPOINTED",
      "status": "COMPLETED",
      "mode": "interactive",
      "taskDescription": "Summarize alerts",
      "queuedAt": 1712139999000,
      "startedAt": 1712140000000,
      "completedAt": 1712140015000,
      "error": null,
      "usage": null
    }
  ]
}
```

#### `POST /api/agents/:id/sandbox-sessions/:sandboxSessionId/suspend`

- **Description:** Checkpoints a sandbox session.
- **Request body:** None.
- **Query params:** None.
- **Response:**

```json
{ "sandboxSessionId": "b61b41f2-7c3d-4a5e-8f90-1a2b3c4d5e6f", "status": "CHECKPOINTED" }
```

- **Notes:**
  - Requires sandbox session management to be enabled.
  - Returns `501` if session management is unavailable.

#### `POST /api/agents/:id/sandbox-sessions/:sandboxSessionId/restore`

- **Description:** Resets the manual restore retry budget and attempts to restore a `CHECKPOINTED` sandbox session.
- **Request body:** None.
- **Query params:**
  - `async=true` starts restore and returns after the retry budget reset is accepted. Use this from browser flows that should not wait for container boot.
- **Success response:**

```json
{ "sandboxSessionId": "b61b41f2-7c3d-4a5e-8f90-1a2b3c4d5e6f", "status": "ACTIVE", "restoreAttempts": 0 }
```

- **Async success response (`202`):**

```json
{ "sandboxSessionId": "b61b41f2-7c3d-4a5e-8f90-1a2b3c4d5e6f", "status": "RESTORING", "restoreAttempts": 0 }
```

- **Error responses:**
  - `404` when the sandbox session does not exist or belongs to another agent.
  - `409` when the sandbox session is not `CHECKPOINTED`; response includes `{ "status": "ACTIVE" | "RESTORING" | "TERMINATED" }`.
  - `502` when restore was attempted but failed:

```json
{
  "error": "Restore failed",
  "code": "restore_failed",
  "category": "retryable",
  "detail": "connect ECONNREFUSED",
  "status": "CHECKPOINTED",
  "restoreAttempts": 1,
  "sandboxSessionId": "b61b41f2-7c3d-4a5e-8f90-1a2b3c4d5e6f"
}
```

- **Notes:** Manual restore is synchronous by default and may take long enough to create and bootstrap a sandbox container. Automatic restore budget exhaustion does not prevent this route from retrying; it resets `restoreAttempts` to `0` and clears `lastRestoreError` before recovery. When `async=true`, subsequent restore failure details are visible from turn readback (`restoreAttempts`, `lastRestoreError`, `sandboxStatus`).

#### `POST /api/agents/:id/sandbox-sessions/:sandboxSessionId/kill`

- **Description:** Terminates a sandbox session.
- **Request body:** None.
- **Query params:** None.
- **Response:** no body.
- **Notes:** Returns `204` on success.

#### `GET /api/conversations?status=active`

- **Description:** Lists active conversation summaries.
- **Response:** raw array.

```json
[
  {
    "id": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
    "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
    "status": "ACTIVE",
    "mode": "interactive",
    "turnCount": 2,
    "messageCount": 5,
    "taskDescription": "Summarize alerts",
    "startedAt": 1712140000000,
    "completedAt": null,
    "updatedAt": 1712140010000,
    "latestTurnId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
    "sandboxSessionId": "b61b41f2-7c3d-4a5e-8f90-1a2b3c4d5e6f",
    "totalTokens": 1840,
    "knownCostUsd": null,
    "incompleteCostTurnCount": 1,
    "tags": {}
  }
]
```

#### `GET /api/sandbox-sessions?status=active`

- **Description:** Lists active sandbox session rows after lifecycle readback
  reconciliation.
- **Response:** raw array.

```json
[
  {
    "id": "b61b41f2-7c3d-4a5e-8f90-1a2b3c4d5e6f",
    "conversationId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
    "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
    "status": "ACTIVE",
    "harnessName": "langgraph",
    "containerName": "stablehand-session-3f9a2c1e",
    "containerId": "9f8e7d6c5b4a",
    "checkpointRef": null,
    "createdAt": 1712140000000,
    "updatedAt": 1712140050000,
    "lastActivityAt": 1712140050000,
    "restoreOwnerId": null,
    "restoreFenceToken": 0,
    "restoreLeaseExpiresAt": null
  }
]
```

- **Notes:** Both active lifecycle routes accept only `status=active` (or an
  omitted status); other values return `400`.

### e. SSE Streaming

#### `GET /api/agents/:id/stream`

- **Description:** Opens a live SSE stream for one agent.
- **Request body:** None.
- **Query params:** `cursor` (optional zero-padded event cursor from a
  conversation snapshot; replay starts strictly after it).
- **Response:** `text/event-stream`.
- **Notes:**
  - Sends an initial `CONNECTED` event immediately, carrying `latestSeq`.
  - Streams the canonical AG-UI vocabulary (ADR-015): spec frame types plus
    `CUSTOM{name:'stablehand.*'}` for orchestrator signals, with stable
    `${turnId}-m${n}` message ids.
  - **Identity mapping:** AG-UI spec frames identify the run with the
    spec-owned names `runId`/`threadId`, and `runId` = `turnId`,
    `threadId` = `conversationId`. The `CUSTOM name: stablehand.*` events on the
    same stream use the canonical Stablehand names `turnId`/`conversationId`
    directly.
  - Accepts the `Last-Event-ID` header for replay. The SSE `id:` (and the
    snapshot `eventCursor`) is the durable global event `seq` rendered as a
    zero-padded string (e.g. `000000000042`); the padding is load-bearing —
    it keeps string comparison consistent with numeric order for
    lexicographic resume. Replay is served from the persisted event log
    (works past any in-memory cap and across orchestrator restarts).
  - Also emits `CUSTOM name: stablehand.sandbox_session.snapshot` events for
    active sandbox sessions when the connection opens.
  - `/api/events` rows for the run stream carry the canonical frame
    vocabulary; user-emitted custom events and system events are persisted
    verbatim.

Example initial frames:

```text
data: {"type":"CONNECTED","agentId":"1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e","latestSeq":41,"timestamp":1712140000000}

data: {"type":"CUSTOM","name":"stablehand.sandbox_session.snapshot","agentId":"1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e","conversationId":"d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20","sandboxSessionId":"b61b41f2-7c3d-4a5e-8f90-1a2b3c4d5e6f","activeTurnId":null,"status":"ACTIVE","harnessName":"langgraph","containerName":"stablehand-session-3f9a2c1e","timestamp":1712140001000}

id: 000000000042
data: {"type":"RUN_STARTED","runId":"7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04","threadId":"d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20","timestamp":1712140002000}

```

`RUN_STARTED` is a strict AG-UI frame: it carries only `runId`, `threadId`,
and `timestamp` (with `runId` = turn id and `threadId` = conversation id).

### f. Conversations & Messages

#### `GET /api/agents/:id/conversations`

- **Description:** Lists raw conversations for an agent.
- **Query params:** None.
- **Response:** raw array.

```json
[
  {
    "id": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
    "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
    "createdAt": 1712140000000,
    "updatedAt": 1712140050000
  }
]
```

- **Notes:** Use `/summary` for status, counts, and latest turn metadata.

#### `GET /api/agents/:id/conversations/summary`

- **Description:** Lists enriched conversation summaries.
- **Query params:** None.
- **Response:**

```json
{
  "conversations": [
    {
      "id": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
      "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
      "status": "COMPLETED",
      "mode": "interactive",
      "turnCount": 2,
      "messageCount": 5,
      "taskDescription": "Summarize alerts",
      "startedAt": 1712140000000,
      "completedAt": 1712140050000,
      "updatedAt": 1712140050000,
      "latestTurnId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
      "sandboxSessionId": null,
      "totalTokens": 1840,
      "knownCostUsd": 0.0042,
      "incompleteCostTurnCount": 0,
      "tags": {}
    }
  ]
}
```

- **Notes:** Conversation status is the SCREAMING_CASE lifecycle projection `ACTIVE | CHECKPOINTED | RESTORING | COMPLETED | ERROR | CANCELLED | IDLE` (sandbox-session statuses use `ACTIVE | CHECKPOINTED | RESTORING | TERMINATED`). `knownCostUsd` is `null` when no turn carries cost data — distinct from a real `0`.

#### `GET /api/agents/:id/conversations/:convId/snapshot`

- **Description:** Returns one consistent conversation snapshot. Install its messages first, then open the agent SSE stream with `?cursor=<eventCursor>` so events committed after that snapshot are replayed without gaps.
- **Query params:** None.
- **Response:** snapshot envelope.

```json
{
  "conversationId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
  "eventCursor": "000000000042",
  "messages": [
    {
      "id": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04-m0",
      "role": "user",
      "content": "Summarize alerts",
      "messageRevision": 0,
      "createdAt": 1712140000000
    },
    {
      "id": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04-m1",
      "role": "assistant",
      "content": "Here is the summary...",
      "messageRevision": 1,
      "toolCalls": [
        {
          "id": "tc_1",
          "name": "artifact_search",
          "args": "{\"query\":\"alerts\"}",
          "status": "complete"
        }
      ],
      "createdAt": 1712140005000
    }
  ]
}
```

- **Notes:** Returns `404` if the conversation does not belong to the agent. `eventCursor` is the zero-padded string form of the numeric durable event `seq` — the same form the SSE `id:` lines and `Last-Event-ID` use. Treat it as opaque and pass it back verbatim: the zero padding is load-bearing for lexicographic resume, and clients must not derive their own boundary. Tool-call `status` values in message `toolCalls` use the accepted legacy word-form `complete` (not `completed`).

### g. Human-in-the-Loop (interrupts)

#### `GET /api/interrupts`

- **Description:** Lists durable interrupt records across all agents for inbox and operations consumers. The database is the source of truth; a newly requested interrupt appears after persistence completes.
- **Query params:**
  - `status=pending|resolved|all` (default `pending`; `pending` includes still-actionable `timed_out` records)
  - `agentId` (optional exact filter)
  - `limit` (default `50`, maximum `200`)
  - `before` (optional exclusive `createdAt` epoch-millisecond cursor)
- **Response:**

```json
{
  "interrupts": [
    {
      "id": "9d7c5b3a-1e2f-4b8c-a4d6-8f0e2c4a6b8d",
      "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
      "turnId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
      "sandboxSessionId": "b61b41f2-7c3d-4a5e-8f90-1a2b3c4d5e6f",
      "toolCallId": "tc_1",
      "toolName": "approve_invoice",
      "args": { "invoiceId": "inv_9" },
      "status": "pending",
      "createdAt": 1712140000000,
      "expiresAt": 1712140300000,
      "resolvedAt": null,
      "resolvedAction": null
    }
  ],
  "nextBefore": 1712140000000
}
```

- **Notes:** Results are ordered newest-first. Pass `nextBefore` as `before` for the next page. The list deliberately excludes `resolvedData`, which is not exposed by the public interrupt APIs because it may be large or sensitive. The bundled client method is `client.interrupts.listAll(...)`.

#### `GET /api/agents/:id/interrupts`

- **Description:** Lists pending interrupts; can also include durable DB-backed pending records.
- **Query params:**
  - `includeResolved=true|false`
- **Response:**

```json
{
  "interrupts": [
    {
      "id": "9d7c5b3a-1e2f-4b8c-a4d6-8f0e2c4a6b8d",
      "turnId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
      "sandboxSessionId": "b61b41f2-7c3d-4a5e-8f90-1a2b3c4d5e6f",
      "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
      "toolCallId": "tc_1",
      "toolName": "approve_invoice",
      "args": { "invoiceId": "inv_9" },
      "createdAt": 1712140000000,
      "status": "pending"
    }
  ]
}
```

- **Notes:** `includeResolved=true` merges in durable pending records that are not currently in memory. `status` is one of `pending`, `resolved`, `resume_failed`, `timed_out`.

#### `POST /api/agents/:id/interrupt`

- **Description:** Resolves an interrupt.
- **Request body:**

```json
{
  "action": "approve",
  "interruptId": "9d7c5b3a-1e2f-4b8c-a4d6-8f0e2c4a6b8d",
  "data": { "comment": "Approved by ops" }
}
```

- **Query params:** None.
- **Response (`200`):**

```json
{ "resolved": true, "action": "approve" }
```

- **Response (`202` when the sandbox session is being resumed asynchronously):**

```json
{
  "accepted": true,
  "resuming": true,
  "action": "approve",
  "resumeAttemptId": "9c1d3e5f-7a2b-4c8d-9e0f-1a3b5c7d9e2f"
}
```

- **Notes:**
  - Allowed actions: `approve`, `reject`
  - An already-resolved interrupt returns `{ "alreadyResolved": true, "action": <recorded action or null> }`; the recorded `resolvedAction` vocabulary is `approve | reject | suspend | timeout`
  - Returns `404` when the interrupt does not belong to that agent

### h. Files & Workspace

#### `GET /api/agents/:id/files`

- **Description:** Lists directory contents in the agent workspace.
- **Query params:**
  - `path` (default `.`)
  - `conversationId` (optional durable conversation workspace)
- **Response:**

```json
{
  "entries": [
    { "name": "README.md", "type": "file", "sizeBytes": 1240 },
    { "name": "notes", "type": "directory", "sizeBytes": 4096 }
  ]
}
```

- **Notes:**
  - Hidden files, `node_modules`, and blocked paths are excluded.
  - Path traversal and sensitive path patterns are rejected with `403`.

#### `GET /api/agents/:id/files/read`

- **Description:** Reads a text file from the agent workspace.
- **Query params:**
  - `path` (required)
  - `conversationId` (optional)
- **Response:**

```json
{
  "path": "README.md",
  "content": "# Workspace\n",
  "sizeBytes": 12
}
```

- **Notes:**
  - Max file size is `50 KB`. Larger files return `400` with
    `{ "error": "File too large", "code": "file_too_large", "sizeBytes": <actual>, "maxSizeBytes": 51200 }`.
  - Returns `400` for directories.

#### `POST /api/agents/:id/files`

- **Description:** Creates a file in the agent workspace.
- **Query params:** `conversationId` (optional)
- **Request body:**

```json
{
  "path": "notes/todo.txt",
  "content": "Review the API docs"
}
```

- **Response:**

```json
{ "path": "notes/todo.txt", "sizeBytes": 19 }
```

- **Notes:** Parent directories are created automatically.

#### `PUT /api/agents/:id/files`

- **Description:** Updates an existing file.
- **Query params:** `conversationId` (optional)
- **Request body:**

```json
{
  "path": "notes/todo.txt",
  "content": "Review the API docs and SSE examples"
}
```

- **Response:**

```json
{ "path": "notes/todo.txt", "sizeBytes": 36 }
```

- **Notes:** Returns `404` if the file does not exist.

#### `DELETE /api/agents/:id/files`

- **Description:** Deletes a file.
- **Query params:**
  - `path` (required)
  - `conversationId` (optional)
- **Response:** no body.
- **Notes:** Returns `204` on success and `404` if the file does not exist.

#### `POST /api/agents/:id/workspace`

- **Description:** Replaces the agent's base workspace with a gzipped tarball.
- **Request body:** raw tarball bytes.
- **Headers:**
  - `Content-Type: application/gzip` or `application/x-gzip`
- **Query params:**
  - `force=true` to kill active sandbox sessions first
- **Response (`201`):**

```json
{
  "revision": 3,
  "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "fileCount": 12,
  "totalBytes": 18234,
  "appliedAt": 1712140000000
}
```

- **Notes:**
  - Rejects uploads unless the content type is gzip.
  - If the agent has active sandbox sessions, returns `409` unless `force=true`.
  - Maximum upload size is controlled by `maxTarUploadBytes` in `/api/settings`.
  - The replacement is atomic: Stablehand extracts to a temp dir and swaps it into place.

### i. Secrets

#### `GET /api/agents/:id/secrets`

- **Description:** Lists stored secret keys for an agent.
- **Query params:** None.
- **Response:**

```json
{ "keys": ["OPENAI_API_KEY", "CRM_TOKEN"] }
```

- **Notes:** Secret values are never returned.

#### `POST /api/agents/:id/secrets`

- **Description:** Stores or overwrites a secret.
- **Request body:**

```json
{
  "key": "CRM_TOKEN",
  "value": "secret-value"
}
```

- **Query params:** None.
- **Response:**

```json
{ "key": "CRM_TOKEN" }
```

- **Notes:** Returns `501` if secret storage is not configured.

#### `DELETE /api/agents/:id/secrets/:key`

- **Description:** Deletes a secret.
- **Query params:** None.
- **Response:** no body.
- **Notes:** Returns `204` on success.

### j. Webhooks

#### `POST /api/agents/:id/webhooks`

- **Description:** Registers a webhook subscription.
- **Request body:**

```json
{
  "url": "https://example.com/stablehand/webhook",
  "events": ["turn.started", "custom.eval.verdict"],
  "secret": "required-shared-secret"
}
```

- **Query params:** None.
- **Response:**

```json
{
  "id": "5e3a1c9b-7d6f-4e2a-b8c0-4d2f6a8e0c1b",
  "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "url": "https://example.com/stablehand/webhook",
  "events": ["turn.started", "custom.eval.verdict"],
  "hasSecret": true,
  "active": true,
  "createdAt": 1712140000000,
  "updatedAt": 1712140000000
}
```

- **Notes:** Valid event names are the built-in names listed in [Webhook Events](#6-webhook-events) or canonical custom names matching `^custom\.[a-z0-9][a-z0-9_.-]{0,126}$`. The signing secret is required on create, accepted only on write, and represented as `hasSecret` on reads.

#### `GET /api/agents/:id/webhooks`

- **Description:** Lists active webhooks for the agent.
- **Query params:** None.
- **Response:** raw array.

```json
[
  {
    "id": "5e3a1c9b-7d6f-4e2a-b8c0-4d2f6a8e0c1b",
    "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
    "url": "https://example.com/stablehand/webhook",
    "events": ["turn.started", "turn.completed"],
    "hasSecret": true,
    "active": true,
    "createdAt": 1712140000000,
    "updatedAt": 1712140000000
  }
]
```

- **Notes:** Returns only active webhooks.

#### `PATCH /api/agents/:id/webhooks/:webhookId`

- **Description:** Updates a webhook subscription for the agent.
- **Request body:**

```json
{
  "url": "https://example.com/stablehand/webhook",
  "events": ["turn.completed", "message.committed"],
  "secret": "optional-shared-secret"
}
```

- **Query params:** None.
- **Response:** updated webhook object.
- **Notes:** Returns `404` when the webhook does not belong to the agent.

#### `DELETE /api/agents/:id/webhooks/:webhookId`

- **Description:** Deletes a webhook subscription.
- **Query params:** None.
- **Response:** no body.
- **Notes:** Returns `204` on success. Returns `404` when the webhook does not belong to the agent.

### k. Feedback

#### `POST /api/agents/:id/feedback`

- **Description:** Emits a thumbs-up or thumbs-down feedback event for a conversation. External learning modules can subscribe to `feedback.received` through the event/webhook surfaces.
- **Request body:**

```json
{
  "conversationId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
  "messageId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04-m1",
  "type": "thumbs_up",
  "comment": "Good answer"
}
```

- **Query params:** None.
- **Response:**

```json
{
  "feedbackId": "6b8d0f2a-4c6e-4a8b-9d1c-3e5a7c9e1b4d",
  "type": "thumbs_up",
  "turnId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04"
}
```

- **Notes:** The endpoint does not persist feedback analytics or run an in-process learner. Register a webhook for `feedback.received` when an external learning service needs the signal.

### l. Settings (`/api/settings`)

#### `GET /api/settings`

- **Description:** Returns current system settings.
- **Query params:** None.
- **Response:**

```json
{
  "maxWorkspaceTarBytes": 104857600,
  "maxTarUploadBytes": 104857600,
  "idleTimeoutMs": 300000,
  "turnTimeoutMs": 1800000,
  "reconciliationIntervalMs": 300000,
  "maxGlobalContainers": 20,
  "queueTimeoutMs": 600000,
  "maxConcurrentSessionsPerAgent": 3,
  "maxTriggerDepth": 5,
  "defaultCpus": 1,
  "defaultMemoryMb": 1024,
  "defaultPidsLimit": 256,
  "defaultTimeoutSec": 43200
}
```

- **Notes:**
  - This endpoint only exists when the settings service is configured.

#### `PUT /api/settings`

- **Description:** Updates one or more runtime settings.
- **Request body:** any subset of the supported fields.

```json
{
  "maxConcurrentSessionsPerAgent": 5,
  "queueTimeoutMs": 1200000,
  "defaultCpus": 1.5,
  "defaultMemoryMb": 2048
}
```

- **Query params:** None.
- **Response:** full updated settings object.
- **Notes:** Validation ranges:

| Field | Range |
|---|---|
| `maxWorkspaceTarBytes` | `1 MiB` to `1024 MiB` |
| `maxTarUploadBytes` | `1 MiB` to `1024 MiB` |
| `idleTimeoutMs` | `10000` to `3600000` |
| `turnTimeoutMs` | `30000` to `7200000` |
| `reconciliationIntervalMs` | `10000` to `3600000` |
| `maxGlobalContainers` | `1` to `100` |
| `queueTimeoutMs` | `5000` to `1800000` |
| `maxConcurrentSessionsPerAgent` | `1` to `20` |
| `maxTriggerDepth` | `1` to `20` |
| `defaultCpus` | `0.1` to `16.0` |
| `defaultMemoryMb` | `128` to `32768` |
| `defaultPidsLimit` | `32` to `2048` |
| `defaultTimeoutSec` | `60` to `3600` |

### m. Artifacts (`/api/artifacts`)

#### `GET /api/artifacts`

- **Description:** Lists artifacts globally, by agent, or by turn.
- **Query params:**
  - `agentId`
  - `turnId`
  - `limit` (default `100`)
  - `offset` (default `0`)
  - `search` (global listing only)
- **Response:** always `{ artifacts: [...], total }`; for filtered lists,
  `total` is the filtered count.

```json
{
  "artifacts": [
    {
      "id": "3a1c5e7f-2b4d-4d6e-9c8b-0f1e2d3c4b5a",
      "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
      "turnId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
      "conversationId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
      "name": "summary.pdf",
      "mimeType": "application/pdf",
      "sizeBytes": 23456,
      "storageKey": "artifacts/3a1c5e7f-2b4d-4d6e-9c8b-0f1e2d3c4b5a/summary.pdf",
      "bucket": "stablehand-artifacts",
      "kind": "eval_report",
      "metadata": { "suite": "weekly" },
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "status": "active",
      "expiresAt": null,
      "createdAt": 1712140000000,
      "updatedAt": 1712140000000
    }
  ],
  "total": 1
}
```

- **Notes:** `turnId` takes precedence when provided.

#### `GET /api/artifacts/:id`

- **Description:** Gets artifact metadata.
- **Query params:** None.
- **Response:** artifact object.
- **Notes:** Returns `404` if the artifact does not exist.

#### `GET /api/artifacts/:id/download`

- **Description:** Downloads artifact bytes.
- **Query params:** None.
- **Response:** raw file bytes.
- **Notes:** Sets `Content-Type`, `Content-Disposition`, and `Content-Length`. Returns `409` while a signed-upload artifact is still `pending_upload`.

#### `GET /api/artifacts/:id/download-url`

- **Description:** Returns a signed download URL.
- **Query params:**
  - `expiresInSec` seconds, capped at `86400`
- **Response:**

```json
{
  "url": "https://storage.example.com/signed-download",
  "expiresInSec": 3600,
  "name": "summary.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 23456
}
```

- **Notes:** Good for browser-side downloads without proxying file bytes through your app. Returns `409` while a signed-upload artifact is still `pending_upload`; the server confirms the upload from object-storage metadata before issuing the download URL.

#### `POST /api/artifacts/upload-url`

- **Description:** Pre-registers an artifact and returns a signed upload URL.
- **Request body:**

```json
{
  "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "name": "summary.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 23456,
  "kind": "eval_report",
  "metadata": { "suite": "weekly" },
  "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

- **Query params:** None.
- **Response:**

```json
{
  "artifactId": "3a1c5e7f-2b4d-4d6e-9c8b-0f1e2d3c4b5a",
  "uploadUrl": "https://storage.example.com/signed-upload",
  "storageKey": "artifacts/3a1c5e7f-2b4d-4d6e-9c8b-0f1e2d3c4b5a/summary.pdf",
  "expiresInSec": 3600
}
```

- **Notes:** `kind` is optional and must match `^[a-z0-9][a-z0-9_-]{0,63}$`. `metadata` is an optional JSON object capped at 16 KiB after UTF-8 serialization. `sha256` is optional and, when present, must be exactly 64 lowercase hexadecimal characters. REST and signed-upload callers attest that hash: the orchestrator stores it but does not stream or verify artifact bytes. The sandbox daemon instead computes the authoritative SHA-256 incrementally as it streams an `artifact_upload` to object storage. Artifacts created before this field, and callers that omit it, continue to return a null or absent hash; integrity-sensitive consumers must rehash downloaded bytes before trusting them. The metadata row starts as `pending_upload` and is hidden from list endpoints until the object exists and a download/download-url request confirms it. Registration emits `artifact.created`; that event means metadata was registered, not that a signed-upload object is already readable. Direct multipart upload is available at `POST /api/artifacts/upload` with `kind`, JSON-encoded `metadata`, and uploader-attested `sha256` form fields. Daemon-side `artifact_upload` accepts `kind` and `metadata` and supplies its computed hash automatically. Artifact object keys are globally scoped by artifact ID, not by agent ID, so deleting an agent does not imply artifact-object cleanup. Bundled clients can call `client.artifacts.requestUploadUrl(...)`.

#### `DELETE /api/artifacts/:id`

- **Description:** Deletes artifact metadata and removes the backing object.
- **Query params:** None.
- **Response:** no body.
- **Notes:** Returns `204` on success and `404` if the artifact does not
  exist. If the backing object cannot be removed, returns `503` with
  `{ "error": "Artifact object delete failed", "artifactId": <id> }` and
  leaves the metadata row in `delete_failed`. Deletion emits the
  `artifact.deleted` event.

### n. Events (`/api/events`)

#### `GET /api/events`

- **Description:** Lists persisted events with cursor pagination.
- **Query params:**
  - `cursor`
  - `limit` (default `50`, max `200`)
  - `type`
  - `agentId`
  - `turnId`
  - `conversationId`
  - `since` (epoch milliseconds)
- **Response:**

```json
{
  "events": [
    {
      "seq": 912,
      "type": "turn.completed",
      "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
      "turnId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
      "conversationId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
      "payload": "{\"turnId\":\"7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04\",\"status\":\"COMPLETED\"}",
      "createdAt": 1712140000000
    }
  ],
  "nextCursor": 912
}
```

- **Notes:** Events are returned newest-first; pass `nextCursor` to fetch older pages. `turnId` and `conversationId` compose with every other filter and use durable event-spine columns, so consumers do not need to parse `payload`. Historical rows written without correlation columns are not retroactively inferred. Bundled clients can call `client.events.list(...)`.

#### `GET /api/events/stats`

- **Description:** Returns aggregate event stats.
- **Query params:**
  - `range`: `1h`, `24h` (default), or `7d`
- **Response:**

```json
{
  "total": 120,
  "byType": {
    "turn.started": 30,
    "turn.completed": 30,
    "tool_call.started": 60
  },
  "topAgents": [
    { "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e", "count": 40 }
  ],
  "recentRate": 2.4
}
```

- **Notes:** `recentRate` is events per minute over the last 5 minutes.

#### `GET /api/events/types`

- **Description:** Lists distinct persisted event types.
- **Query params:** None.
- **Response:**

```json
{ "types": ["turn.started", "turn.completed", "tool_call.started"] }
```

- **Notes:** Useful for building filters in dashboards.

### o. Triggers (`/api/triggers`)

#### `POST /api/triggers`

- **Description:** Creates an event trigger.
- **Request body:**

```json
{
  "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "eventType": "turn.completed",
  "selector": { "status": "COMPLETED" },
  "taskTemplate": "Review output from turn {{payload.turnId}}",
  "enabled": true
}
```

- **Query params:** None.
- **Response:** trigger object.
- **Task template:** `taskTemplate` becomes the run's task. Placeholders read the
  matching event's payload; for `custom.*` and `emit-event` events the caller's
  fields are merged in at the top level, so `{{payload.analysis}}` works either way.
  - `{{payload}}` renders the whole payload as compact JSON.
  - `{{payload.field}}` renders one field; dotted paths reach nested fields and
    array items, e.g. `{{payload.summary.title}}` or `{{payload.items.0.name}}`.
  - Strings render as-is, numbers and booleans as text, objects and arrays as
    compact JSON.
  - A missing or `null` field leaves its placeholder unchanged.
- **Notes:** Returns `404` if `agentId` does not exist. A matching event starts a
  **background** run on the agent, so its `mode` must be `background` or `both`.
  When the run cannot start, the firing is recorded as failed (see
  `GET /api/triggers/failures`) and a `trigger.failed` event is published.
  Refusals that retrying cannot fix (`agent_mode_not_allowed`, `budget_exceeded`,
  `tag_conflict`, `tag_not_provisioned`, `trigger_target_not_found`,
  `trigger_target_misconfigured`, `invalid_trigger_input`) fail on the first
  attempt. Other errors, such as `queue_full`, are retried with backoff for about
  ten minutes first. Either way, later events keep flowing.

#### `GET /api/triggers/failures`

- **Description:** Lists trigger firings that did not start a run, newest first.
- **Query params:** `triggerId` (optional), `agentId` (optional, the trigger's
  target agent), `limit` (optional, 1–500, default 100).
- **Response:**

```json
{
  "failures": [
    {
      "id": "8d0f5f8e-3c1a-4e57-9d2b-6a1c0e7b4f21",
      "triggerId": "2f4e6d8c-0a1b-4c3d-9e5f-7a9b1d3f5c7e",
      "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
      "eventType": "analysis.complete",
      "eventSeq": 48213,
      "errorCode": "agent_mode_not_allowed",
      "error": "Agent mode \"interactive\" does not allow background turns",
      "attempts": 1,
      "createdAt": 1761134400000
    }
  ]
}
```

- **Notes:** `attempts` is 1 for immediate refusals and the retry count when
  retries ran out (`error` then starts with `Gave up after N attempts:`). Failed
  firings are not replayed automatically: fix the cause and emit the event again.
  Deleting a trigger deletes its failure history. Returns `400` for an invalid
  `limit`.

#### `GET /api/triggers`

- **Description:** Lists triggers.
- **Query params:** `agentId` (optional)
- **Response:** raw array.

```json
[
  {
    "id": "2f4e6d8c-0a1b-4c3d-9e5f-7a9b1d3f5c7e",
    "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
    "eventType": "turn.completed",
    "selector": { "status": "COMPLETED" },
    "taskTemplate": "Review output from turn {{payload.turnId}}",
    "enabled": true,
    "createdAt": 1712140000000
  }
]
```

- **Notes:** Filter server-side with `agentId` when you only need one agent's triggers. `createdAt` is epoch milliseconds.

#### `GET /api/triggers/:id`

- **Description:** Gets one trigger.
- **Query params:** None.
- **Response:** trigger object.
- **Notes:** Returns `404` if not found.

#### `PUT /api/triggers/:id`

- **Description:** Updates a trigger.
- **Request body:**

```json
{
  "enabled": false,
  "taskTemplate": "Updated template"
}
```

- **Query params:** None.
- **Response:** updated trigger object.
- **Notes:** Returns `404` if not found.

#### `DELETE /api/triggers/:id`

- **Description:** Deletes a trigger.
- **Query params:** None.
- **Response:** no body.
- **Notes:** Returns `204` on success and `404` if not found.

#### `POST /api/triggers/emit`

- **Description:** Emits a custom event into the trigger system.
- **Request body:**

```json
{
  "type": "custom.build.completed",
  "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "payload": { "buildId": "b_9", "status": "success" }
}
```

- **Query params:** None.
- **Response:**

```json
{ "ok": true, "type": "custom.build.completed" }
```

- **Errors:**
  - An oversized payload returns `413` with the standard envelope:

```json
{
  "error": "Custom event payload is 301234 bytes; the limit is 262144 bytes (256 KiB) of serialized JSON. Put larger content in an artifact or behind a URL and send its id or URL in the payload instead.",
  "code": "custom_event_payload_too_large",
  "maxBytes": 262144,
  "sizeBytes": 301234
}
```

  - An invalid body returns `400` with validation issues:

```json
{
  "error": "Invalid custom event",
  "code": "invalid_custom_event",
  "issues": [
    { "path": "type", "message": "Invalid custom event name" }
  ]
}
```

  - When the canonical ingest lane is backed up, the emit is refused at the
    ingress with `429` and a `Retry-After` header, **before** anything is
    enqueued — the caller owns the retry:

```json
{
  "error": "Canonical ingest lane is full (2000/2000 pending). Retry later.",
  "code": "ingest_queue_full",
  "depth": 2000,
  "limit": 2000,
  "retryAfterSec": 5
}
```

    This is the same envelope family as the turn-start throttles
    (`queue_full`, `dispatch_stalled`): `error` is the human sentence,
    `code` the machine token, and `retryAfterSec` mirrors `Retry-After`.

- **Notes:** `type` must match `^custom\.[a-z0-9][a-z0-9_.-]{0,126}$`. `payload` must be a JSON object and may not exceed 256 KiB (262,144 bytes) after UTF-8 JSON serialization (raised from 32 KiB). Larger content, such as a full report or dataset, should not ride on the event: upload it as an artifact owned by the trigger's target agent (`POST /api/artifacts/upload` with that `agentId`) and send `{ "artifactId": "…" }`, which the run can fetch with `artifact_download`, or send an HTTPS URL the run can reach. Every event row stores the payload twice and replays read rows in batches, so references keep the event log small. `agentId` is optional for global trigger events, but must be supplied for delivery to agent-scoped webhook subscriptions. Events are durably persisted before the success response. Bundled clients can call `client.events.emitCustom(...)`.

Schedules are clocks over this same custom-event entrypoint. They never start
runs directly: a scheduled fire is durably emitted, then matching event
triggers and `custom.*` webhook subscriptions consume it through their normal
paths. This keeps trigger selectors, cascade caps, webhook signing, and event
history identical for manual and scheduled emissions.

### p. Schedules (`/api/schedules`)

#### `POST /api/schedules`

- **Description:** Persists a recurring Croner schedule and starts its in-process clock.
- **Request body:**

```json
{
  "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "name": "weekly-canary",
  "cronExpression": "0 9 * * 1",
  "timezone": "America/New_York",
  "eventType": "custom.schedule.weekly-canary",
  "payload": { "probe": "close-readiness" },
  "enabled": true
}
```

- **Response:** `201` with the schedule object:

```json
{
  "id": "8a6c4e2d-3b5f-4d7a-8c9e-1f3d5b7a9c0e",
  "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "name": "weekly-canary",
  "cronExpression": "0 9 * * 1",
  "timezone": "America/New_York",
  "eventType": "custom.schedule.weekly-canary",
  "payload": { "probe": "close-readiness" },
  "enabled": true,
  "createdAt": 1785081600000,
  "updatedAt": 1785081600000,
  "lastFiredAt": null,
  "missedFireCount": 0,
  "nextRunAt": 1785157200000
}
```

- **Defaults:** `timezone` is `UTC`, `payload` is `{}`, and `enabled` is `true`.
- **Validation:** `agentId` is optional; when supplied it must identify an existing agent and scopes webhook routing and lifecycle cleanup, while omission creates a global custom-event clock. `name` is globally unique; `eventType` and `payload` use the canonical custom-event grammar and 256 KiB cap. Cron validation is delegated to Croner, including its standard five-, six-, and seven-part patterns and recurring nicknames, but ISO one-shot dates are rejected. Invalid expressions or IANA timezones return `400`; duplicate names return `409`; oversized payloads return the same typed `413` as `/api/triggers/emit`.

#### `GET /api/schedules`

- **Description:** Lists every persisted schedule in creation order.
- **Response:** `{ "schedules": [...] }`.
- **Notes:** Every item includes a server-computed `nextRunAt` epoch-milliseconds timestamp. It is `null` when the schedule is disabled.

#### `GET /api/schedules/:id`

- **Description:** Gets one schedule, including `nextRunAt`.
- **Response:** schedule object.
- **Notes:** Returns `404` if not found.

#### `PATCH /api/schedules/:id`

- **Description:** Atomically persists a non-empty partial update, then stops/replaces the affected Croner job.
- **Request body:** Any non-empty subset of `name`, `cronExpression`, `timezone`, `eventType`, `payload`, or `enabled`.
- **Response:** updated schedule object.
- **Notes:** Schedule scope is immutable: an omitted `agentId` remains global, and a supplied `agentId` cannot be reassigned. Disabling a schedule stops future fires and returns `nextRunAt: null`. The same validation and error statuses as create apply.

#### `DELETE /api/schedules/:id`

- **Description:** Deletes the persisted schedule and stops its Croner job.
- **Response:** no body (`204`).
- **Notes:** Returns `404` if not found.

#### Delivery and restart semantics

- Enabled schedules are rehydrated from PostgreSQL during orchestrator startup.
- `lastFiredAt` advances only after the custom event is durably accepted; a failed emission is logged and leaves it unchanged.
- Fires missed while the orchestrator is down are skipped. There is no catch-up queue. Consumers that cannot tolerate gaps should reconcile current state on every fire rather than treating each tick as an irreplaceable command.
- Croner overrun protection skips a new local invocation while the prior one is still running. Its timezone/DST behavior applies: nonexistent local times are skipped and repeated local times fire once.
- The scheduler assumes one orchestrator replica. A multi-replica deployment needs a database-owned scheduler such as `pg-boss`; do not run this in-process scheduler concurrently in multiple replicas.
- Bundled clients use `client.schedules.list/get/create/update/delete(...)`. The operational CLI exposes the corresponding `schedules` commands.
- Schedules are explicit control-plane resources. The old, non-executable `spec.triggers[].schedule` manifest shape is not accepted; create schedules through this API, the bundled client, or the CLI.
- Hard-deleting an agent first stops and drains its agent-scoped schedule fires; the database then removes those schedule rows with the rest of the agent-owned state. Global schedules are unaffected.

### q. Catalogs & Tools (`/api/catalogs`)

#### `GET /api/catalogs/tools`

- **Description:** Lists known tool definitions across agents and the tool registry.
- **Query params:** None.
- **Response:** raw array.

```json
[
  {
    "name": "artifact_upload",
    "description": "Upload an artifact",
    "source": "local",
    "builtin": true,
    "location": "daemon",
    "requiresApproval": false,
    "inputSchema": {
      "type": "object"
    }
  }
]
```

- **Notes:** `location` is one of `sandbox`, `orchestrator`, or `daemon`. Daemon tools such as `artifact_upload` and `artifact_download` talk directly to object storage instead of proxying bytes through the API.

#### `POST /api/catalogs/tools/test`

- **Description:** Executes a tool in a sandbox-free test context.
- **Request body:**

```json
{
  "toolName": "web_search",
  "input": { "query": "stablehand api reference" }
}
```

- **Query params:** None.
- **Response:**

```json
{
  "success": true,
  "result": "...tool output...",
  "durationMs": 421
}
```

- **Notes:**
  - The tool must exist and support execution.
  - Time limit is `30s`.
  - An invalid body returns `400` with the standard envelope
    `{ "error": <human message>, "code": "invalid_tool_test_request" }`,
    not a success-flagged test result.

### r. Sandbox Metrics (`/api/sandbox`)

#### `GET /api/sandbox/metrics`

- **Description:** Returns in-memory container metrics.
- **Query params:** None.
- **Response:**

```json
{
  "executionMode": "sandbox",
  "containers": {
    "active": 2,
    "queued": 1,
    "peak": 5,
    "totalCreated": 37,
    "byHarness": {
      "langgraph": 20,
      "claude-agents": 17
    },
    "averageLifetimeMs": 84213
  },
  "limits": {
    "maxGlobalContainers": 20
  }
}
```

- **Notes:** Only available when sandbox container management is enabled.

### s. Scoped Access Keys (`/api/keys`)

All key-management routes require the master `STABLEHAND_API_TOKEN`. A scoped key
receives `403` with `requiredCapability: null` on these routes, even if it holds
every grant.

#### `POST /api/keys`

- **Description:** Creates a named scoped key. The plaintext token is returned
  by this response only.
- **Request body:**

```json
{
  "name": "artifact-gallery-prod",
  "capabilities": ["artifacts:read", "webhooks:manage"],
  "note": "Production artifact gallery",
  "expiresAt": null
}
```

- **Response:** `201 Created` with `Cache-Control: no-store`.

```json
{
  "id": "key_e5d3c1b9-a7f6-4c4e-8b2a-0d9c7e5f3a1b",
  "name": "artifact-gallery-prod",
  "capabilities": ["artifacts:read", "webhooks:manage"],
  "note": "Production artifact gallery",
  "status": "active",
  "createdAt": 1786665600000,
  "createdBy": "master",
  "expiresAt": null,
  "lastUsedAt": null,
  "revokedAt": null,
  "token": "cmk_<43-base62-characters>"
}
```

- **Validation:** `name` is 1–128 lowercase alphanumeric or hyphen characters
  and must start alphanumeric. `capabilities` contains 1–32 unique valid grants.
  `expiresAt` is `null`, omitted, or a future epoch-millisecond timestamp. `note`
  is optional and at most 1024 characters.
- **Errors:** `400` with `code: "invalid_api_key_request"` and `issues: [{ "path": "...", "message": "..." }]` for an invalid request; `409` for a duplicate name.
- **Security:** Stablehand stores only the SHA-256 token hash. Losing the returned
  token requires rotation; it cannot be fetched later.

#### `GET /api/keys`

- **Description:** Lists key metadata and computed lifecycle status. Never
  returns plaintext tokens or hashes.
- **Response:**

```json
{
  "keys": [
    {
      "id": "key_e5d3c1b9-a7f6-4c4e-8b2a-0d9c7e5f3a1b",
      "name": "artifact-gallery-prod",
      "capabilities": ["artifacts:read", "webhooks:manage"],
      "note": "Production artifact gallery",
      "status": "active",
      "createdAt": 1786665600000,
      "createdBy": "master",
      "expiresAt": null,
      "lastUsedAt": 1786665660000,
      "revokedAt": null
    }
  ]
}
```

- **Notes:** `status` is `active`, `expired`, or `revoked`. `lastUsedAt` means
  last successful authentication, not necessarily a route-authorized request,
  and is write-debounced to at most once per minute.

#### `DELETE /api/keys/:id`

- **Description:** Soft-revokes a key and returns its updated metadata.
- **Errors:** `404` when the key ID does not exist.
- **Notes:** New requests fail with `401`. Scoped SSE and AG-UI streams recheck
  liveness on their 15-second heartbeat and close. Revocation does not cancel
  running turns or remove resources the key previously created; see
  [Scoped API keys](scoped-api-keys.md#expiration-use-rotation-and-revocation).

## 5. SSE Streaming Protocol

- **Connection:** `GET /api/agents/:id/stream`
- **Wire format:**

```text
id: <event-id>
data: <json>

```

- **Initial connect event:**

```json
{ "type": "CONNECTED", "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e", "latestSeq": 41, "timestamp": 1712140000000 }
```

`latestSeq` is the newest durable event sequence at connect time; compare it
with your last processed cursor to decide whether replay is needed.

- **Common event types:**
  - `RUN_STARTED`
  - `RUN_FINISHED`
  - `RUN_ERROR`
  - `TEXT_MESSAGE_START`
  - `TEXT_MESSAGE_CONTENT`
  - `TEXT_MESSAGE_END`
  - `TOOL_CALL_START`
  - `TOOL_CALL_ARGS`
  - `TOOL_CALL_END`
  - `TOOL_CALL_RESULT`
  - `STATE_DELTA`
  - `MESSAGES_SNAPSHOT`
  - `CUSTOM`

Notes on actual stream behavior today:

- `CONNECTED` and `CUSTOM name: stablehand.sandbox_session.snapshot` are emitted
  by the stream endpoint itself.
- Turn acceptance, durable message commits, and interrupts use
  `CUSTOM.name`: `stablehand.turn.pending`, `stablehand.message.committed`,
  `stablehand.interrupt.requested`, and `stablehand.interrupt.resolved`.
- `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `TEXT_MESSAGE_*`,
  `TOOL_CALL_*`, `STATE_DELTA`, `MESSAGES_SNAPSHOT`, and `CUSTOM` can appear
  on the live stream.

### Connection lifecycle

- Initial `CONNECTED` event is sent immediately.
- If the agent has active sandbox sessions, the stream starts with
  `CUSTOM name: stablehand.sandbox_session.snapshot` events.
- Heartbeat comments are sent every **15 seconds**:

```text
: heartbeat

```

- A scoped-key stream revalidates expiry/revocation on each heartbeat and
  closes when the key is no longer live.
- Idle connections are closed after **5 minutes** without events.
- Reconnect using the standard SSE `Last-Event-ID` header.

### History & replay

- Canonical frames are persisted in `event_store` before fan-out.
- Reconnect with the last global sequence in `Last-Event-ID`; replay survives
  process restarts.
- Retention is an operational policy over completed-turn AG-UI frames, not an
  in-memory replay cap.

### Event examples

AG-UI spec frames (`RUN_*`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `STATE_DELTA`,
`MESSAGES_SNAPSHOT`) are strict: they identify the run only through the
spec-owned `runId`/`threadId` pair, where `runId` = `turnId` and
`threadId` = `conversationId`. The `CUSTOM name: stablehand.*` events use the
canonical `turnId`/`conversationId` names directly. Spec frames also keep the
spec-owned field name `toolCallName`; stablehand-owned surfaces (REST, webhooks,
`stablehand.*` custom events) use `toolName`.

`stablehand.turn.pending`

```json
{
  "type": "CUSTOM",
  "name": "stablehand.turn.pending",
  "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "turnId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
  "conversationId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
  "mode": "interactive",
  "timestamp": 1712140000000
}
```

`RUN_STARTED`

```json
{
  "type": "RUN_STARTED",
  "runId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
  "threadId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
  "timestamp": 1712140000000
}
```

`TEXT_MESSAGE_CONTENT`

```json
{
  "type": "TEXT_MESSAGE_CONTENT",
  "runId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
  "threadId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
  "messageId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04-m1",
  "delta": "Here is the summary...",
  "timestamp": 1712140000100
}
```

`TOOL_CALL_START`

```json
{
  "type": "TOOL_CALL_START",
  "runId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
  "threadId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
  "toolCallId": "tc_1",
  "toolCallName": "artifact_search",
  "timestamp": 1712140000200
}
```

`TOOL_CALL_ARGS`

```json
{
  "type": "TOOL_CALL_ARGS",
  "runId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
  "threadId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
  "toolCallId": "tc_1",
  "delta": "{\"query\":\"alerts\"}",
  "timestamp": 1712140000201
}
```

`TOOL_CALL_RESULT`

```json
{
  "type": "TOOL_CALL_RESULT",
  "runId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
  "threadId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
  "toolCallId": "tc_1",
  "result": "2 matching artifacts",
  "durationMs": 180,
  "timestamp": 1712140000400
}
```

`stablehand.message.committed`

```json
{
  "type": "CUSTOM",
  "name": "stablehand.message.committed",
  "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "turnId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
  "conversationId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
  "messageId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04-m1",
  "messageSeq": 4,
  "role": "assistant",
  "content": "Here is the summary...",
  "toolCalls": [],
  "timestamp": 1712140000500
}
```

`RUN_FINISHED`

```json
{
  "type": "RUN_FINISHED",
  "runId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
  "threadId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
  "status": "completed",
  "usage": null,
  "timestamp": 1712140000600
}
```

`RUN_FINISHED.status` uses the AG-UI-side lowercase vocabulary
`completed | error | cancelled`; REST and webhooks serve the SCREAMING
TurnStatus.

### JavaScript example

```js
const agentId = "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e";
const es = new EventSource(`http://localhost:3002/api/agents/${agentId}/stream`);

es.onmessage = (event) => {
  const payload = JSON.parse(event.data);

  switch (payload.type) {
    case "CONNECTED":
      console.log("connected", payload.agentId);
      break;
    case "RUN_STARTED":
      console.log("run started", payload.runId);
      break;
    case "TEXT_MESSAGE_CONTENT":
      process.stdout.write(payload.delta || "");
      break;
    case "TOOL_CALL_START":
      console.log("tool start", payload.toolCallName);
      break;
    case "TOOL_CALL_RESULT":
      console.log("tool result", payload.result);
      break;
    case "CUSTOM":
      if (payload.name === "stablehand.interrupt.requested") {
        console.log("approval required", payload.interruptId, payload.toolName);
      }
      break;
    case "RUN_FINISHED":
    case "RUN_ERROR":
      console.log("run ended", payload.type, payload.error || "");
      break;
  }
};

es.onerror = (err) => {
  console.error("stream error", err);
};
```

## 6. Webhook Events

### Valid subscription event names

- `turn.started`
- `turn.completed`
- `turn.cancelled`
- `tool_call.started`
- `tool_call.completed`
- `interrupt.requested`
- `interrupt.resolved`
- `message.committed`
- `message.updated`
- `feedback.received`
- `budget.threshold`
- `artifact.created`
- `artifact.deleted`
- `agent.deleted`
- any experimental extension event matching `^custom\.[a-z0-9][a-z0-9_.-]{0,126}$`

### Delivery format

Webhook deliveries are HTTP `POST` requests with:

- `Content-Type: application/json`
- `X-Agent-Id: <agent-id>`
- `X-Event-Type: <event-name>`
- `X-Delivery-Id: <delivery-id>`
- `X-Webhook-Timestamp: <unix-seconds>`
- `X-Webhook-Signature: v1=<hex-hmac-sha256>`

Body = raw JSON payload for the event.

Note the unit split: the `X-Webhook-Timestamp` **header** is Unix seconds (a
signing convention), while every `timestamp` field **inside** payloads is
epoch milliseconds like the rest of the API.

`turn.started` example payload:

```json
{
  "turnId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
  "sandboxSessionId": "b61b41f2-7c3d-4a5e-8f90-1a2b3c4d5e6f",
  "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "conversationId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
  "mode": "interactive",
  "taskDescription": "Summarize alerts",
  "timestamp": 1712140000000
}
```

`turn.completed` example payload:

```json
{
  "turnId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
  "sandboxSessionId": "b61b41f2-7c3d-4a5e-8f90-1a2b3c4d5e6f",
  "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "conversationId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
  "status": "COMPLETED",
  "durationMs": 1500,
  "usage": null,
  "timestamp": 1712140001500
}
```

`status` is the REST TurnStatus verbatim: `COMPLETED`, `ERROR`, or
`CANCELLED` (an `error` string accompanies `ERROR`). `durationMs` is
execution time (`completedAt − startedAt`).

`turn.cancelled` example payload:

```json
{
  "turnId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
  "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "conversationId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
  "timestamp": 1712140001200
}
```

`conversationId` is `null` when the cancelled turn had no conversation.

`tool_call.started` example payload:

```json
{
  "turnId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
  "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "conversationId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
  "toolCallId": "tc_1",
  "toolName": "artifact_search",
  "args": { "query": "alerts" },
  "timestamp": 1712140000200
}
```

`message.committed` example payload:

```json
{
  "turnId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
  "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "conversationId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
  "messageId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04-m3",
  "messageSeq": 3,
  "role": "assistant",
  "content": "The run completed successfully.",
  "timestamp": 1712140001200
}
```

`artifact.created` example payload:

```json
{
  "artifactId": "3a1c5e7f-2b4d-4d6e-9c8b-0f1e2d3c4b5a",
  "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "turnId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
  "name": "summary.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 23456,
  "kind": "eval_report",
  "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "timestamp": 1712140001200
}
```

`sha256` is optional for legacy and externally registered artifacts. When
present, it follows the same authority rules as the artifact metadata returned
by the REST API.

`artifact.deleted` example payload:

```json
{
  "artifactId": "3a1c5e7f-2b4d-4d6e-9c8b-0f1e2d3c4b5a",
  "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "timestamp": 1712140001300
}
```

Webhooks are agent-scoped, so a delivered `artifact.deleted` always carries a
concrete `agentId`; deletions of unowned artifacts have no subscriber.

`agent.deleted` example payload:

```json
{
  "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "timestamp": 1712140001400
}
```

Experimental `custom.*` example payload:

```json
{
  "type": "custom.eval.verdict",
  "agentId": "1c8e7a6b-4b0d-4f3a-9e5c-2a7d9b1f4c6e",
  "turnId": "7b3f9d25-8c41-4c9e-b16a-3e5d8f2a9c04",
  "conversationId": "d2aa387f-59f2-4e33-8a3c-5b1e9d4c7f20",
  "payload": {
    "verdict": "pass",
    "evidence": { "suite": "weekly" }
  },
  "timestamp": 1712140001200
}
```

The nested `payload` object is delivered exactly as emitted; custom deliveries
do not project, rename, or truncate caller fields. The outer envelope carries
the event and correlation identities used by signature verification and
routing. The 256 KiB cap applies to the caller's nested `payload` at emission.

### Signing / secrets

- Webhook registrations require a signing `secret`; it is accepted on write and never returned on read.
- The signature input is `<X-Webhook-Timestamp>.<raw-body>` and uses HMAC-SHA256 with the registered secret.
- Consumers should use the bundled webhook verifier, enforce the default five-minute tolerance, and compare all signed identity headers with the parsed body. For `custom.*`, the verifier also requires `X-Event-Type` to match the body `type`.

## 7. Common Workflows (code examples)

### Create agent → send message → stream response

```js
const base = "http://localhost:3002";

const agent = await fetch(`${base}/api/agents`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "Support Agent",
    harness: "langgraph",
    harnessConfig: { model: "gpt-5.4-mini" },
    systemPrompt: "Help customers integrate Stablehand.",
    tools: []
  })
}).then((r) => r.json());

const stream = new EventSource(`${base}/api/agents/${agent.id}/stream`);
stream.onmessage = (e) => {
  const payload = JSON.parse(e.data);
  if (payload.type === "TEXT_MESSAGE_CONTENT") process.stdout.write(payload.delta || "");
};

const send = await fetch(`${base}/api/agents/${agent.id}/message`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: "How do I upload a workspace tarball?" })
}).then((r) => r.json());

console.log(send.conversationId, send.turnId);
```

### Background task execution

```js
const run = await fetch(`http://localhost:3002/api/agents/${agentId}/turns`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ task: "Process all new artifacts" })
}).then((r) => r.json());

const status = await fetch(`http://localhost:3002/api/agents/${agentId}/turns/${run.turnId}`)
  .then((r) => r.json());
```

### HITL approval flow

```js
const pending = await fetch(`http://localhost:3002/api/agents/${agentId}/interrupts`)
  .then((r) => r.json());

const interrupt = pending.interrupts[0];

await fetch(`http://localhost:3002/api/agents/${agentId}/interrupt`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    action: "approve",
    interruptId: interrupt.id,
    data: { approvedBy: "ops@example.com" }
  })
});
```

### Checkpoint and resume

```js
await fetch(`http://localhost:3002/api/agents/${agentId}/sandbox-sessions/${sandboxSessionId}/suspend`, {
  method: "POST"
});

await fetch(`http://localhost:3002/api/agents/${agentId}/sandbox-sessions/${sandboxSessionId}/restore`, {
  method: "POST"
});
```

### Workspace upload → file management

```js
// 1. Upload a .tar.gz workspace
await fetch(`http://localhost:3002/api/agents/${agentId}/workspace?force=true`, {
  method: "POST",
  headers: { "Content-Type": "application/gzip" },
  body: tarGzBuffer
});

// 2. List files
const files = await fetch(`http://localhost:3002/api/agents/${agentId}/files?path=.`)
  .then((r) => r.json());

// 3. Create a file
await fetch(`http://localhost:3002/api/agents/${agentId}/files`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ path: "notes/readme.txt", content: "hello" })
});

// 4. Read it back
const file = await fetch(`http://localhost:3002/api/agents/${agentId}/files/read?path=notes/readme.txt`)
  .then((r) => r.json());
```
