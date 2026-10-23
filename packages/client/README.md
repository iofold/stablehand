# @stablehand/client

Strict Stablehand clients sharing one authenticated, validated transport.

Use `StablehandControlClient` in a trusted server:

```ts
import { StablehandControlClient } from '@stablehand/client/control';

const stablehand = new StablehandControlClient({
  apiBase: 'https://platform.example.com/api',
  token: () => process.env.STABLEHAND_API_TOKEN!,
});

const agents = await stablehand.agents.list();
const turn = await stablehand.turns.startBackground(
  agents[0]!.id,
  { task: 'Close April', requestedTurnId: crypto.randomUUID() },
  { idempotencyKey: crypto.randomUUID() },
);
```

Wait for a turn to finish, or find every turn that carries a tag:

```ts
// Resolves once the turn is COMPLETED, ERROR or CANCELLED; check turn.status.
const done = await stablehand.waitForTurn(turn.turnId, { timeoutMs: 30 * 60_000 });

let cursor: string | undefined;
do {
  const page = await stablehand.turns.search({
    tags: { campaign: 'bugfarm-1' },
    status: ['RUNNING', 'QUEUED'],
    cursor,
  });
  for (const t of page.turns) console.log(t.agentId, t.id, t.status);
  cursor = page.nextCursor;
} while (cursor);
```

`waitForTurn` listens on the agent's event stream so it returns as soon as the
turn ends, and checks the turn with a growing delay in case the stream is
unavailable. Brief outages are retried until the timeout; a missing turn or a
refused key fails at once.

For an extension, inject a dedicated scoped key instead of the operator master
token:

```ts
import { StablehandApiError, StablehandControlClient } from '@stablehand/client';

const stablehand = new StablehandControlClient({
  apiBase: process.env.STABLEHAND_API_URL,
  token: () => process.env.STABLEHAND_EXTENSION_TOKEN!,
});

try {
  await stablehand.artifacts.list();
} catch (error) {
  if (error instanceof StablehandApiError && error.status === 403) {
    console.error('Required capability:', error.requiredCapability);
  }
  throw error;
}
```

`requiredCapability` is a capability verb for a missing grant and `null` for a
master-only route. A scoped integration should probe an endpoint it actually
uses; `config.get()` is master-only. See the repository's
[scoped-key guide](../../docs/scoped-api-keys.md) for the capability map and
rotation contract.

Use `StablehandAgUiClient` at an AG-UI boundary:

```ts
import { StablehandAgUiClient } from '@stablehand/client/ag-ui';

const stablehand = new StablehandAgUiClient({ apiBase: '/api' });
for await (const event of stablehand.streamAgentRun(input)) {
  render(event);
}
```

Safe reads retry transient failures by default. Mutations never retry
automatically. `agentEvents.stream()` preserves SSE IDs, accepts
`lastEventId`, and yields heartbeat frames. Aborting a stream only disconnects
the caller; `cancelTurn()` is the explicit execution-cancellation operation.
