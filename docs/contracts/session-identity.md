# Identity contract

This document defines the canonical identities used by CTXMILL. Each name has
one meaning; APIs must not overload one identifier with another concept.

## Canonical IDs

### `conversationId`

- **Meaning:** the durable user conversation/thread and workspace owner.
- **Scope:** stable across every turn in the conversation.
- **Storage:** `conversations.id`.
- **Used by:** conversation/message routes, file/workspace routes, internal
  events, UI conversation routes, and AG-UI `threadId`.

### `turnId`

- **Meaning:** one agent execution within a conversation.
- **Scope:** unique for a single interactive or background execution.
- **Storage:** `turns.id`.
- **Used by:** turn routes, turn lifecycle events, artifacts, callbacks, tool
  execution context, and AG-UI `runId`.

### `sandboxSessionId`

- **Meaning:** the persistent sandbox container lifecycle reused by turns in a
  conversation.
- **Scope:** unique for one sandbox session from creation through checkpoint,
  restore, and termination.
- **Storage:** `sandbox_sessions.id`, referenced by
  `turns.sandbox_session_id`.
- **Used by:** sandbox lifecycle routes, checkpoints, container labels,
  reconciliation, and sandbox callback authentication.

### `interruptId`

- **Meaning:** one independent human-in-the-loop approval request.
- **Scope:** unique for a pending or resolved interrupt.
- **Storage:** `pending_interrupts.id`.
- **Used by:** interrupt list and resolution APIs. Interrupt records also carry
  their associated `turnId` and `sandboxSessionId`.

## AG-UI wire mapping

`runId` and `threadId` are AG-UI wire fields, not internal aliases:

| AG-UI field | CTXMILL identity |
|---|---|
| `runId` | `turnId` |
| `threadId` | `conversationId` |

Internal services and persisted records use the canonical CTXMILL names.

## Route contract summary

- `POST /api/agents/:id/message` starts an interactive turn and returns
  `{ messageId, conversationId, turnId }`.
- `POST /api/agents/:id/turns` starts a background turn and returns
  `{ turnId, conversationId }`.
- `GET /api/agents/:id/turns` and
  `GET /api/agents/:id/turns/:turnId` read execution records.
- `POST /api/agents/:id/turns/:turnId/cancel` cancels an execution.
- `/api/agents/:id/sandbox-sessions/:sandboxSessionId/*` manages the
  container lifecycle.
- `GET /api/conversations?status=active` returns active conversation
  summaries.
- `GET /api/sandbox-sessions?status=active` returns active sandbox sessions.
- Agent file routes require `conversationId`; artifact filters use `turnId`.
- Interrupt resolution requires `interruptId`.

## Guardrails

- A `conversationId` never identifies an execution or container.
- A `turnId` never identifies a conversation, sandbox session, or interrupt.
- A `sandboxSessionId` never identifies an API turn.
- An `interruptId` is never derived from or replaced by its `turnId`.
- APIs that expose more than one scope name every field explicitly.
- Do not introduce a generic `sessionId` into REST, database, or internal
  contracts. Protobuf `session_id` remains appropriate only where the
  `HarnessService` method is explicitly operating on a sandbox session.
