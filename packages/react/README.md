# @stablehand/react

React chat state and components for Stablehand's strict canonical AG-UI stream.

```tsx
import { StablehandChat, StablehandProvider } from '@stablehand/react';

export function AgentChat() {
  return (
    <StablehandProvider apiBase="/api">
      <StablehandChat agentId="reconciler" />
    </StablehandProvider>
  );
}
```

The reducer consumes the same event union as `@stablehand/contracts`. Interrupts
use durable `interruptId`/`turnId`/`conversationId` identities, text uses
`delta`, and tool completion uses `TOOL_CALL_RESULT`.
