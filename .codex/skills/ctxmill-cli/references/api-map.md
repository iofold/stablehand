# ctxmill API Map

Default local API base: `http://localhost:3002`. Deployment URLs may already end in `/api`; the bundled scripts handle either form. Authenticated deployments accept `--api-token <token>` or `CTXMILL_API_TOKEN`; GET SSE streams use the route-scoped `?access_token=` fallback.

## Service

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Direct orchestrator health |
| GET | `/api/health` | Proxied/prefix health |
| GET | `/api/config` | Runtime config summary |
| GET | `/api/sandbox/metrics` | In-memory container metrics |
| GET/PUT | `/api/settings` | Runtime settings |

## Agents

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/agents` | List enriched agent definitions |
| POST | `/api/agents` | Create agent |
| GET | `/api/agents/:id` | Get agent definition |
| PUT | `/api/agents/:id` | Update agent definition |
| DELETE | `/api/agents/:id` | Delete agent and cascade owned data |
| GET | `/api/agents/:id/versions` | Agent manifest/version history |

Agent responses include `id`, `name`, `harness`, `harnessConfig`, `tools`, `metadata`, `manifest`, `workspaceDir`, `version`, `sseClients`, `lastActivity`, `hasPendingInterrupt`, `sessions`, and `sessionsByStatus` when enriched.

## Runs and sessions

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/agents/:id/message` | Start interactive turn; returns `{ messageId, conversationId, sessionId }` |
| POST | `/api/agents/:id/session` | Start background turn; returns `{ sessionId, conversationId }` |
| POST | `/api/ag-ui/:id/run` | AG-UI compatible run entrypoint |
| GET | `/api/agents/:id/sessions` | List turn/run summaries for agent |
| GET | `/api/agents/:id/sessions/:sessionId` | Turn/run detail with messages |
| GET | `/api/agents/:id/turns` | Raw turns for agent |
| POST | `/api/agents/:id/sessions/:sessionId/cancel` | Cancel current turn |
| GET | `/api/sessions` | Active conversation summaries |
| GET | `/api/sessions?format=sandbox` | Active sandbox sessions |
| POST | `/api/agents/:id/sandbox-sessions/:sessionId/suspend` | Checkpoint sandbox session |
| POST | `/api/agents/:id/sandbox-sessions/:sessionId/kill` | Kill sandbox session |

Important: the `sessionId` returned by `/message` and `/session` is the turn/run id, not always the persistent sandbox session id.

## Conversations and messages

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/agents/:id/conversations` | List conversations |
| GET | `/api/agents/:id/conversations/summary` | Enriched summaries with latest turn/session |
| GET | `/api/agents/:id/conversations/:convId/messages` | Ordered message history |

Message fields include `role`, `content`, `toolCallId`, `toolCalls`, and ordered `parts`. Tool calls are usually easiest to reconstruct from both `toolCalls` and `parts`.

## Tooling and HITL

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/catalogs/tools` | Tool catalog, schemas, location, approval flags |
| POST | `/api/catalogs/tools/test` | Execute a tool test in a synthetic context |
| GET | `/api/agents/:id/interrupts` | Pending HITL interrupts |
| GET | `/api/agents/:id/interrupts?include_resolved=true` | Include persisted interrupt rows |
| POST | `/api/agents/:id/interrupt` | Resolve interrupt with `approve`, `reject`, or `submit` |

Webhook-valid runtime event names include `turn.started`, `turn.completed`, `run.tool_started`, `run.tool_result`, `run.interrupted`, and `run.interrupt_resolved`.

## Events and triggers

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/events?type=&agentId=&since=&limit=&cursor=` | Paginated event log |
| GET | `/api/events/stats?range=1h\|24h\|7d` | Event aggregates |
| GET | `/api/events/types` | Distinct event types |
| GET/POST | `/api/triggers` | List/create event triggers |
| GET/PUT/DELETE | `/api/triggers/:id` | Manage one trigger |
| POST | `/api/triggers/emit` | Emit custom event |

## Artifacts and workspace files

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/artifacts?agentId=&sessionId=&limit=&offset=` | List artifacts |
| GET | `/api/artifacts/:id` | Artifact metadata |
| GET | `/api/artifacts/:id/download` | Download artifact bytes |
| GET | `/api/artifacts/:id/download-url` | Presigned download URL |
| GET | `/api/agents/:id/files?path=&sessionId=` | List workspace directory |
| GET | `/api/agents/:id/files/read?path=&sessionId=` | Read small workspace file |

File routes block sensitive paths and cap read size. Treat workspace file output as potentially sensitive.

## Persistence mental model

| Question | Backing data |
| --- | --- |
| What agents exist? | `agents` |
| What conversation happened? | `conversations`, `messages` |
| What run/session is active or failed? | `turns`, `sandbox_sessions` |
| Why is it paused? | `pending_interrupts`, `suspended_sessions`, `sandbox_sessions.status` |
| Can it resume? | `agent_checkpoints`, `sandbox_sessions.checkpointRef` |
| What tool failed? | `messages.toolCalls`, `messages.parts`, `event_store`, `pending_interrupts` |
| What artifacts were produced? | artifact repository and `/api/artifacts` |
| What event chain fired? | `event_triggers`, `scheduled_events`, `event_store` |
