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
config.

Signed webhook helpers are exported from `@ctxmill/contracts/webhooks`.
`verifyCtxmillWebhook()` validates the five canonical `X-*` headers, clock
skew, all supplied current/previous secrets, the strict payload, and matching
header/body agent identity. `X-Event-Type` selects the strict flat body schema;
delivery ID and event type are headers, not duplicate body fields. Signature
v1 is the lowercase hex HMAC-SHA-256 of:

```text
utf8(X-Webhook-Timestamp) || "." || exact raw HTTP body bytes
```

Schemas reject unknown keys. Old execution aliases such as `sessionId`,
top-level `HITL_PAUSE`, `content` on text deltas, and `subtype` on CTXMill
custom frames are intentionally unsupported.
