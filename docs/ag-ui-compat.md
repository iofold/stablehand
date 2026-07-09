# AG-UI Protocol Compatibility Layer

CTXMill exposes an AG-UI compatible endpoint that lets downstream consumers use any AG-UI renderer as a drop-in frontend for ctxmill agents.

## Endpoint

```
POST /api/ag-ui/:agentId/run
Content-Type: application/json
```

**Response:** `text/event-stream` (SSE) scoped to the requested run.

## Quick Start

### With `@ag-ui/client` (HttpAgent)

```typescript
import { HttpAgent } from '@ag-ui/client';

const agent = new HttpAgent({
  url: 'http://localhost:3002/api/ag-ui/YOUR_AGENT_ID/run',
});
```

### With `agui-hooks` (React)

```typescript
import { HttpAgent } from '@ag-ui/client';
import { useAgentChat } from 'agui-hooks';

const agent = new HttpAgent({
  url: 'http://localhost:3002/api/ag-ui/YOUR_AGENT_ID/run',
});

function Chat() {
  const { messages, sendMessage, isRunning } = useAgentChat({ agent });

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id}>{m.content}</div>
      ))}
      <input onKeyDown={(e) => {
        if (e.key === 'Enter') sendMessage(e.currentTarget.value);
      }} />
    </div>
  );
}
```

### With CopilotKit

```typescript
import { HttpAgent } from '@ag-ui/client';
import { CopilotChat } from '@copilotkit/react-ui';

const agent = new HttpAgent({
  url: 'http://localhost:3002/api/ag-ui/YOUR_AGENT_ID/run',
});

function App() {
  return <CopilotChat agent={agent} />;
}
```

### With `@assistant-ui/react-ag-ui`

```typescript
import { HttpAgent } from '@ag-ui/client';
import { useAssistantRuntime } from '@assistant-ui/react-ag-ui';
import { Thread } from '@assistant-ui/react';

const agent = new HttpAgent({
  url: 'http://localhost:3002/api/ag-ui/YOUR_AGENT_ID/run',
});

function Chat() {
  const runtime = useAssistantRuntime({ agent });
  return <Thread runtime={runtime} />;
}
```

## Request Body (`RunAgentInput`)

```typescript
{
  threadId?: string;         // Conversation ID; created when supplied and missing
  runId: string;             // Unique run identifier
  messages: Array<{          // Conversation history
    id: string;
    role: 'user' | 'assistant' | 'system' | 'tool' | 'developer';
    content?: string;
    toolCallId?: string;     // For tool response messages
  }>;
  tools?: Array<{            // Tool definitions (informational)
    name: string;
    description: string;
    parameters: unknown;     // JSON Schema
  }>;
  context?: Array<{          // Additional context
    description: string;
    value: string;
  }>;
  state?: unknown;           // Agent state (stored, not used yet)
  forwardedProps?: unknown;  // Pass-through props
}
```

**Requirements:**
- `runId` must be a non-empty string
- `threadId`, when supplied, must be a non-empty string. When omitted, CTXMill creates a conversation and returns it in `MESSAGES_SNAPSHOT.threadId`
- `messages` must contain at least one message with `role: 'user'` and non-empty `content`

## SSE Events Emitted

The stream emits strict AG-UI protocol events:

| Event | When | Key Fields |
|-------|------|------------|
| `MESSAGES_SNAPSHOT` | First event on connect | `messages[]` — full conversation history from DB |
| `RUN_STARTED` | Agent turn begins | `runId`, `threadId` |
| `TEXT_MESSAGE_START` | First text chunk from assistant | `messageId`, `role: 'assistant'` |
| `TEXT_MESSAGE_CONTENT` | Each text delta | `messageId`, `delta` |
| `TEXT_MESSAGE_END` | Text message complete | `messageId` |
| `TOOL_CALL_START` | Tool execution begins | `toolCallId`, `toolCallName` |
| `TOOL_CALL_ARGS` | Tool arguments | `toolCallId`, `delta` (JSON string) |
| `TOOL_CALL_END` | Tool execution complete | `toolCallId`, `result` |
| `RUN_FINISHED` | Agent turn complete | `runId`, `status` |
| `RUN_ERROR` | Agent turn failed | `runId`, `error` |
| `CUSTOM` | A2UI render blocks | `name: 'ctxmill.a2ui.render'`, `block: { id, component, props }` |
| `CUSTOM` | HITL events | `name: 'ctxmill.hitl.requested'` or `name: 'ctxmill.hitl.resolved'` |

### Event Sequence Example

```
data: {"type":"MESSAGES_SNAPSHOT","messages":[...]}

data: {"type":"RUN_STARTED","runId":"...","threadId":"..."}

data: {"type":"TEXT_MESSAGE_START","messageId":"msg-1","role":"assistant"}

data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"Hello"}

data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":", how can I help?"}

data: {"type":"TEXT_MESSAGE_END","messageId":"msg-1"}

data: {"type":"RUN_FINISHED","runId":"...","status":"completed"}
```

## Reconnection

If the SSE connection drops during a long-running agent turn, the client can re-POST with the **same `runId`**:

1. The server detects the run is still active (not completed)
2. Sends a fresh `MESSAGES_SNAPSHOT` with all committed messages
3. Subscribes to live events for the remainder of the run
4. No event replay — snapshots replace the client's state entirely

This follows AG-UI's snapshot-based reconnection model (not event replay).

## A2UI and HITL Custom Events

`a2ui-render` tool results are emitted as ordinary `TOOL_CALL_END` events and as an additional namespaced custom event:

```json
{
  "type": "CUSTOM",
  "name": "ctxmill.a2ui.render",
  "subtype": "a2ui_render",
  "block": {
    "id": "tool-call-id",
    "component": "MetricCard",
    "props": { "title": "Revenue", "value": "$42k" }
  }
}
```

Durable HITL pauses use the same AG-UI custom-event mechanism:

```json
{
  "type": "CUSTOM",
  "name": "ctxmill.hitl.requested",
  "subtype": "hitl_pause",
  "interruptId": "interrupt-id",
  "toolCallId": "tool-call-id",
  "toolName": "request-approval",
  "args": { "reason": "Approve the deployment?" }
}
```

The companion resolution marker is `name: 'ctxmill.hitl.resolved'`.

## What's Different from ctxmill's Native SSE

| Aspect | Native (`/api/agents/:id/stream`) | AG-UI (`/api/ag-ui/:id/run`) |
|--------|-----------------------------------|-------------------------------------|
| Method | GET (persistent EventSource) | POST (per-run) |
| Scope | All runs for an agent, multiplexed | Single run, closes on completion |
| Events | Canonical AG-UI frames plus `CUSTOM name: ctxmill.*` signals | Strict AG-UI protocol |
| Reconnect | Durable `Last-Event-ID` seq replay | Re-POST with same runId -> snapshot |
| Tool results | `TOOL_CALL_END` plus `TOOL_CALL_RESULT` compatibility data | `TOOL_CALL_END` (AG-UI standard) |
| Text lifecycle | `TEXT_MESSAGE_START` -> content -> `TEXT_MESSAGE_END` | `TEXT_MESSAGE_START` -> content -> `TEXT_MESSAGE_END` |

## Not Yet Implemented

- **STATE_SNAPSHOT / STATE_DELTA** — AG-UI state management events (not emitted; agents don't expose shared state yet)
- **STEP_STARTED / STEP_FINISHED** — Multi-step progress events
- **MESSAGES_SNAPSHOT on interval** — Currently only sent at stream start, not periodically

## Architecture

```
POST /api/ag-ui/:id/run
  ↓ parse RunAgentInput
  ↓ resolve agent, conversation, turn
  ↓
SSE response (text/event-stream)
  ├─ MESSAGES_SNAPSHOT (from DB)
  ├─ subscribe to canonical/event-bus flow (filtered by turnId)
  │   ↓ canonical AG-UI frames are written as SSE data lines
  └─ RUN_FINISHED/RUN_ERROR → close connection
```

Source: `packages/ctxmill/src/orchestrator/ag-ui-compat/`
