# React Chat Integration

This guide is for product teams embedding CTXMill agent chat into an existing React app. Use the React package when you want CTXMill's streaming chat state, HITL approval flow, and A2UI rendering without rebuilding the AG-UI plumbing by trial and error.

## Packages

```bash
pnpm add @ctxmill/react @ctxmill/client
```

`@ctxmill/client` is the typed AG-UI SSE client. `@ctxmill/react` builds on it with hooks and UI primitives.

## Backend Contract

The canonical run endpoint is:

```http
POST /api/ag-ui/:agentId/run
Content-Type: application/json
Accept: text/event-stream
```

`threadId` is optional. If omitted, CTXMill creates a conversation and returns the chosen id in the first `MESSAGES_SNAPSHOT`. If supplied and missing, the AG-UI route creates that conversation id so the embedding app can keep its own durable thread key.

## Fast Path

```tsx
import { CtxmillChat, CtxmillProvider } from '@ctxmill/react';

export function AgentPanel() {
  return (
    <CtxmillProvider apiBase="/api">
      <CtxmillChat agentId="agent-id-from-your-app" />
    </CtxmillProvider>
  );
}
```

For authenticated deployments, pass headers or a preconfigured client:

```tsx
<CtxmillProvider
  apiBase="https://agents.example.com/api"
  headers={() => ({ Authorization: `Bearer ${getToken()}` })}
>
  <CtxmillChat agentId={agentId} threadId={conversationId} />
</CtxmillProvider>
```

## Composable UI

Use the hook and primitives when the chat shell needs to match your product layout.

```tsx
import {
  CtxmillComposer,
  CtxmillHITL,
  CtxmillThread,
  useCtxmillChat,
} from '@ctxmill/react';

function EmbeddedChat({ agentId }: { agentId: string }) {
  const chat = useCtxmillChat({ agentId, apiBase: '/api' });

  return (
    <section>
      <CtxmillThread messages={chat.messages} />
      {chat.pendingHitl ? (
        <CtxmillHITL request={chat.pendingHitl} onResolve={chat.resolveHitl} />
      ) : null}
      <CtxmillComposer
        onSend={chat.sendMessage}
        disabled={chat.isRunning || Boolean(chat.pendingHitl)}
      />
    </section>
  );
}
```

## A2UI

Agents render structured UI by calling the intrinsic `a2ui-render` tool. The AG-UI stream emits:

```json
{
  "type": "CUSTOM",
  "name": "ctxmill.a2ui.render",
  "subtype": "a2ui_render",
  "block": {
    "id": "tool-call-id",
    "component": "MetricCard",
    "props": { "title": "Open incidents", "value": 7 }
  }
}
```

`@ctxmill/react` ships lightweight defaults for `MetricCard`, `TableView`, `BarChart`, `LineChart`, `AreaChart`, and `TimeSeriesChart`. Register product-specific components on the provider:

```tsx
const components = {
  'crm.CustomerCard': CustomerCard,
};

<CtxmillProvider apiBase="/api" components={components}>
  <CtxmillChat agentId={agentId} />
</CtxmillProvider>
```

Ask agents to use those component names with `a2ui-render`. Unknown components render as a diagnostic block instead of crashing the chat.

## HITL

When an agent calls `request-approval`, the AG-UI stream emits:

```json
{
  "type": "CUSTOM",
  "name": "ctxmill.interrupt.requested",
  "interruptId": "interrupt-id",
  "toolCallId": "tool-call-id",
  "toolName": "request-approval",
  "args": { "reason": "Deploy to production?" }
}
```

`useCtxmillChat` exposes this as `pendingHitl`. Calling `resolveHitl('approve')` or `resolveHitl('reject')` posts to CTXMill's interrupt resolution endpoint and resumes the paused run. `approve` and `reject` are the only accepted actions; the former `submit` action was removed.

## Sample App

The repository includes a minimal embed target:

```bash
VITE_CTXMILL_API_BASE=/api \
VITE_CTXMILL_AGENT_ID=<agent-id> \
pnpm -C packages/examples/react-embed-chat dev
```

The sample exercises the same surfaces a downstream consumer needs: AG-UI streaming, A2UI component registration, and HITL resolution.

## Integration Checklist

1. Put CTXMill behind the same origin as your app or configure CORS for the app origin.
2. Use `threadId` when your product already owns conversation ids; omit it when CTXMill should allocate them.
3. Forward auth with `headers` or `CtxmillClient`.
4. Register any product-specific A2UI components before exposing prompts that mention them.
5. Keep the composer disabled while `isRunning` or `pendingHitl` is set.
