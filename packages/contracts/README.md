# @ctxmill/contracts

Strict, lightweight runtime contracts for CTXMill HTTP APIs, webhooks, and event
streams. The package depends only on Zod and is safe to import from Node or a
browser; it does not pull in the CTXMill orchestrator.

```ts
import {
  AgentCreateInputSchema,
  CanonicalStreamEventSchema,
  type AgentCreateInput,
} from '@ctxmill/contracts';

const agent: AgentCreateInput = {
  name: 'reconciler',
  harness: 'claude-agents',
  harnessConfig: { model: 'claude-sonnet-4-20250514' },
  systemPrompt: 'Reconcile the close.',
  tools: [],
};

AgentCreateInputSchema.parse(agent);
CanonicalStreamEventSchema.parse(eventFromCtxmill);
```

Canonical per-harness config schemas are exported from
`@ctxmill/contracts/harness`. They accept only `openai`, `anthropic`, and
`google` provider names; agent-level native tools do not belong in harness
config. PI Agent optionally accepts `maxTokens`, `reasoning`, and
`thinkingLevel` so callers can bound generation without inventing a
provider-specific harness contract. LangGraph's `reasoning: "off"` is an
explicit request, including for configured subagents; it is not the same as
omitting the field and inheriting the upstream model default.

Schedule CRUD schemas are exported from `@ctxmill/contracts/schedules` and
the package root. They own the stable API shape and reuse the canonical
`custom.*` event name and 32 KiB payload contracts. Cron parsing and runtime
clock ownership intentionally remain in the orchestrator, so importing the
contracts package never loads Croner or scheduler state.

Signed webhook helpers are exported from `@ctxmill/contracts/webhooks`.
`verifyCtxmillWebhook()` validates the five canonical `X-*` headers, clock
skew, all supplied current/previous secrets, the payload, and matching
header/body identities. `X-Event-Type` selects a strict flat schema for a
built-in event. Experimental `custom.*` events use a loose envelope with the
canonical event type, agent identity, caller payload, and timestamp so new
payload fields survive delivery without projection. Signature v1 is the
lowercase hex HMAC-SHA-256 of:

```text
utf8(X-Webhook-Timestamp) || "." || exact raw HTTP body bytes
```

Except for the explicitly experimental custom webhook envelope, schemas reject
unknown keys. Old execution aliases such as `sessionId`, top-level
`HITL_PAUSE`, `content` on text deltas, and `subtype` on CTXMill custom frames
are intentionally unsupported.
