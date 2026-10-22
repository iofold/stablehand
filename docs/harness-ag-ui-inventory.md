# STABLEHAND HARNESS AG-UI INVENTORY
## Historical Snapshot of Harness/Event Support

Generated: 2026-03-25  
Scope: `packages/stablehand/src/harness/` + `packages/proto/` + `packages/examples/kitchen-sink/`

> Historical inventory. This file preserves the 2026-03-25 snapshot and uses
> "current" to mean current at that time. Harness package boundaries and event
> streaming changed after sandbox-daemon extraction and canonical event spine
> work. See `docs/codebase-map.md` and `docs/event-pipeline-mapping.md` for
> current behavior.

---

## HARNESS REGISTRY & SELECTION

**File**: `packages/stablehand/src/harness/registry.ts`  
**DI Container**: `packages/stablehand/src/config/container.ts`

### Historically Registered Harnesses (3/5)
```
harnessRegistry.register(new LangGraphHarness());
harnessRegistry.register(new ClaudeAgentsHarness());
harnessRegistry.register(new PIAgentHarness());
```

**Planned but NOT shipped**: OpenAI Agents, Vercel AI  
**Selection**: Via agent manifest `spec.harness` field (string name match)

---

## 1. LANGGRAPH HARNESS

**File**: `packages/stablehand/src/harness/langgraph.ts` (411 lines)  
**Export**: `LangGraphHarness`, `LangGraphConfigSchema`  
**Name ID**: `'langgraph'`

### Configuration Schema
```typescript
{
  provider: 'openai' | 'anthropic' | 'google' (default: 'openai')
  model: string (e.g., 'gpt-5.4-mini', 'claude-sonnet-4-6')
  apiKeyRef?: string (e.g., "$secret:OPENAI_API_KEY")
  baseUrl?: string (custom endpoint)
  temperature?: number (0-2)
  maxTokens?: number
  topP?: number (0-1)
  reasoning?: 'off' | 'low' | 'medium' | 'high'
  subagents?: array
}
```

### AG-UI Event Capabilities
| Event Type | Emitted | Description |
|---|---|---|
| **text_delta** | ✅ | Streamed text from `on_chat_model_stream` |
| **tool_call_start** | ✅ | Via `on_tool_start` with tool name & args |
| **tool_call_end** | ✅ | Via `on_tool_end` with result & duration |
| **tool_call_end (error)** | ✅ | Via `on_tool_error` with error message |
| **message_committed** | ✅ | After accumulating full assistant text |
| **done** | ✅ | Signal completion |
| **approval_needed** | ✅ | Via `requiresApproval` tool wrapper + callback |
| **approval_resolved** | ✅ | After HITL callback response |

### Key Features Claimed In This Snapshot
- **Backend**: `LocalShellBackend` (filesystem + shell execution)
- **Native Tool Policy**: `nativeToolPolicy` applies the common `all`/`allow`/`deny`/`none` contract through `wrapModelCall`/`wrapToolCall` middleware on the agent and every subagent (including deepagents' general-purpose subagent); denied tools are never offered and calls to them are refused. The backend follows the policy: `LocalShellBackend` only when `execute` is allowed, `FilesystemBackend` when only file tools are, and deepagents' in-memory `StateBackend` otherwise. Name `task` to use subagents
- **Knowledge Context**: Stub (no real knowledge lookup)
- **Transcript**: Maintains full history, passes to SDK each turn
- **Skills**: Historical claim; current Stablehand does not auto-seed `.stablehand/skills`
- **Stateless**: Creates fresh agent per turn (no session state)

### Tool Execution Flow
1. Tool defs wrapped as LangChain tools
2. Execution goes through harness handler directly (no tool proxy)
3. HITL approval checked in wrapper before execution
4. Result serialized back to string

### Example Agent (Kitchen Sink)
**File**: `packages/examples/kitchen-sink/agents/langgraph-agent/agent.yaml`
```yaml
harness: langgraph
harnessConfig:
  provider: openai
  model: gpt-5.4-mini
  apiKeyRef: "$secret:OPENAI_API_KEY"
tools:
  - ref: calculator
  - ref: weather
  - ref: emit-event
  - ref: list-directory
  - ref: search-files
  - ref: execute-trade
nativeToolPolicy:
  policy: deny
  names: [execute]
```

---

## 2. CLAUDE AGENTS HARNESS

**File**: `packages/stablehand/src/harness/claude-agents.ts` (864 lines)  
**Export**: `ClaudeAgentsHarness`, `ClaudeAgentsConfigSchema`  
**Name ID**: `'claude-agents'`

### Configuration Schema
```typescript
{
  provider?: string (default: Anthropic)
  model: string (e.g., 'claude-sonnet-4-6')
  apiKeyRef?: string (e.g., "$secret:ANTHROPIC_API_KEY")
  baseUrl?: string (custom endpoint)
  maxTurns?: number (iteration limit)
}
```

### AG-UI Event Capabilities
| Event Type | Emitted | Description |
|---|---|---|
| **text_delta** | ✅ | Via `content_block_delta` stream events |
| **tool_call_start** | ✅ | On `content_block_start` (tool_use blocks) |
| **tool_call_end** | ✅ | Extracted from `user` message tool results |
| **tool_call_end (error)** | ✅ | When result `is_error=true` |
| **message_committed** | ✅ | After accumulating assistant text blocks |
| **done** | ✅ | On `result` message with usage data |
| **approval_needed** | ✅ | Via `requiresApproval` tool, queued via MCP |
| **approval_resolved** | ✅ | After approval callback resolution |

### Key Features
- **SDK**: `@anthropic-ai/claude-agent-sdk` (query + MCP integration)
- **MCP Server**: `createSdkMcpServer` hosts tools for agent
- **Native Tool Policy**: `nativeToolPolicy` maps `allow`/`none` to the SDK `tools` option (the exact built-in set the model sees; `[]` for `none`) and `deny` to `disallowedTools`; `allowedTools` only auto-approves the allowed built-ins plus `mcp__stablehand__*`. Name `Agent` to use configured subagents and `Skill` to use project skills; subagents never get built-ins the parent lacks
- **Tool Location**: Native tools (e.g., Read, Write, Edit, Bash) auto-populated from SDK
- **Knowledge Context**: Stub
- **Stateless**: Fresh agent per turn
- **Stream Mapping**: Complex state tracking for buffering tool args during JSON deltas

### Tool Execution Flow
1. Tools wrapped as MCP tools via `convertToolsWithSDK()`
2. Zod schema required → converted to SDK schema
3. HITL approval events queued separately (async)
4. Result returned as text block via MCP response

### Example Agent (Kitchen Sink)
**File**: `packages/examples/kitchen-sink/agents/claude-agent/agent.yaml`
```yaml
harness: claude-agents
harnessConfig:
  provider: anthropic
  model: claude-sonnet-4-6
  apiKeyRef: "$secret:ANTHROPIC_API_KEY"
  temperature: 0.3
tools:
  - ref: emit-event
nativeToolPolicy:
  policy: allow
  names: [Read, Write, Edit, Bash, Grep, Glob]
```

---

## 3. PI AGENT HARNESS

**File**: `packages/stablehand/src/harness/pi-agent.ts` (588 lines)  
**Export**: `PIAgentHarness`, `PIAgentConfigSchema`  
**Name ID**: `'pi-agent'`

### Configuration Schema
```typescript
{
  provider: 'openai' | 'anthropic' | 'google' (default: 'openai')
  model: string (e.g., 'gpt-5.4-mini')
  apiKeyRef?: string (e.g., "$secret:OPENAI_API_KEY")
  baseUrl?: string (custom endpoint)
}
```

### AG-UI Event Capabilities
| Event Type | Emitted | Description |
|---|---|---|
| **text_delta** | ✅ | Via PI SDK `message_update` with `text_delta` |
| **tool_call_start** | ✅ | On `tool_execution_start` event |
| **tool_call_end** | ✅ | On `tool_execution_end` event |
| **tool_call_end (error)** | ✅ | When PI reports `isError=true` |
| **message_committed** | ✅ | After collecting assistant text deltas |
| **done** | ✅ | On `agent_end` with token usage |
| **approval_needed** | ✅ | Via `requiresApproval` tool wrapper |
| **approval_resolved** | ✅ | After approval callback |

### Key Features
- **SDK**: `@mariozechner/pi-coding-agent` (native tools + custom tools)
- **Native Tools**: Read, Bash, Edit, Write, Grep, Find, Ls (selected by the common native-tool policy)
- **Tool Conversion**: Zod → TypeBox (custom `zodToTypeBox()` converter)
- **Knowledge Context**: Stub
- **Session Lifecycle**: PI Session with `subscribe()` listener + `prompt()` API
- **Tool Update Context**: Mutable `ConvertToolsContext` allows updating approval handler per turn

### Tool Execution Flow
1. Custom tools converted via `convertTools()` + TypeBox schema
2. Native tools selected by `nativeToolPolicy`
3. Tool execution happens in PI SDK (streaming events)
4. Approval check happens in tool `execute` callback
5. Result formatted as PI-compatible `{ content, details }`

### Example Agent (Kitchen Sink)
**File**: `packages/examples/kitchen-sink/agents/pi-agent/agent.yaml`
```yaml
harness: pi-agent
harnessConfig:
  provider: openai
  model: gpt-5.4-mini
  apiKeyRef: "$secret:OPENAI_API_KEY"
tools:
  - ref: emit-event
nativeToolPolicy:
  policy: allow
  names: [read, bash, edit, write]
```

---

## PROTO AG-UI EVENT DEFINITIONS

**File**: `packages/proto/stablehand/sandbox/v1/sandbox.proto`

### SessionEvent Message Types (Carrier)
```protobuf
message SessionEvent {
  oneof payload {
    AgentEvent ag_ui_event = 1;          // Rich AG-UI events
    MessageCommitted message_committed = 2;  // Persistence event
    TurnCompleted turn_completed = 3;    // Turn lifecycle
    TurnFailed turn_failed = 4;          // Error event
  }
}
```

### AgentEvent Types (7 event families)
```protobuf
message AgentEvent {
  oneof event {
    TextDelta text_delta = 1;                    // Streaming text
    ToolCallStart tool_call_start = 2;           // Tool invocation start
    ToolCallEnd tool_call_end = 3;               // Tool completion (with error field)
    ApprovalNeeded approval_needed = 4;          // HITL interrupt
    ApprovalResolved approval_resolved = 5;      // HITL resolution
    ErrorEvent error = 6;                        // Harness error
    DoneEvent done = 7;                          // Completion + usage
  }
}
```

### Event Conversion Chain
**Proto → Internal → AG-UI (SSE)**

```
AgentEvent (harness emits)
  ↓ (harness/types.ts)
HarnessSessionConfig + AgentEvent stream
  ↓ (sandbox/proto-convert.ts convertAgentEvent())
ProtoAgentEvent (oneof payload)
  ↓ (gRPC SessionEvent)
Orchestrator receives SessionEvent
  ↓ (orchestrator/sse-broadcaster.ts)
SSE event → React UI
```

### Proto → TS Conversion Map
| Proto Type | TS Type | SSE Event | UI Handler |
|---|---|---|---|
| TextDelta | text_delta | `text_delta` | Stream accumulator |
| ToolCallStart | tool_call_start | `tool_call_start` | Tool card open |
| ToolCallEnd | tool_call_end | `tool_call_end` | Tool card complete |
| ApprovalNeeded | approval_needed | `approval_needed` | HITL approval card |
| ApprovalResolved | approval_resolved | `approval_resolved` | Approval result |
| ErrorEvent | error | `error` | Error banner |
| DoneEvent | done | `done` | Run complete |

---

## HARNESS COMPARISON MATRIX

| Capability | LangGraph | Claude Agents | PI Agent |
|---|---|---|---|
| **Text Streaming** | ✅ | ✅ | ✅ |
| **Tool Call Streaming** | ✅ | ✅ (complex) | ✅ |
| **HITL Approval** | ✅ | ✅ (queued) | ✅ |
| **Native Tools** | Via SDK | SDK-provided | SDK-provided |
| **Tool Allowlist** | ❌ (via blocklist middleware) | ✅ | ✅ |
| **Token Usage Tracking** | ❌ | ✅ | ✅ |
| **Reasoning Modes** | ✅ (openai) | ❌ | ❌ |
| **Stateful Session** | ❌ (stateless) | ❌ (stateless) | ⚠️ (limited) |
| **Shell Backend** | ✅ (LocalShellBackend) | Via native Bash | Via native Bash |
| **Knowledge Lookup** | Stub only | Stub only | Stub only |
| **Skill Loading** | Historical claim only | ❌ | ❌ |
| **Subagents** | ✅ (config) | ✅ (config) | ❌ |

---

## SHARED AG-UI TYPES

**File**: `packages/shared/src/events.ts`  
**Re-exported**: `packages/stablehand/src/events/types.ts`

### AG-UI Event Contract (All Harnesses)
```typescript
type AgentEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call_start'; id: string; name: string; args: unknown }
  | { type: 'tool_call_end'; id: string; result: string; error?: string; durationMs: number }
  | { type: 'approval_needed'; id: string; tool: string; args: unknown }
  | { type: 'approval_resolved'; id: string; action: 'approve' | 'reject' }
  | MessageCommittedAgentEvent
  | { type: 'error'; error: string }
  | { type: 'done'; result?: string; usage?: TokenUsage };
```

### Message Committed Event
```typescript
interface MessageCommittedAgentEvent {
  type: 'message_committed';
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
  toolCallId?: string;
  turnId: string;
  messageSeq: number;
}
```

### Token Usage
```typescript
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost?: number;  // Optional, populated by some harnesses
}
```

---

## TOOL INTEGRATION PATTERNS

### Common to All 3 Harnesses
1. **Tool Definition Interface** (`packages/stablehand/src/tool/types.ts`):
   ```typescript
   interface ToolDefinition {
     name: string;
     description: string;
     input: ZodType;  // Must be Zod for all harnesses
     handler: (args, ctx) => Promise<string>;
     requiresApproval?: boolean;
   }
   ```

2. **HITL Approval Pattern**:
   - Tool marked with `requiresApproval: true`
   - Harness emits `approval_needed` event
   - Orchestrator pauses, awaits user response via UI
   - Harness continues on approval callback

3. **Execution Context** (`packages/stablehand/src/tool/types.ts`):
   ```typescript
   interface ToolContext {
     agentId: string;
     conversationId: string;
     workspaceDir: string;
     knowledge: KnowledgeContext;  // Stub
   }
   ```

### Harness-Specific Tool Integration
| Aspect | LangGraph | Claude Agents | PI Agent |
|---|---|---|---|
| **Wrapper** | LangChain tools | MCP tools | TypeBox tools |
| **Schema Required** | Zod | Zod | Zod |
| **Execution Location** | In harness | In SDK (MCP) | In SDK |
| **Approval Async** | Inline | Queued events | Inline |
| **Result Format** | String via handler | Text block via MCP | PI result object |

---

## UNSUPPORTED HARNESSES (Planned)

### OpenAI Agents
- **Status**: Not implemented
- **Planned Model**: OpenAI `gpt-5` series
- **Expected Features**: Similar to Claude Agents (native tools, MCP integration)

### Vercel AI
- **Status**: Not implemented
- **Expected Based on Vercel AI SDK**: Lightweight streaming agent
- **Planned Features**: Streaming text, tool calls, language model abstraction

---

## AGENT-BROWSER E2E TEST TARGETS

### Per-Harness Coverage Needed
1. **Text Streaming**: Verify `text_delta` events appear in UI
2. **Tool Calls**: Verify tool cards appear with args + results
3. **Approval Flow**: Trigger tool requiring approval, verify card, approve/reject
4. **Errors**: Harness error → error banner
5. **Message Persistence**: `message_committed` → chat history
6. **Token Usage**: When available, verify display

### Cross-Harness Scenarios
- Same query across 3 harnesses → compare event counts
- Tool blocklist enforcement → blocked tool not available
- Native tool selection → only allowlisted tools present
- Multi-turn conversation → transcript maintained correctly

---

## DIAGNOSTIC CHECKLIST

### If Harness Emits Only 1 Event
**Likely Cause**: Immediate error  
**Debug**:
1. Check container logs: `docker logs <container-id>`
2. Verify secrets injected: `STABLEHAND_LOG_SECRETS=1`
3. Check `message_committed` — should always be present

### If AG-UI Events Not Appearing
**Likely Cause**: Proto conversion failure  
**Check**:
1. `packages/stablehand/src/sandbox/proto-convert.ts convertAgentEvent()` coverage
2. Proto generation: `pnpm -C packages/proto build`
3. SSE streaming: `/api/agents/:id/stream` endpoint

### If Tool Calls Don't Stream
**LangGraph**: Check `normalizeStreamTextDeltas()` handling  
**Claude**: Verify stream state tracking in `mapSDKMessage()`  
**PI**: Verify event subscription in `deliverTurn()`

---

## FILES REFERENCE

| Purpose | Path |
|---|---|
| Harness Interface | `packages/stablehand/src/harness/types.ts` |
| LangGraph Implementation | `packages/stablehand/src/harness/langgraph.ts` |
| Claude Agents Implementation | `packages/stablehand/src/harness/claude-agents.ts` |
| PI Agent Implementation | `packages/stablehand/src/harness/pi-agent.ts` |
| Harness Registry | `packages/stablehand/src/harness/registry.ts` |
| Shared Utilities | `packages/stablehand/src/harness/shared.ts` |
| Proto Definitions | `packages/proto/stablehand/sandbox/v1/sandbox.proto` |
| Proto Conversion | `packages/stablehand/src/sandbox/proto-convert.ts` |
| Event Types (shared) | `packages/shared/src/events.ts` |
| Tool Types | `packages/stablehand/src/tool/types.ts` |
| Kitchen Sink Agents | `packages/examples/kitchen-sink/agents/` |
| Kitchen Sink Tools | `packages/examples/kitchen-sink/tools/` |
