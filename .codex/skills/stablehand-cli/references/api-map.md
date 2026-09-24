# stablehand API Map

Default local API base: `http://localhost:3002`. Deployment URLs may already end in `/api`; the bundled scripts handle either form. Authenticated deployments accept `--api-token <token>` or `STABLEHAND_API_TOKEN`; GET SSE streams use the route-scoped `?access_token=` fallback.

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
| PATCH | `/api/agents/:id` | Patch mutable agent fields |
| DELETE | `/api/agents/:id` | Delete agent and cascade owned data |
| GET | `/api/agents/:id/versions` | Agent manifest/version history |

Agent responses include `id`, `name`, `harness`, `harnessConfig`, `tools`, `metadata`, `manifest`, `workspaceDir`, `version`, `sseClients`, `lastActivity`, `hasPendingInterrupt`, `conversationCount`, `turnCount`, `activeTurnCount`, `recentTurns`, and `sandboxSessionsByStatus` when enriched.

## Turns

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/agents/:id/message` | Start an interactive turn; returns `{ messageId, conversationId, turnId }` |
| POST | `/api/agents/:id/turns` | Start a background turn; returns `{ turnId, conversationId, sandboxSessionId }` |
| GET | `/api/agents/:id/turns` | List normalized turn summaries as `{ turns }` |
| GET | `/api/agents/:id/turns/:turnId` | Get `{ turn, messages }` |
| POST | `/api/agents/:id/turns/:turnId/cancel` | Cancel one turn |
| POST | `/api/ag-ui/:id/run` | AG-UI wire entrypoint; `runId` and `threadId` are protocol fields |

## Active lifecycle views

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/conversations?status=active` | Active durable conversation summaries |
| GET | `/api/sandbox-sessions?status=active` | Active persistent sandbox sessions |
| POST | `/api/agents/:id/sandbox-sessions/:sandboxSessionId/suspend` | Checkpoint a sandbox session |
| POST | `/api/agents/:id/sandbox-sessions/:sandboxSessionId/restore` | Restore a checkpointed sandbox session |
| POST | `/api/agents/:id/sandbox-sessions/:sandboxSessionId/kill` | Terminate a sandbox session |

## Conversations and messages

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/agents/:id/conversations` | List conversations |
| GET | `/api/agents/:id/conversations/summary` | Enriched summaries with latest turn |
| GET | `/api/agents/:id/conversations/:convId/snapshot` | Ordered message history plus the exact SSE `eventCursor` boundary |

The snapshot envelope is `{ conversationId, eventCursor, messages }`. Message fields include `role`, `content`, `toolCallId`, `toolCalls`, and ordered `parts`. Start the conversation stream with `?cursor=<eventCursor>` only after installing the snapshot. Tool calls are usually easiest to reconstruct from both `toolCalls` and `parts`.

## Tooling and HITL

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/catalogs/tools` | Tool catalog, schemas, location, approval flags |
| POST | `/api/catalogs/tools/test` | Execute a tool test in a synthetic context |
| GET | `/api/agents/:id/interrupts` | Pending HITL interrupts |
| GET | `/api/agents/:id/interrupts?include_resolved=true` | Include persisted interrupt rows |
| POST | `/api/agents/:id/interrupt` | Resolve by `{ interruptId, action, data? }` |

Webhook-valid runtime event names include `turn.started`, `turn.completed`,
`tool_call.started`, `tool_call.completed`, `interrupt.requested`, and
`interrupt.resolved`.

## Events and triggers

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/events?type=&agentId=&since=&limit=&cursor=` | Paginated event log |
| GET | `/api/events/stats?range=1h\|24h\|7d` | Event aggregates |
| GET | `/api/events/types` | Distinct event types |
| GET/POST | `/api/triggers` | List/create event triggers |
| GET/PUT/DELETE | `/api/triggers/:id` | Manage one trigger |
| POST | `/api/triggers/emit` | Emit custom event |
| GET/POST | `/api/schedules` | List/create recurring schedules |
| GET/PATCH/DELETE | `/api/schedules/:id` | Manage one schedule |

## Artifacts and workspace files

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/artifacts?agentId=&turnId=&limit=&offset=` | List artifacts |
| GET | `/api/artifacts/:id` | Artifact metadata |
| GET | `/api/artifacts/:id/download` | Download artifact bytes |
| GET | `/api/artifacts/:id/download-url` | Presigned download URL |
| GET | `/api/agents/:id/files?path=&conversationId=` | List workspace directory |
| GET | `/api/agents/:id/files/read?path=&conversationId=` | Read small workspace file |
| POST/PUT/DELETE | `/api/agents/:id/files?conversationId=` | Mutate a conversation workspace |

File routes block sensitive paths and cap read size. Treat workspace file output as potentially sensitive.

## Persistence mental model

| Question | Backing data |
| --- | --- |
| What agents exist? | `agents` |
| What conversation happened? | `conversations`, `messages` |
| What turn is active or failed? | `turns` |
| What sandbox is active or checkpointed? | `sandbox_sessions` |
| Why is it paused? | `pending_interrupts`, `suspended_sessions`, `sandbox_sessions.status` |
| Can it resume? | `agent_checkpoints`, `sandbox_sessions.checkpointRef` |
| What tool failed? | `messages.toolCalls`, `messages.parts`, `event_store`, `pending_interrupts` |
| What artifacts were produced? | artifact repository and `/api/artifacts` |
| What event chain fired? | `schedules`, `event_triggers`, `trigger_firings`, `event_store` |
