# CTXMill Event Pipeline - Complete Mapping

## 1. PROTO DEFINITION (sandbox.proto)

**File**: `/path/to/stablehand/packages/proto/ctxmill/sandbox/v1/sandbox.proto`

### AgentEvent Oneof
```protobuf
message AgentEvent {
  oneof event {
    TextDelta text_delta = 1;
    ToolCallStart tool_call_start = 2;
    ToolCallEnd tool_call_end = 3;
    ApprovalNeeded approval_needed = 4;
    ApprovalResolved approval_resolved = 5;
    ErrorEvent error = 6;
    DoneEvent done = 7;
  }
}
```

### Message Types
```protobuf
message TextDelta {
  string content = 1;
}

message ToolCallStart {
  string id = 1;
  string name = 2;
  string args_json = 3;
}

message ToolCallEnd {
  string id = 1;
  string result = 2;
  optional string error = 3;
  int64 duration_ms = 4;
}

message ApprovalNeeded {
  string id = 1;
  string tool_name = 2;
  string args_json = 3;
}

message ApprovalResolved {
  string id = 1;
  string action = 2;
}

message ErrorEvent {
  string message = 1;
  optional string stack_trace = 2;
  string category = 3;
}

message DoneEvent {
  optional string result = 1;
  optional TokenUsage usage = 2;
  bool interrupted = 3;
}

message TokenUsage {
  int64 input_tokens = 1;
  int64 output_tokens = 2;
  int64 total_tokens = 3;
  optional double cost = 4;
}
```

---

## 2. TYPESCRIPT UNION TYPE (harness/types.ts)

**File**: `/path/to/stablehand/packages/ctxmill/src/harness/types.ts`

### AgentEvent Union
```typescript
export type AgentEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call_start'; id: string; name: string; args: unknown }
  | { type: 'tool_call_end'; id: string; result: string; error?: string; durationMs: number }
  | { type: 'approval_needed'; id: string; tool: string; args: unknown }
  | { type: 'approval_resolved'; id: string; action: 'approve' | 'reject' }
  | { type: 'error'; error: string }
  | { type: 'done'; result?: string; usage?: TokenUsage };
```

### TokenUsage Interface
```typescript
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost?: number;
}
```

---

## 3. PROTO → TYPESCRIPT CONVERSION (proto-convert.ts)

**File**: `/path/to/stablehand/packages/ctxmill/src/sandbox/proto-convert.ts`

### Function: `agentEventToProto()`
Wraps internal AgentEvent in proto StartRunResponse envelope with sequence, timestamp, runId.

### Function: `convertAgentEvent()`
**Switch statement mapping each AgentEvent type to proto:**

```typescript
case 'text_delta':
  → TextDeltaSchema { content }

case 'tool_call_start':
  → ToolCallStartSchema { id, name, argsJson: JSON.stringify(args) }

case 'tool_call_end':
  → ToolCallEndSchema { id, result, error?, durationMs: BigInt }

case 'approval_needed':
  → ApprovalNeededSchema { id, toolName: tool, argsJson: JSON.stringify(args) }

case 'approval_resolved':
  → ApprovalResolvedSchema { id, action }

case 'error':
  → ErrorEventSchema { message: error, category: 'runtime' }

case 'done':
  → DoneEventSchema { result?, usage?, interrupted: false }
```

**Key Detail**: Error events hardcode `category: 'runtime'` in the main case and `'internal'` in the fallback default case.

---

## 4. PROTO → AG-UI CONVERSION (sandbox-run-service.ts)

**File**: `/path/to/stablehand/packages/ctxmill/src/orchestrator/sandbox-run-service.ts`

### Function: `convertProtoToAGUI()`
**Switch statement mapping proto AgentEvent to AGUIEvent(s):**

```typescript
case 'textDelta':
  → TEXT_MESSAGE_START (if not already started)
  → TEXT_MESSAGE_CONTENT { content }

case 'toolCallStart':
  → TEXT_MESSAGE_END (if text block open)
  → TOOL_CALL_START { toolCallId, toolName }
  → TOOL_CALL_ARGS { toolCallId, args: argsJson }

case 'toolCallEnd':
  → TOOL_CALL_RESULT { toolCallId, result, durationMs }

case 'approvalNeeded':
  → CUSTOM { subtype: 'interrupted', toolCallId, toolName, args, _pauseHint: 'schedule' }

case 'approvalResolved':
  → CUSTOM { subtype: 'interrupt_resolved', toolCallId, action, _pauseHint: 'cancel' }

case 'error':
  → RUN_ERROR { error: message }

case 'done':
  → TEXT_MESSAGE_END (if text block open)
  → (handled by caller as RUN_FINISHED/RUN_FAILED)
```

**State Machine**: Tracks `textStarted`, `currentTextContent` to frame text blocks properly.

---

## 5. AG-UI EVENT TYPES (shared/src/events.ts)

**File**: `/path/to/stablehand/packages/shared/src/events.ts`

### AGUIEventType Union
```typescript
export type AGUIEventType =
  | 'RUN_STARTED'
  | 'RUN_FINISHED'
  | 'RUN_ERROR'
  | 'RUN_FAILED'
  | 'TEXT_MESSAGE_START'
  | 'TEXT_MESSAGE_CONTENT'
  | 'TEXT_MESSAGE_END'
  | 'TOOL_CALL_START'
  | 'TOOL_CALL_ARGS'
  | 'TOOL_CALL_END'
  | 'TOOL_CALL_RESULT'
  | 'STATE_DELTA'
  | 'HITL_PAUSE'
  | 'CUSTOM';
```

### AGUIEvent Interface
```typescript
export interface AGUIEvent {
  type: AGUIEventType;
  timestamp: number;
  runId: string;
  [key: string]: unknown;
}
```

---

## 6. HARNESS EMISSION POINTS

### OpenAI Agents (openai-agents.ts)
**File**: `/path/to/stablehand/packages/ctxmill/src/harness/openai-agents.ts`

Yields:
- `{ type: 'text_delta', content: delta }`
- `{ type: 'tool_call_start', id, name, args }`
- `{ type: 'done', usage }`
- `{ type: 'error', error: String(err) }`

### Claude Agents (claude-agents.ts)
**File**: `/path/to/stablehand/packages/ctxmill/src/harness/claude-agents.ts`

Yields:
- `{ type: 'text_delta', content: delta.text }`
- `{ type: 'tool_call_start', id, name, args: fullInput }`
- `{ type: 'tool_call_end', id, result: 'Rejected by user.', durationMs }` (approval rejection)
- `{ type: 'tool_call_end', id, result, durationMs }`
- `{ type: 'done', usage }`
- `{ type: 'error', error: String(err) }`

### Vercel AI (vercel-ai.ts)
**File**: `/path/to/stablehand/packages/ctxmill/src/harness/vercel-ai.ts`

Yields:
- `{ type: 'text_delta', content: delta }`
- `{ type: 'tool_call_start', id, name, args }`
- `{ type: 'tool_call_end', id, result, durationMs }`
- `{ type: 'error', error: String(error) }`
- `{ type: 'done', usage }`

### LangGraph (langgraph.ts)
**File**: `/path/to/stablehand/packages/ctxmill/src/harness/langgraph.ts`

Yields:
- `{ type: 'text_delta', content: textDelta }`
- `{ type: 'tool_call_start', id, name, args }`
- `{ type: 'tool_call_end', id, result, durationMs }`
- `{ type: 'done' }`
- `{ type: 'error', error: String(err) }`

### PI Agent (pi-agent.ts)
**File**: `/path/to/stablehand/packages/ctxmill/src/harness/pi-agent.ts`

Yields:
- Text deltas from PI Agent stream events
- Tool call start/end events
- Done event
- `{ type: 'error', error: String(err) }`

---

## 7. SSE BROADCASTING (sse-broadcaster.ts)

**File**: `/path/to/stablehand/packages/ctxmill/src/orchestrator/sse-broadcaster.ts`

### Event Type Mapping
```typescript
const EVENT_TYPE_MAP: Record<string, AGUIEventType> = {
  'run.started': 'RUN_STARTED',
  'run.text_chunk': 'TEXT_MESSAGE_CONTENT',
  'run.tool_started': 'TOOL_CALL_START',
  'run.tool_result': 'TOOL_CALL_RESULT',
  'run.interrupted': 'CUSTOM',
  'run.interrupt_resolved': 'CUSTOM',
  'run.completed': 'RUN_FINISHED',
};
```

### Broadcast Flow
1. Subscribes to internal TypedEventBus events (run.*)
2. Maps to AGUIEventType via EVENT_TYPE_MAP
3. Broadcasts via SSEManager to connected clients

---

## 8. ERROR HANDLING PATTERNS

### Current Error Category Usage
- **Proto**: `ErrorEvent.category` field (string) — currently hardcoded to `'runtime'` or `'internal'`
- **Test expectations** (sandbox-run-service.test.ts, sandbox-lifecycle-integration.test.ts):
  ```typescript
  { message: 'LLM rate limited', category: 'runtime' }
  ```

### Harness Error Yields
All harnesses catch top-level errors and yield:
```typescript
{ type: 'error', error: String(err) }
```

**No category field in TypeScript union** — only in proto ErrorEvent.

### Conversion Hardcoding (proto-convert.ts, `'error'` case)
```typescript
case 'error':
  return create(AgentEventSchema, {
    event: {
      case: 'error',
      value: create(ProtoErrorEventSchema, {
        message: event.error,
        category: 'runtime',  // ← HARDCODED
      }),
    },
  });
```

---

## 9. INTEGRATION POINTS SUMMARY

| Layer | File | Type | Variants |
|-------|------|------|----------|
| **Proto** | sandbox.proto | oneof AgentEvent | 7 types |
| **TypeScript** | harness/types.ts | union AgentEvent | 7 types |
| **Conversion** | proto-convert.ts | convertAgentEvent() | 7 cases |
| **AG-UI** | sandbox-run-service.ts | convertProtoToAGUI() | 7 cases → 14+ AGUIEvent types |
| **Harnesses** | openai-agents.ts, claude-agents.ts, vercel-ai.ts, langgraph.ts, pi-agent.ts | yield statements | 7 types emitted |
| **Broadcasting** | sse-broadcaster.ts | EVENT_TYPE_MAP | Maps internal events to AGUIEventType |
| **AG-UI Types** | shared/src/events.ts | AGUIEventType | 15 types |

---

## 10. ADDING NEW EVENT TYPES - CHECKLIST

To add a new event type (e.g., `text_start`, `text_end`, `tool_call_args_delta`):

1. **Proto** (sandbox.proto):
   - Add new message type (e.g., `message TextStart { ... }`)
   - Add to `AgentEvent` oneof (e.g., `TextStart text_start = 8;`)

2. **TypeScript** (harness/types.ts):
   - Add variant to `AgentEvent` union (e.g., `| { type: 'text_start' }`)

3. **Conversion** (proto-convert.ts):
   - Add case in `convertAgentEvent()` switch
   - Create proto message via schema

4. **AG-UI Conversion** (sandbox-run-service.ts):
   - Add case in `convertProtoToAGUI()` switch
   - Yield appropriate AGUIEvent(s)
   - Update state machine if needed (textStarted, etc.)

5. **Harnesses** (all 5 harness files):
   - Add yield statement where event should be emitted
   - Ensure consistent field names and types

6. **AG-UI Types** (shared/src/events.ts):
   - Add new AGUIEventType if needed
   - Update AGUIEvent interface if new fields required

7. **SSE Broadcasting** (sse-broadcaster.ts):
   - Add mapping in EVENT_TYPE_MAP if using internal event bus

8. **Tests**:
   - Update proto roundtrip tests
   - Update conversion tests
   - Update harness tests

---

## 11. CURRENT GAPS & OPPORTUNITIES

### Missing in TypeScript Union
- `error` type has no `category` field (only in proto)
- No `stack_trace` field in TypeScript (only in proto)

### Hardcoded Values
- Error category always `'runtime'` in proto-convert.ts `'error'` case
- Fallback category `'internal'` in proto-convert.ts default case

### Not Yet Implemented
- `text_start` / `text_end` events (state machine exists in sandbox-run-service.ts but no proto events)
- `tool_call_args_delta` (streaming args)
- Lifecycle events (agent_started, agent_finished, etc.)
- Structured error categories (validation, rate_limit, auth, etc.)

