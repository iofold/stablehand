# @ctxmill/react

React chat state and components for CTXMill's strict canonical AG-UI stream.

```tsx
import { CtxmillChat, CtxmillProvider } from '@ctxmill/react';

export function AgentChat() {
  return (
    <CtxmillProvider apiBase="/api">
      <CtxmillChat agentId="reconciler" />
    </CtxmillProvider>
  );
}
```

The reducer consumes the same event union as `@ctxmill/contracts`. Interrupts
use durable `interruptId`/`turnId`/`conversationId` identities, text uses
`delta`, and tool completion uses `TOOL_CALL_RESULT`.
