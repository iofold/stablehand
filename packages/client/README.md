# @ctxmill/client

Strict CTXMill clients sharing one authenticated, validated transport.

Use `CtxmillControlClient` in a trusted server:

```ts
import { CtxmillControlClient } from '@ctxmill/client/control';

const ctxmill = new CtxmillControlClient({
  apiBase: 'https://platform.example.com/api',
  token: () => process.env.CTXMILL_API_TOKEN!,
});

const agents = await ctxmill.agents.list();
const turn = await ctxmill.turns.startBackground(
  agents[0]!.id,
  { task: 'Close April', requestedTurnId: crypto.randomUUID() },
  { idempotencyKey: crypto.randomUUID() },
);
```

Use `CtxmillAgUiClient` at an AG-UI boundary:

```ts
import { CtxmillAgUiClient } from '@ctxmill/client/ag-ui';

const ctxmill = new CtxmillAgUiClient({ apiBase: '/api' });
for await (const event of ctxmill.streamAgentRun(input)) {
  render(event);
}
```

Safe reads retry transient failures by default. Mutations never retry
automatically. `agentEvents.stream()` preserves SSE IDs, accepts
`lastEventId`, and yields heartbeat frames. Aborting a stream only disconnects
the caller; `cancelTurn()` is the explicit execution-cancellation operation.
