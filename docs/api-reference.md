# CTXMill API Reference

## 1. Overview

- **Base URL:** `http://localhost:3002` by default
- **Content-Type:** `application/json` for almost all endpoints
- **Exceptions:**
  - `GET /api/agents/:id/stream` uses `text/event-stream`
  - `POST /api/agents/:id/workspace` expects `application/gzip` or `application/x-gzip`
- **Authentication:** CTXMill ships with **no built-in auth**. Put auth, rate limits, and network controls at your reverse proxy or API gateway.
- **Shared TypeScript types:** CTXMill exports API and streaming types from `@ctxmill/shared` (for example `ApiAgent`, `ApiAgentSession`, `ApiMessage`, `AGUIEvent`, `MessageCommittedEvent`).

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
| PUT | `/api/agents/:id` | Update agent |
| DELETE | `/api/agents/:id` | Delete agent |
| **Agent Execution** |  |  |
| POST | `/api/agents/:id/message` | Send interactive message |
| POST | `/api/agents/:id/session` | Start background run |
| POST | `/api/agents/:id/sessions/:sessionId/cancel` | Cancel a running turn |
| GET | `/api/agents/:id/sessions/:sessionId` | Get a turn plus its messages |
| **Sessions** |  |  |
| GET | `/api/agents/:id/sessions` | List agent sessions |
| GET | `/api/agents/:id/turns` | List raw turn history |
| POST | `/api/agents/:id/sandbox-sessions/:sessionId/suspend` | Checkpoint a sandbox session |
| POST | `/api/agents/:id/sessions/:sessionId/kill` | Terminate a sandbox session |
| GET | `/api/sessions` | List active conversation summaries or sandbox sessions |
| **SSE Streaming** |  |  |
| GET | `/api/agents/:id/stream` | Subscribe to live agent events |
| **AG-UI Compatibility** |  |  |
| POST | `/api/ag-ui/:id/run` | AG-UI protocol endpoint — accepts `RunAgentInput`, returns run-scoped SSE ([docs](ag-ui-compat.md)); `/api/ag-ui/agents/:id/run` remains a compatibility alias |
| **Conversations & Messages** |  |  |
| GET | `/api/agents/:id/conversations` | List conversations |
| GET | `/api/agents/:id/conversations/summary` | List enriched conversation summaries |
| GET | `/api/agents/:id/conversations/:convId/messages` | List conversation messages |
| **Human-in-the-Loop** |  |  |
| GET | `/api/agents/:id/interrupts` | List pending interrupts |
| POST | `/api/agents/:id/interrupt` | Resolve an interrupt |
| **Files & Workspace** |  |  |
| GET | `/api/agents/:id/files` | List workspace directory entries |
| GET | `/api/agents/:id/files/read` | Read a workspace file |
| POST | `/api/agents/:id/files` | Create a workspace file |
| PUT | `/api/agents/:id/files` | Update a workspace file |
| DELETE | `/api/agents/:id/files` | Delete a workspace file |
| POST | `/api/agents/:id/workspace` | Replace base workspace from tarball |
| **Skills** |  |  |
| GET | `/api/agents/:id/skills` | List skills |
| POST | `/api/agents/:id/skills` | Create skill |
| PUT | `/api/agents/:id/skills/:skillName` | Update skill |
| DELETE | `/api/agents/:id/skills/:skillName` | Delete skill |
| **Secrets** |  |  |
| GET | `/api/agents/:id/secrets` | List secret keys |
| POST | `/api/agents/:id/secrets` | Set secret |
| DELETE | `/api/agents/:id/secrets/:key` | Delete secret |
| **Webhooks** |  |  |
| GET | `/api/agents/:id/webhooks` | List webhooks |
| POST | `/api/agents/:id/webhooks` | Create webhook |
| PUT | `/api/agents/:id/webhooks/:webhookId` | Update webhook |
| DELETE | `/api/agents/:id/webhooks/:webhookId` | Delete webhook |
| **Feedback** |  |  |
| POST | `/api/agents/:id/feedback` | Submit thumbs-up/thumbs-down feedback |
| GET | `/api/agents/:id/versions` | List stored agent versions |
| **Settings** |  |  |
| GET | `/api/settings` | Get system settings |
| PUT | `/api/settings` | Update system settings |
| **Artifacts** |  |  |
| GET | `/api/artifacts` | List artifacts |
| GET | `/api/artifacts/:id` | Get artifact metadata |
| GET | `/api/artifacts/:id/download` | Download artifact bytes |
| GET | `/api/artifacts/:id/download-url` | Get signed download URL |
| POST | `/api/artifacts/upload-url` | Get signed upload URL |
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
| **Catalogs & Tools** |  |  |
| GET | `/api/catalogs` | Get A2UI component catalogs |
| GET | `/api/catalogs/tools` | List tools |
| POST | `/api/catalogs/tools/test` | Test-run a tool |
| **Sandbox Metrics** |  |  |
| GET | `/api/sandbox/metrics` | Container metrics |

## 3. Conventions

### Response envelopes

- **Raw arrays** are used for some list endpoints, including:
  - `GET /api/agents`
  - `GET /api/agents/:id/conversations`
  - `GET /api/agents/:id/conversations/:convId/messages`
  - `GET /api/agents/:id/turns`
  - `GET /api/agents/:id/webhooks`
  - `GET /api/sessions?format=sandbox`
  - `GET /api/sessions` (default mode)
  - `GET /api/triggers`
  - `GET /api/catalogs/tools`
- **Wrapped objects** are used elsewhere, for example:
  - `{ sessions: [...] }`
  - `{ conversations: [...] }`
  - `{ artifacts: [...], total }`
  - `{ items: [...], total }`
  - `{ events: [...], nextCursor }`
  - `{ interrupts: [...] }`

### Error format

Most errors use:

```json
{ "error": "message", "detail": "optional detail" }
```

Some endpoints also add endpoint-specific fields such as `details`, `sessionId`, `agentId`, `validEvents`, `activeSessions`, `size`, or `maxSize`.

### Status codes

Common codes used across the API:

- `200 OK`
- `201 Created`
- `202 Accepted`
- `204 No Content`
- `400 Bad Request`
- `404 Not Found`
- `500 Internal Server Error`
- `501 Not Implemented`
- `503 Service Unavailable`

Also used by specific file/workspace endpoints:

- `403 Forbidden`
- `409 Conflict`
- `413 Payload Too Large`
- `415 Unsupported Media Type`

### Pagination

- **Events:** cursor-based via `cursor` / `nextCursor`
- **Artifacts:** offset-based via `limit` + `offset`
- **Everything else:** no pagination

### Shared types

Useful exported types from `@ctxmill/shared`:

- API resources: `ApiAgent`, `ApiAgentSession`, `ApiMessage`, `ApiSandboxSession`
- Streaming: `AGUIEvent`, `AGUIEventType`, `MessageCommittedEvent`
- Skills: `LoadedSkill`, `SkillFrontmatter`

### Validation ranges

Per-agent sandbox resource limits:

- `cpus`: `0.5` to `4.0`
- `memoryMb`: integer `256` to `4096`
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
  "timestamp": "2026-04-03T12:00:00.000Z",
  "sandbox": {
    "execution_mode": "sandbox",
    "containers": {
      "active": 1,
      "queued": 0,
      "peak": 4,
      "total_created": 25
    },
    "limits": {
      "max_global_containers": 20
    }
  }
}
```

- **Notes:** `/api/health` returns the same payload.

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
  "llm": {
    "provider": "openai",
    "model": "gpt-5.4-mini"
  },
  "system": {
    "version": "0.1.0",
    "uptime": 123456,
    "dbPath": ".ctxmill"
  },
  "agentDefaults": {
    "harness": "langgraph",
    "temperature": 0.7,
    "maxTokens": 4096
  }
}
```

- **Notes:** `uptime` is milliseconds since process start.

### b. Agents (`/api/agents`)

#### `GET /api/agents`

- **Description:** Lists all agents with runtime summary data.
- **Query params:** None.
- **Response:** raw array.

```json
[
  {
    "id": "agent_123",
    "name": "Support Agent",
    "status": "idle",
    "harness": "langgraph",
    "harnessConfig": { "model": "gpt-5.4-mini" },
    "tools": ["web_search", "artifact_upload"],
    "resourceLimits": { "cpus": 1, "memoryMb": 1024 },
    "conversationCount": 12,
    "activeSessions": 1,
    "completedSessions": 20,
    "failedSessions": 1,
    "sseClients": 2,
    "hasPendingInterrupt": false,
    "sessionsByStatus": {
      "ACTIVE": 1,
      "CHECKPOINTED": 0,
      "RESTORING": 0,
      "TERMINATED": 0
    },
    "sessions": [
      {
        "id": "turn_123",
        "agentId": "agent_123",
        "conversationId": "conv_123",
        "status": "running",
        "mode": "interactive",
        "startedAt": 1712140000000
      }
    ]
  }
]
```

- **Notes:** Returns a denormalized operational view, not just the stored agent row.

#### `POST /api/agents`

- **Description:** Creates an agent.
- **Request body:**

```json
{
  "name": "Support Agent",
  "harness": "langgraph",
  "harnessConfig": { "model": "gpt-5.4-mini" },
  "systemPrompt": "You help customers troubleshoot CTXMill deployments.",
  "tools": ["web_search"],
  "httpTools": [
    {
      "name": "crm_lookup",
      "description": "Look up a customer in CRM",
      "endpoint": "https://crm.example.com/api/customers/lookup",
      "method": "POST",
      "headers": { "X-App": "ctxmill" },
      "timeout": 15000
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
  "id": "agent_123",
  "name": "Support Agent",
  "harness": "langgraph",
  "harnessConfig": { "model": "gpt-5.4-mini" },
  "systemPrompt": "You help customers troubleshoot CTXMill deployments.",
  "tools": ["web_search", "crm_lookup"],
  "workspaceDir": "/data/agents/agent_123/base",
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
  - `httpTools` entries must include `name`, `description`, and `endpoint`.
  - If workspaces are enabled, CTXMill creates and seeds a base workspace automatically.

#### `GET /api/agents/:id`

- **Description:** Gets one agent plus operational summary fields.
- **Query params:** None.
- **Response:**

```json
{
  "id": "agent_123",
  "name": "Support Agent",
  "harness": "langgraph",
  "harnessConfig": { "model": "gpt-5.4-mini" },
  "tools": ["web_search", "crm_lookup"],
  "conversationCount": 12,
  "activeSessions": 1,
  "totalSessions": 12,
  "completedSessions": 10,
  "failedSessions": 1,
  "sseClients": 1,
  "hasPendingInterrupt": false,
  "sessionsByStatus": {
    "ACTIVE": 1,
    "CHECKPOINTED": 0,
    "RESTORING": 0,
    "TERMINATED": 0
  },
  "sessions": []
}
```

- **Notes:** `404` if the agent does not exist.

#### `PUT /api/agents/:id`

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
  "id": "agent_123",
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
  - Set `resourceLimits` to `null` to clear stored per-agent limits.

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
  "conversationId": "conv_123"
}
```

- **Query params:** None.
- **Response:**

```json
{
  "messageId": "msg_123",
  "conversationId": "conv_123",
  "sessionId": "turn_123"
}
```

- **Notes:**
  - If `conversationId` is omitted, CTXMill creates one.
  - The actual run starts asynchronously.
  - SSE clients receive `TEXT_MESSAGE_*` user-message bootstrap events plus `TURN_PENDING` before the canonical `RUN_STARTED`.

#### `POST /api/agents/:id/session`

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
- **Response:**

```json
{
  "sessionId": "turn_456",
  "conversationId": "conv_456"
}
```

- **Notes:**
  - Updates the agent status to `running` and returns before the run completes.
  - `sandboxSecrets` is optional and memory-only for the created run. Values are merged into the sandbox container environment for the initial session start, override same-named stored agent/env secrets for that run, and are not written to task messages, checkpoints, or agent records.

#### `POST /api/agents/:id/sessions/:sessionId/cancel`

- **Description:** Cancels a running turn.
- **Request body:** None.
- **Query params:** None.
- **Response:**

```json
{
  "cancelled": true,
  "sessionId": "turn_123"
}
```

- **Notes:** Returns `404` if the turn or live sandbox session cannot be found.

#### `GET /api/agents/:id/sessions/:sessionId`

- **Description:** Returns a turn plus all messages in its conversation.
- **Query params:** None.
- **Response:**

```json
{
  "session": {
    "id": "turn_123",
    "agentId": "agent_123",
    "conversationId": "conv_123",
    "mode": "interactive",
    "taskDescription": "Summarize alerts",
    "startedAt": 1712140000000,
    "completedAt": null,
    "error": null
  },
  "messages": [
    {
      "id": "msg_1",
      "role": "user",
      "content": "Summarize alerts"
    }
  ]
}
```

- **Notes:** The `:sessionId` slot accepts a turn ID; if no turn is found, CTXMill also checks whether the value is a conversation ID and resolves the latest turn for that conversation.

### d. Sessions

#### `GET /api/agents/:id/sessions`

- **Description:** Lists normalized session summaries for one agent.
- **Query params:** None.
- **Response:**

```json
{
  "sessions": [
    {
      "id": "turn_123",
      "agentId": "agent_123",
      "conversationId": "conv_123",
      "sandboxSessionId": "sbx_123",
      "status": "CHECKPOINTED",
      "mode": "background",
      "startedAt": 1712140000000,
      "taskDescription": "Index artifacts"
    }
  ]
}
```

- **Notes:** This is the best session list for customers; it normalizes turn and sandbox state.

#### `GET /api/agents/:id/turns`

- **Description:** Returns raw turn rows.
- **Query params:** None.
- **Response:** raw array.

```json
[
  {
    "id": "turn_123",
    "agentId": "agent_123",
    "conversationId": "conv_123",
    "mode": "interactive",
    "taskDescription": "Summarize alerts",
    "startedAt": 1712140000000,
    "completedAt": 1712140015000,
    "error": null
  }
]
```

- **Notes:** Use `/api/agents/:id/sessions` for a friendlier operational view.

#### `POST /api/agents/:id/sandbox-sessions/:sessionId/suspend`

- **Description:** Checkpoints a sandbox session.
- **Request body:** None.
- **Query params:** None.
- **Response:**

```json
{ "sessionId": "sbx_123", "status": "checkpointed" }
```

- **Notes:**
  - Requires sandbox session management to be enabled.
  - Returns `501` if session management is unavailable.

#### `POST /api/agents/:id/sessions/:sessionId/kill`

- **Description:** Terminates a sandbox session.
- **Request body:** None.
- **Query params:** None.
- **Response:** no body.
- **Notes:** Returns `204` on success.

#### `GET /api/sessions`

- **Description:** Lists active conversations by default, or active sandbox sessions when `format=sandbox`.
- **Query params:**
  - `format`: set to `sandbox` to get raw active sandbox sessions
- **Response (default):** raw array of conversation summaries.

```json
[
  {
    "id": "conv_123",
    "agentId": "agent_123",
    "status": "running",
    "mode": "interactive",
    "turnCount": 2,
    "messageCount": 5,
    "taskDescription": "Summarize alerts",
    "startedAt": 1712140000000,
    "updatedAt": 1712140010000,
    "latestTurnId": "turn_123",
    "sandboxSessionId": "sbx_123",
    "sandboxStatus": "ACTIVE"
  }
]
```

- **Response (`format=sandbox`):** raw array of sandbox session rows.

```json
[
  {
    "id": "sbx_123",
    "conversationId": "conv_123",
    "agentId": "agent_123",
    "status": "ACTIVE",
    "harnessName": "langgraph",
    "containerName": "ctxmill-agent-123",
    "createdAt": 1712140000000,
    "lastActivityAt": 1712140050000
  }
]
```

- **Notes:** Default mode only returns active conversation summaries.

### e. SSE Streaming

#### `GET /api/agents/:id/stream`

- **Description:** Opens a live SSE stream for one agent.
- **Request body:** None.
- **Query params:** None.
- **Response:** `text/event-stream`.
- **Notes:**
  - Sends an initial `CONNECTED` event immediately.
  - Accepts the `Last-Event-ID` header for replay.
  - Also emits `CUSTOM` `state_snapshot` events for active sandbox sessions when the connection opens.

Example initial frames:

```text
data: {"type":"CONNECTED","agentId":"agent_123","timestamp":1712140000000}

data: {"type":"CUSTOM","subtype":"state_snapshot","agentId":"agent_123","conversationId":"conv_123","sessionId":"sbx_123","status":"ACTIVE","activeTurnId":null,"timestamp":1712140001000}

id: agent_123-42
data: {"type":"RUN_STARTED","runId":"turn_123","conversationId":"conv_123","timestamp":1712140002000}

```

### f. Conversations & Messages

#### `GET /api/agents/:id/conversations`

- **Description:** Lists raw conversations for an agent.
- **Query params:** None.
- **Response:** raw array.

```json
[
  {
    "id": "conv_123",
    "agentId": "agent_123",
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
      "id": "conv_123",
      "agentId": "agent_123",
      "status": "completed",
      "mode": "interactive",
      "turnCount": 2,
      "messageCount": 5,
      "taskDescription": "Summarize alerts",
      "startedAt": 1712140000000,
      "updatedAt": 1712140050000,
      "latestTurnId": "turn_123",
      "sandboxSessionId": null,
      "sandboxStatus": null
    }
  ]
}
```

- **Notes:** Sandbox session statuses are uppercase (`ACTIVE`, `CHECKPOINTED`, `RESTORING`, `TERMINATED`) when a response includes sandbox state. Conversation lifecycle status fields remain lower-case (`running`, `suspended`, `completed`, `error`, `idle`).

#### `GET /api/agents/:id/conversations/:convId/messages`

- **Description:** Lists messages for one conversation.
- **Query params:** None.
- **Response:** raw array.

```json
[
  {
    "id": "msg_1",
    "role": "user",
    "content": "Summarize alerts",
    "createdAt": 1712140000000
  },
  {
    "id": "msg_2",
    "role": "assistant",
    "content": "Here is the summary...",
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
```

- **Notes:** Returns `404` if the conversation does not belong to the agent.

### g. Human-in-the-Loop (interrupts)

#### `GET /api/agents/:id/interrupts`

- **Description:** Lists pending interrupts; can also include durable DB-backed pending records.
- **Query params:**
  - `include_resolved=true|false`
- **Response:**

```json
{
  "interrupts": [
    {
      "id": "turn_123",
      "sessionId": "turn_123",
      "agentId": "agent_123",
      "toolCallId": "tc_1",
      "toolName": "approve_invoice",
      "args": { "invoiceId": "inv_9" },
      "createdAt": 1712140000000,
      "status": "pending"
    }
  ]
}
```

- **Notes:** `include_resolved=true` merges in durable pending records that are not currently in memory.

#### `POST /api/agents/:id/interrupt`

- **Description:** Resolves an interrupt.
- **Request body:**

```json
{
  "action": "approve",
  "sessionId": "turn_123",
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
{ "accepted": true, "resuming": true, "action": "approve" }
```

- **Notes:**
  - Allowed actions: `approve`, `reject`, `submit`
  - `submit` is normalized to `approve`
  - Returns `404` when the interrupt does not belong to that agent

### h. Files & Workspace

#### `GET /api/agents/:id/files`

- **Description:** Lists directory contents in the agent workspace.
- **Query params:**
  - `path` (default `.`)
  - `sessionId` (optional ownership check)
- **Response:**

```json
{
  "entries": [
    { "name": "README.md", "type": "file", "size": 1240 },
    { "name": "notes", "type": "directory", "size": 4096 }
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
  - `sessionId` (optional)
- **Response:**

```json
{
  "path": "README.md",
  "content": "# Workspace\n",
  "size": 12
}
```

- **Notes:**
  - Max file size is `50 KB`.
  - Returns `400` for directories.

#### `POST /api/agents/:id/files`

- **Description:** Creates a file in the agent workspace.
- **Query params:** `sessionId` (optional)
- **Request body:**

```json
{
  "path": "notes/todo.txt",
  "content": "Review the API docs"
}
```

- **Response:**

```json
{ "path": "notes/todo.txt", "size": 19 }
```

- **Notes:** Parent directories are created automatically.

#### `PUT /api/agents/:id/files`

- **Description:** Updates an existing file.
- **Query params:** `sessionId` (optional)
- **Request body:**

```json
{
  "path": "notes/todo.txt",
  "content": "Review the API docs and SSE examples"
}
```

- **Response:**

```json
{ "path": "notes/todo.txt", "size": 36 }
```

- **Notes:** Returns `404` if the file does not exist.

#### `DELETE /api/agents/:id/files`

- **Description:** Deletes a file.
- **Query params:**
  - `path` (required)
  - `sessionId` (optional)
- **Response:** no body.
- **Notes:** Returns `204` on success and `404` if the file does not exist.

#### `POST /api/agents/:id/workspace`

- **Description:** Replaces the agent's base workspace with a gzipped tarball.
- **Request body:** raw tarball bytes.
- **Headers:**
  - `Content-Type: application/gzip` or `application/x-gzip`
- **Query params:**
  - `force=true` to kill active sessions first
- **Response:**

```json
{
  "files": ["README.md", "src/index.ts"],
  "totalBytes": 18234
}
```

- **Notes:**
  - Rejects uploads unless the content type is gzip.
  - If the agent has active sessions, returns `409` unless `force=true`.
  - Maximum upload size is controlled by `maxTarUploadBytes` in `/api/settings`.
  - The replacement is atomic: CTXMill extracts to a temp dir and swaps it into place.

### i. Skills

#### `GET /api/agents/:id/skills`

- **Description:** Lists skills for an agent.
- **Query params:**
  - `sessionId` (optional; uses merged session skills when present)
- **Response:**

```json
{
  "skills": [
    {
      "name": "incident-response",
      "description": "Guide for incident triage",
      "path": "/data/.../incident-response/SKILL.md",
      "source": "project",
      "frontmatter": {
        "name": "incident-response",
        "description": "Guide for incident triage"
      },
      "instructions": "Follow these steps...",
      "scripts": [],
      "references": [],
      "assets": []
    }
  ]
}
```

- **Notes:** Returns `{ skills: [] }` if data storage is unavailable or no skills are found.

#### `POST /api/agents/:id/skills`

- **Description:** Creates a new `SKILL.md`-based skill.
- **Request body:**

```json
{
  "name": "incident-response",
  "description": "Guide for incident triage",
  "instructions": "1. Check alerts\n2. Confirm blast radius",
  "scripts": {
    "triage.sh": "#!/usr/bin/env bash\necho triage"
  }
}
```

- **Query params:** None.
- **Response:** created skill object.
- **Notes:**
  - Skill names must be lowercase, hyphenated, and max 64 chars.
  - Returns `409` if the skill already exists.

#### `PUT /api/agents/:id/skills/:skillName`

- **Description:** Updates `SKILL.md` frontmatter and/or instructions.
- **Request body:**

```json
{
  "description": "Updated guide",
  "instructions": "Updated instructions"
}
```

- **Query params:** None.
- **Response:** updated skill object.
- **Notes:** At least one of `description` or `instructions` is required.

#### `DELETE /api/agents/:id/skills/:skillName`

- **Description:** Deletes a skill directory.
- **Query params:** None.
- **Response:** no body.
- **Notes:** Returns `204` on success.

### j. Secrets

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

### k. Webhooks

#### `POST /api/agents/:id/webhooks`

- **Description:** Registers a webhook subscription.
- **Request body:**

```json
{
  "url": "https://example.com/ctxmill/webhook",
  "events": ["turn.started", "turn.completed"],
  "secret": "optional-shared-secret"
}
```

- **Query params:** None.
- **Response:**

```json
{
  "id": "wh_123",
  "agentId": "agent_123",
  "url": "https://example.com/ctxmill/webhook",
  "events": ["turn.started", "turn.completed"],
  "secret": "optional-shared-secret",
  "active": true,
  "createdAt": 1712140000000,
  "updatedAt": 1712140000000
}
```

- **Notes:** Valid event names are listed in [Webhook Events](#6-webhook-events).

#### `GET /api/agents/:id/webhooks`

- **Description:** Lists active webhooks for the agent.
- **Query params:** None.
- **Response:** raw array.

```json
[
  {
    "id": "wh_123",
    "agentId": "agent_123",
    "url": "https://example.com/ctxmill/webhook",
    "events": ["turn.started", "turn.completed"],
    "active": true,
    "createdAt": 1712140000000,
    "updatedAt": 1712140000000
  }
]
```

- **Notes:** Returns only active webhooks.

#### `PUT /api/agents/:id/webhooks/:webhookId`

- **Description:** Updates a webhook subscription for the agent.
- **Request body:**

```json
{
  "url": "https://example.com/ctxmill/webhook",
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

### l. Feedback

#### `POST /api/agents/:id/feedback`

- **Description:** Emits a thumbs-up or thumbs-down feedback event for a conversation. External learning modules can subscribe to `feedback.received` through the event/webhook surfaces.
- **Request body:**

```json
{
  "conversationId": "conv_123",
  "messageId": "msg_9",
  "type": "thumbs_up",
  "comment": "Good answer"
}
```

- **Query params:** None.
- **Response:**

```json
{
  "feedbackId": "fb_123",
  "type": "thumbs_up",
  "turnId": "turn_123"
}
```

- **Notes:** The endpoint does not persist feedback analytics or run an in-process learner. Register a webhook for `feedback.received` when an external learning service needs the signal.

#### `GET /api/agents/:id/versions`

- **Description:** Lists stored versions of an agent manifest.
- **Query params:** None.
- **Response:**

```json
{
  "versions": [
    {
      "id": "ver_123",
      "agentId": "agent_123",
      "version": 3,
      "manifest": { "spec": { "instructions": "..." } },
      "changedBy": "user",
      "changeNote": "Tuned instructions",
      "createdAt": 1712140000000
    }
  ]
}
```

- **Notes:** Useful for configuration audit trails.

### m. Settings (`/api/settings`)

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

### n. Artifacts (`/api/artifacts`)

#### `GET /api/artifacts`

- **Description:** Lists artifacts globally, by agent, or by session.
- **Query params:**
  - `agentId`
  - `sessionId`
  - `limit` (default `100`)
  - `offset` (default `0`)
  - `search` (global listing only)
- **Response:**
  - with `sessionId`: `{ artifacts: [...] }`
  - with `agentId`: `{ artifacts: [...] }`
  - without `agentId`: `{ artifacts: [...], total }`

```json
{
  "artifacts": [
    {
      "id": "art_123",
      "agentId": "agent_123",
      "sessionId": "turn_123",
      "name": "summary.pdf",
      "mimeType": "application/pdf",
      "sizeBytes": 23456,
      "storageKey": "artifacts/art_123/summary.pdf",
      "bucket": "ctxmill-artifacts",
      "status": "active",
      "createdAt": 1712140000000
    }
  ],
  "total": 1
}
```

- **Notes:** `sessionId` takes precedence when provided.

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
  - `expiresIn` seconds, capped at `86400`
- **Response:**

```json
{
  "url": "https://storage.example.com/signed-download",
  "expiresIn": 3600,
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
  "agentId": "agent_123",
  "name": "summary.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 23456
}
```

- **Query params:** None.
- **Response:**

```json
{
  "artifactId": "art_123",
  "uploadUrl": "https://storage.example.com/signed-upload",
  "storageKey": "artifacts/art_123/summary.pdf",
  "expiresIn": 3600
}
```

- **Notes:** The metadata row starts as `pending_upload` and is hidden from list endpoints until the object exists and a download/download-url request confirms it. Direct multipart upload is available at `POST /api/artifacts/upload`; daemon-side direct uploads use the `artifact_upload` tool. Artifact object keys are globally scoped by artifact ID, not by agent ID, so deleting an agent does not imply artifact-object cleanup.

#### `DELETE /api/artifacts/:id`

- **Description:** Soft-deletes artifact metadata and attempts to remove the backing object.
- **Query params:** None.
- **Response:**

```json
{ "deleted": true, "id": "art_123" }
```

- **Notes:** Returns `404` if the artifact does not exist.

### o. Events (`/api/events`)

#### `GET /api/events`

- **Description:** Lists persisted events with cursor pagination.
- **Query params:**
  - `cursor`
  - `limit` (default `50`, max `200`)
  - `type`
  - `agentId`
  - `since` (epoch milliseconds)
- **Response:**

```json
{
  "events": [
    {
      "seq": 912,
      "type": "turn.completed",
      "agentId": "agent_123",
      "payload": "{\"turnId\":\"turn_123\",\"status\":\"completed\"}",
      "createdAt": 1712140000000
    }
  ],
  "nextCursor": 912
}
```

- **Notes:** Events are returned newest-first; pass `nextCursor` to fetch older pages.

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
    "run.tool_started": 60
  },
  "topAgents": [
    { "agentId": "agent_123", "count": 40 }
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
{ "types": ["turn.started", "turn.completed", "run.tool_started"] }
```

- **Notes:** Useful for building filters in dashboards.

### p. Triggers (`/api/triggers`)

#### `POST /api/triggers`

- **Description:** Creates an event trigger.
- **Request body:**

```json
{
  "agentId": "agent_123",
  "eventType": "turn.completed",
  "selector": { "status": "completed" },
  "taskTemplate": "Review output from turn {{turnId}}",
  "enabled": true
}
```

- **Query params:** None.
- **Response:** trigger object.
- **Notes:** Returns `404` if `agentId` does not exist.

#### `GET /api/triggers`

- **Description:** Lists triggers.
- **Query params:** `agentId` (optional)
- **Response:** raw array.

```json
[
  {
    "id": "trig_123",
    "agentId": "agent_123",
    "eventType": "turn.completed",
    "selector": { "status": "completed" },
    "taskTemplate": "Review output from turn {{turnId}}",
    "enabled": true
  }
]
```

- **Notes:** Filter server-side with `agentId` when you only need one agent's triggers.

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
- **Response:**

```json
{ "ok": true }
```

- **Notes:** Returns `404` if not found.

#### `POST /api/triggers/emit`

- **Description:** Emits a custom event into the trigger system.
- **Request body:**

```json
{
  "type": "build.completed",
  "agentId": "agent_123",
  "payload": { "buildId": "b_9", "status": "success" }
}
```

- **Query params:** None.
- **Response:**

```json
{ "ok": true, "type": "build.completed" }
```

- **Notes:** `payload` must be an object.

### q. Catalogs & Tools (`/api/catalogs`)

#### `GET /api/catalogs`

- **Description:** Returns A2UI component catalogs supported by the UI.
- **Query params:** None.
- **Response:**

```json
{
  "catalogs": [
    {
      "name": "ctxmill.charts",
      "components": {
        "TimeSeriesChart": { "props": { "title": "string", "data": "array" } },
        "MetricCard": { "props": { "title": "string", "value": "string|number" } },
        "KnowledgeGraphView": { "props": { "nodes": "array", "edges": "array" } }
      }
    }
  ]
}
```

- **Notes:** The current catalog is chart-heavy and intended for structured agent-to-UI output.

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
  "input": { "query": "ctxmill api reference" }
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

### r. Sandbox Metrics (`/api/sandbox`)

#### `GET /api/sandbox/metrics`

- **Description:** Returns in-memory container metrics.
- **Query params:** None.
- **Response:**

```json
{
  "execution_mode": "sandbox",
  "containers": {
    "active": 2,
    "queued": 1,
    "peak": 5,
    "total_created": 37,
    "by_harness": {
      "langgraph": 20,
      "claude-agents": 17
    },
    "average_lifetime_ms": 84213
  },
  "limits": {
    "max_global_containers": 20
  }
}
```

- **Notes:** Only available when sandbox container management is enabled.

## 5. SSE Streaming Protocol

- **Connection:** `GET /api/agents/:id/stream`
- **Wire format:**

```text
id: <event-id>
data: <json>

```

- **Initial connect event:**

```json
{ "type": "CONNECTED", "agentId": "agent_123", "timestamp": 1712140000000 }
```

- **Common event types:**
  - `TURN_PENDING`
  - `RUN_STARTED`
  - `TEXT_MESSAGE_START`
  - `TEXT_MESSAGE_CONTENT`
  - `TEXT_MESSAGE_END`
  - `TOOL_CALL_START`
  - `TOOL_CALL_ARGS`
  - `TOOL_CALL_END`
  - `TOOL_CALL_RESULT`
  - `RUN_FINISHED`
  - `RUN_ERROR`
  - `CUSTOM`
  - `MESSAGE_COMMITTED`
  - `HITL_PAUSE`
  - `STATE_DELTA`

Notes on actual stream behavior today:

- `CONNECTED` and `CUSTOM` `state_snapshot` are emitted by the stream endpoint itself.
- `TURN_PENDING` is emitted before the canonical `RUN_STARTED` when a turn has been accepted but the sandbox session is not fully ready yet.
- `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `MESSAGE_COMMITTED`, `HITL_PAUSE`, and forwarded `CUSTOM` events can all appear on the live stream.
- `STATE_DELTA` remains part of the shared event type surface but is not emitted by the route-owned code covered here.

### Connection lifecycle

- Initial `CONNECTED` event is sent immediately.
- If the agent has active sandbox sessions, the stream starts with `CUSTOM` `state_snapshot` events.
- Heartbeat comments are sent every **15 seconds**:

```text
: heartbeat

```

- Idle connections are closed after **5 minutes** without events.
- Reconnect using the standard SSE `Last-Event-ID` header.

### History & replay

- CTXMill stores up to **500 events per conversation** in memory.
- After `RUN_FINISHED` or `RUN_ERROR`, CTXMill keeps the last **50** events for that conversation.
- Conversation event history expires after **30 minutes**.

### Event examples

`TURN_PENDING`

```json
{
  "type": "TURN_PENDING",
  "runId": "turn_123",
  "conversationId": "conv_123",
  "agentId": "agent_123",
  "mode": "interactive",
  "timestamp": 1712140000000
}
```

`RUN_STARTED`

```json
{
  "type": "RUN_STARTED",
  "runId": "turn_123",
  "conversationId": "conv_123",
  "sessionId": "sbx_123",
  "agentId": "agent_123",
  "mode": "interactive",
  "timestamp": 1712140000000
}
```

`TEXT_MESSAGE_CONTENT`

```json
{
  "type": "TEXT_MESSAGE_CONTENT",
  "runId": "turn_123",
  "conversationId": "conv_123",
  "messageId": "msg_2",
  "content": "Here is the summary...",
  "delta": "Here is the summary...",
  "timestamp": 1712140000100
}
```

`TOOL_CALL_START`

```json
{
  "type": "TOOL_CALL_START",
  "runId": "turn_123",
  "toolCallId": "tc_1",
  "toolName": "artifact_search",
  "args": { "query": "alerts" },
  "timestamp": 1712140000200
}
```

`TOOL_CALL_ARGS`

```json
{
  "type": "TOOL_CALL_ARGS",
  "runId": "turn_123",
  "toolCallId": "tc_1",
  "args": "{\"query\":\"alerts\"}",
  "timestamp": 1712140000201
}
```

`TOOL_CALL_RESULT`

```json
{
  "type": "TOOL_CALL_RESULT",
  "runId": "turn_123",
  "toolCallId": "tc_1",
  "toolName": "artifact_search",
  "result": "2 matching artifacts",
  "durationMs": 180,
  "timestamp": 1712140000400
}
```

`MESSAGE_COMMITTED`

```json
{
  "type": "MESSAGE_COMMITTED",
  "runId": "turn_123",
  "turnId": "turn_123",
  "conversationId": "conv_123",
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
  "runId": "turn_123",
  "conversationId": "conv_123",
  "status": "completed",
  "durationMs": 600,
  "timestamp": 1712140000600
}
```

### JavaScript example

```js
const agentId = "agent_123";
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
      process.stdout.write(payload.content || "");
      break;
    case "TOOL_CALL_START":
      console.log("tool start", payload.toolName, payload.args);
      break;
    case "TOOL_CALL_RESULT":
      console.log("tool result", payload.result);
      break;
    case "HITL_PAUSE":
      console.log("approval required");
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
- `run.tool_started`
- `run.tool_result`
- `run.interrupted`
- `run.interrupt_resolved`
- `message.committed`

### Delivery format

Webhook deliveries are HTTP `POST` requests with:

- `Content-Type: application/json`
- `X-Agent-Id: <agent-id>`
- `X-Event-Type: <event-name>`
- `X-Delivery-Id: <delivery-id>`

Body = raw JSON payload for the event.

`turn.started` example payload:

```json
{
  "turnId": "turn_123",
  "sessionId": "sbx_123",
  "agentId": "agent_123",
  "conversationId": "conv_123",
  "mode": "interactive",
  "taskDescription": "Summarize alerts",
  "timestamp": 1712140000000
}
```

`turn.completed` example payload:

```json
{
  "turnId": "turn_123",
  "sessionId": "sbx_123",
  "agentId": "agent_123",
  "conversationId": "conv_123",
  "status": "completed",
  "durationMs": 1500,
  "timestamp": 1712140001500
}
```

`run.tool_started` example payload:

```json
{
  "turnId": "turn_123",
  "agentId": "agent_123",
  "conversationId": "conv_123",
  "toolCallId": "tc_1",
  "toolName": "artifact_search",
  "args": { "query": "alerts" },
  "timestamp": 1712140000200
}
```

`message.committed` example payload:

```json
{
  "turnId": "turn_123",
  "agentId": "agent_123",
  "conversationId": "conv_123",
  "messageId": "msg_123",
  "messageSeq": 3,
  "role": "assistant",
  "content": "The run completed successfully.",
  "timestamp": 1712140001200
}
```

### Signing / secrets

- Webhook registrations accept an optional `secret` field.
- **Current delivery behavior:** the delivery code sets JSON and `X-*` headers, but does **not** add an HMAC signature header.
- If you need signed webhooks today, add signing at your reverse proxy or custom delivery layer.

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
    systemPrompt: "Help customers integrate CTXMill.",
    tools: []
  })
}).then((r) => r.json());

const stream = new EventSource(`${base}/api/agents/${agent.id}/stream`);
stream.onmessage = (e) => {
  const payload = JSON.parse(e.data);
  if (payload.type === "TEXT_MESSAGE_CONTENT") process.stdout.write(payload.content || "");
};

const send = await fetch(`${base}/api/agents/${agent.id}/message`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: "How do I upload a workspace tarball?" })
}).then((r) => r.json());

console.log(send.conversationId, send.sessionId);
```

### Background task execution

```js
const run = await fetch(`http://localhost:3002/api/agents/${agentId}/session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ task: "Process all new artifacts" })
}).then((r) => r.json());

const status = await fetch(`http://localhost:3002/api/agents/${agentId}/sessions/${run.sessionId}`)
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
    sessionId: interrupt.sessionId,
    data: { approvedBy: "ops@example.com" }
  })
});
```

### Checkpoint and resume

```js
await fetch(`http://localhost:3002/api/agents/${agentId}/sessions/${sandboxSessionId}/suspend`, {
  method: "POST"
});

await fetch(`http://localhost:3002/api/sessions/${sandboxSessionId}/resume`, {
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
