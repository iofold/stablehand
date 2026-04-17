# Session identity contract

This document is the canonical reference for the IDs used by CTXMILL session, turn, and AG-UI routes.

## Canonical IDs

### `conversationId`
- **Meaning:** the user-facing conversation/thread identity
- **Scope:** stable across multiple turns in the same conversation
- **Used by:**
  - `POST /api/agents/:id/message` request body
  - `GET /api/agents/:id/conversations/:conversationId/messages`
  - SSE / AG-UI payloads as both `conversationId` and `threadId`
  - UI routes like `/agents/:id/conversations/:conversationId`

### `turnId` / `runId`
- **Meaning:** one execution attempt inside a conversation
- **Storage:** `turns.id`
- **Notes:**
  - internal eventing commonly calls this a **run id**
  - some REST responses still return it in a field named **`sessionId`** for backward compatibility
- **Used by:**
  - `turn.pending`, `turn.started`, `turn.completed`
  - `POST /api/agents/:id/message` response `sessionId`
  - `POST /api/agents/:id/session` response `sessionId`
  - turn-oriented APIs and tests

### `sandboxSessionId`
- **Meaning:** the persistent sandbox container/session identity reused across turns
- **Storage:** `sandbox_sessions.id`, mirrored onto `turns.sessionId` once a turn is bound to a live sandbox session
- **Used by:**
  - sandbox lifecycle APIs like `/api/agents/:id/sandbox-sessions/:sessionId/{suspend|kill}`
  - route responses as `sandboxSessionId`
  - recovery / reconciliation logic

### `threadId`
- **Meaning:** AG-UI thread identity
- **Contract:** always equal to `conversationId` in CTXMILL
- **Why:** AG-UI thread semantics map to the persisted CTXMILL conversation, not to an individual turn or sandbox session

## Route contract summary

### Start an interactive turn
- `POST /api/agents/:id/message`
- input: optional `conversationId`
- response: `{ messageId, conversationId, sessionId }`
- **Important:** response `sessionId` is the new **turn/run id**, not the persistent sandbox session id

### Start a background turn
- `POST /api/agents/:id/session`
- input: `task`
- response: `{ sessionId, conversationId }`
- **Important:** response `sessionId` is again the **turn/run id**

### Read turn summaries
- `GET /api/agents/:id/sessions`
- returns turn-oriented summaries
- each item `id` is the **turn/run id**
- each item may also include `sandboxSessionId`

## Guardrails

- Never treat `conversationId` as a turn id.
- Never treat the `sessionId` returned by message/session creation routes as a sandbox session id.
- When emitting AG-UI events, use `conversationId` for `threadId`.
- When a response needs both execution scopes, expose both `id`/`sessionId` semantics explicitly rather than overloading one field silently.
