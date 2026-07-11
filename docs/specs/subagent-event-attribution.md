# Subagent Event Attribution: Cross-Harness Analysis

> Sources: distilled from the retired research docs `claude-sdk-subagent-analysis.md` and `langgraph-subagent-event-analysis.md` (see git history).

**Status:** Research (pre-implementation)  
**Date:** 2026-04-08  
**Scope:** All 3 harnesses — event stream, persistence, UI rendering

---

## Problem Statement

ctxmill supports subagents in 2 of 3 harnesses (LangGraph and Claude Agents). When a subagent runs, its text generation, tool calls, and events are **indistinguishable from the main agent's output** throughout the entire pipeline — harness → proto → orchestrator → database → UI.

This means:
- Budget/cost tracking middleware cannot attribute spend to specific subagents
- Tool blocklist middleware cannot apply per-subagent policies
- The UI renders one flat conversation with no indication of which agent said what
- DB queries cannot filter messages by source agent

---

## Part 1: Current State Per Harness

### LangGraph — Subagent support via deepagents `task` tool

**SDK-level attribution: ✅ Rich, available but unused**

LangGraph's `streamEvents` v2 API provides subagent attribution in two places:

1. **Event namespace** — the `event.name` field uses pipe-delimited paths:
   ```
   Main agent:        "updates"
   Subagent:          "updates|tools:call_abc123"
   Nested subagent:   "updates|tools:parent_id|tools:child_id"
   ```

2. **Checkpoint metadata** — `event.metadata.langgraph_checkpoint_ns` identifies the graph node

3. **DeepAgents SubagentManager** — a 1019-line class in deepagents that:
   - Parses namespaces to identify subagent events
   - Maintains per-subagent message managers
   - Tracks subagent status (pending/running/complete/error)
   - Supports nested subagents with parent-child relationships

**ctxmill harness gap:**

The LangGraph harness event loop (`langgraph.ts:226-356`) only checks `ev.event` (the event type like `on_chat_model_stream`). It does **not** inspect:
- `ev.name` — the namespace path identifying the source agent
- `ev.metadata.langgraph_node` — the graph node that produced the event
- `ev.metadata.langgraph_checkpoint_ns` — the checkpoint namespace

All events from all agents are yielded as flat `AgentEvent` objects with no source attribution.

**Subagent nesting:** Deepagents supports arbitrary nesting depth. The namespace path grows with each level.

---

### Claude Agents — Subagent support via `AgentDefinition` + `Agent` tool

**SDK-level attribution: ✅ Built-in, explicit field — but unused**

The Claude Agent SDK has **first-class** subagent support. Every SDK message carries a `parent_tool_use_id` field:

```typescript
type SDKAssistantMessage = {
  type: 'assistant';
  parent_tool_use_id: string | null;  // null = main agent, "<uuid>" = subagent
  content: ContentBlock[];
  // ...
};
```

When Claude invokes a subagent, it emits a `tool_use` block with `name: 'Agent'`:
```json
{
  "type": "tool_use",
  "id": "tool-123",
  "name": "Agent",
  "input": { "subagent_type": "code-reviewer", "prompt": "..." }
}
```

All subsequent messages from that subagent have `parent_tool_use_id: "tool-123"`.

**ctxmill harness gap:**

The Claude harness (`claude-agents.ts`) receives `parent_tool_use_id` from the SDK but only uses it as a fallback for `tool_use_id` mapping (line 753). It does **not**:
- Propagate `parent_tool_use_id` to `AgentEvent`
- Distinguish main agent events from subagent events
- Track which subagent produced which message

**Subagent nesting:** Claude SDK limits to depth 1 — subagents cannot spawn further subagents.

---

### PI Agent — No subagent support

**SDK-level attribution: N/A**

The PI Agent SDK (`@mariozechner/pi-coding-agent`) has **no subagent concept**. From the README:

> "Pi ships with powerful defaults but **skips features like sub agents and plan mode**."

Event types are flat: `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_end`. No subagent, delegation, or nesting events exist.

The `ConvertToolsContext` interface has no depth or nesting tracking.

**No attribution gap** — there are no subagents to attribute.

---

## Part 2: The Pipeline Gap

```
SDK events (rich attribution)
  │
  │  LangGraph: ev.name = "updates|tools:call_abc123"
  │  Claude:    msg.parent_tool_use_id = "tool-123"
  │  PI Agent:  N/A (no subagents)
  │
  ▼
Harness event loop                              ← ATTRIBUTION LOST HERE
  │  Checks event type only (on_chat_model_stream, tool_use, etc.)
  │  Does NOT extract source agent info
  │
  ▼
AgentEvent type (types.ts)                      ← NO FIELD FOR IT
  │  { type: 'text_delta' | 'tool_call_start' | ... }
  │  No source, parentToolCallId, namespace, or depth field
  │
  ▼
Proto SessionEvent (sandbox.proto)              ← NO FIELD FOR IT
  │  1:1 mapping of AgentEvent, no metadata enrichment
  │
  ▼
AG-UI event types (shared/events.ts)            ← NO FIELD FOR IT
  │  AGUIEvent, MessageCommittedEvent
  │  No source or subagent fields
  │
  ▼
Database messages table (schema-pg.ts)          ← NO COLUMN FOR IT
  │  agentId, role, content, toolCalls, parts
  │  No source_agent, parent_tool_call_id, or depth
  │
  ▼
UI (SessionThread.tsx)                          ← NO RENDERING FOR IT
  │  Renders by role only (user/assistant/tool)
  │  No visual distinction for subagent output
```

---

## Part 3: Comparison Matrix

| Dimension | LangGraph | Claude Agents | PI Agent |
|-----------|-----------|---------------|----------|
| **Subagent support** | ✅ deepagents `task` tool | ✅ `AgentDefinition` + `Agent` tool | ❌ None |
| **Config field** | `subagents: [{name, description, systemPrompt, ...}]` | `subagents: {name: {description, prompt, tools, ...}}` | N/A |
| **SDK attribution mechanism** | Event namespace + checkpoint metadata | `parent_tool_use_id` on every message | N/A |
| **Attribution granularity** | Per-event (namespace path) | Per-message (parent tool use ID) | N/A |
| **Nesting depth** | Unlimited (namespace grows) | 1 level (SDK constraint) | N/A |
| **ctxmill uses attribution** | ❌ No | ❌ No | N/A |
| **Middleware propagation** | ✅ Custom subagents, ❌ GP subagent | ❌ Not applicable (no middleware system) | ✅ Extensions apply to single agent |

---

## Part 4: What Attribution Would Enable

### For Middleware

| Middleware Type | Without Attribution | With Attribution |
|----------------|-------------------|------------------|
| Budget tracker | "Session spent $X" | "Main agent: $2.30, code-reviewer: $0.80, researcher: $1.50" |
| Tool blocklist | Block globally or not at all | "Block `execute` for researcher subagent only" |
| Rate limiter | Limit total tool calls | "Max 50 calls for main agent, 20 per subagent" |
| Audit logger | Flat log | "Subagent 'researcher' called search 12 times" |

### For UI

- Collapsible subagent sections (like Claude Code's `task` tool results)
- Per-subagent token/cost badges
- Visual nesting for multi-level subagents (LangGraph)
- Subagent status indicators (running/complete/error)

### For API/DB

- Query messages by source agent
- Per-subagent analytics (cost, duration, tool usage)
- Subagent-specific conversation history

---

## Part 5: Proposed Solution

### AgentEvent Extension

```typescript
export type AgentEvent =
  | { type: 'text_delta'; content: string; source?: EventSource }
  | { type: 'tool_call_start'; id: string; name: string; args: unknown; source?: EventSource }
  | { type: 'tool_call_end'; id: string; result: string; error?: string; durationMs: number; source?: EventSource }
  | { type: 'message_committed'; role: string; content: string; toolCalls?: ToolCallInfo[]; source?: EventSource }
  | { type: 'done'; result?: string; usage?: TokenUsage; source?: EventSource }
  // ... other event types

interface EventSource {
  agent: string;          // "main" | subagent name (e.g., "code-reviewer", "general-purpose")
  depth: number;          // 0 = main agent, 1 = subagent, 2 = sub-subagent (LangGraph only)
  parentToolCallId?: string;  // The tool_use ID that spawned this subagent
}
```

### Per-Harness Extraction

**LangGraph:**
```typescript
// In the event streaming loop, extract from event namespace
const namespace = ev.name;  // e.g., "updates|tools:call_abc123"
const parts = namespace.split('|');
const source: EventSource = parts.length > 1
  ? { agent: resolveSubagentName(parts), depth: parts.length - 1, parentToolCallId: extractToolCallId(parts) }
  : { agent: 'main', depth: 0 };
```

**Claude Agents:**
```typescript
// In mapSDKMessage, extract from parent_tool_use_id
const source: EventSource = msg.parent_tool_use_id
  ? { agent: resolveAgentName(msg.parent_tool_use_id), depth: 1, parentToolCallId: msg.parent_tool_use_id }
  : { agent: 'main', depth: 0 };
```

**PI Agent:** No change needed — all events are `{ agent: 'main', depth: 0 }`.

### Proto Extension

```protobuf
message EventSource {
  string agent = 1;
  int32 depth = 2;
  optional string parent_tool_call_id = 3;
}

// Add to each relevant event message:
message TextDelta {
  string content = 1;
  optional EventSource source = 10;
}
```

### Database Extension

```sql
ALTER TABLE messages ADD COLUMN source_agent TEXT DEFAULT 'main';
ALTER TABLE messages ADD COLUMN source_depth INTEGER DEFAULT 0;
ALTER TABLE messages ADD COLUMN parent_tool_call_id TEXT;
```

---

## Part 6: Implementation Phases

| Phase | Scope | Effort | Dependencies |
|-------|-------|--------|-------------|
| **1: Types + Proto** | Add `EventSource` to AgentEvent, proto schema, shared types | 1 day | None |
| **2: LangGraph extraction** | Parse event namespace in harness event loop | 0.5 day | Phase 1 |
| **3: Claude extraction** | Extract `parent_tool_use_id` in harness message mapper | 0.5 day | Phase 1 |
| **4: Proto conversion** | Pass `EventSource` through proto-convert pipeline | 0.5 day | Phase 1 |
| **5: DB persistence** | Add columns, update addMessage(), backfill migration | 1 day | Phase 1 |
| **6: API exposure** | Add source fields to ApiMessage and SSE events | 0.5 day | Phases 4-5 |
| **7: UI rendering** | Collapsible subagent sections, badges, nesting | 2 days | Phase 6 |
| **Total** | | **~6 days** | |

---

## Part 7: Open Questions

1. **Should subagent text be collapsible in the UI?** Claude Code collapses subagent output by default. This is good UX for long research subagent runs but might confuse users who expect to see all output.

2. **How to resolve subagent names from LangGraph namespaces?** The namespace contains tool call IDs, not subagent names. We'd need to maintain a mapping from tool call ID → subagent name during the session. DeepAgents' `SubagentManager` already does this — we could either tap into it or replicate the logic.

3. **Should the GP subagent's middleware gap (LangGraph) block this work?** Attribution and middleware propagation are orthogonal features. Attribution can ship first — it documents what exists. Middleware propagation is a separate enhancement.

4. **Per-subagent middleware configuration?** Once attribution exists, middleware could accept per-subagent config:
   ```yaml
   middleware:
     - path: middleware/budget-tracker.ts
       config:
         main: { maxBudget: 10.00 }
         code-reviewer: { maxBudget: 2.00 }
   ```
   This requires both attribution AND the middleware system. Out of scope for now.
