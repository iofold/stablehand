# Harness Comparison Matrix

This document provides a comprehensive comparison of the three agent harnesses supported by Stablehand: **LangGraph**, **Claude Agents**, and **PI Agent**. Use this guide to choose the best harness for your agent's specific requirements.

## Quick Decision Matrix

| Feature | LangGraph | Claude Agents | PI Agent |
| :--- | :--- | :--- | :--- |
| **SDK Package** | `deepagents` (LangGraph JS) | `@anthropic-ai/claude-agent-sdk` | `@mariozechner/pi-coding-agent` |
| **Default Model** | `gpt-5.4-mini` | `claude-sonnet-4-6` | `gpt-5.4-mini` |
| **Skills** | Workspace-file pattern only | Claude SDK-native `.claude/skills` when present | Workspace-file pattern only |
| **Subagents** | ✅ (Configurable) | ✅ (`harnessConfig.subagents`) | ❌ |
| **Hooks** | ❌ (Planned) | ❌ (Planned) | ❌ (Planned) |
| **Middleware** | ✅ (Tool blocklist) | ❌ | ❌ |
| **Native Tools** | `LocalShellBackend` | SDK-provided (MCP) | SDK-provided |
| **Remote MCP servers** | ✅ (via the orchestrator) | ✅ (via the orchestrator) | ✅ (via the orchestrator) |
| **LangSmith Tracing** | ✅ (Native) | ✅ (Shared AgentEvent tracer) | ✅ (Shared AgentEvent tracer) |
| **HITL/Approval** | ✅ | ✅ (Queued) | ✅ |
| **Streaming** | ✅ | ✅ | ✅ |
| **Checkpoint/Resume** | ✅ | ✅ | ✅ |
| **Image Size** | Smallest (Pure TS) | Largest (Includes Claude Code) | Medium |

## When to Use Each Harness

### LangGraph
**Best for:** Multi-step workflows, tool-heavy agents, and complex agent architectures.
- Use for LangChain-style **Subagents** via deep-agent params (Claude Agents also supports subagents; see below).
- Use if you want a lightweight, pure TypeScript runtime without Python or heavy CLI dependencies.
- Use if you need custom **Middleware** for tool execution (e.g., global blocklists).
- Best for general-purpose agents using OpenAI, Anthropic, or Google models via LangChain.

### Claude Agents
**Best for:** Claude-native workflows and high-fidelity code generation.
- Use if you want the official **Anthropic Agent SDK** experience.
- Use for **Subagents** defined via `harnessConfig.subagents` (passed to the SDK `agents` option).
- Remote MCP servers work the same on every harness: the orchestrator runs the client (see [mcp-servers.md](mcp-servers.md)). The Claude SDK's own `mcpServers` option is not exposed, so tokens stay out of the sandbox.
- Use for tasks requiring deep filesystem access and complex code editing (via native `Edit` and `Bash` tools).
- Best for agents exclusively using Claude models (`claude-sonnet-4-6`, `claude-opus-4-6`).

### PI Agent
**Best for:** Strict typing requirements, PI model users, and lightweight coding assistants.
- Use if you prefer **TypeBox** for schema validation and strict typing.
- Use if you are already using the PI SDK ecosystem.
- Use for lightweight agents that need a stable, well-defined set of coding tools (`read`, `bash`, `edit`, `write`).
- Best for agents using OpenAI or PI-compatible models.

---

## Per-Harness Deep Dive

### LangGraph
The LangGraph harness uses the `deepagents` SDK, a pure TypeScript implementation of LangGraph. It is designed for flexibility and multi-agent orchestration.

- **SDK and Model Support**: Supports OpenAI, Anthropic, and Google Generative AI via LangChain adapters.
- **Tool Handling**: Stablehand tools are converted to LangChain tools. Supports `requiresApproval` for HITL.
- **Streaming Behavior**: Emits `text_delta` from model streams and `tool_call_*` events from LangChain's `on_tool_*` events.
- **Session Lifecycle**: Stateless at the SDK level; Stablehand manages the conversation transcript and passes the full history to the SDK on each turn.
- **Resource Requirements**: Smallest image footprint as it avoids Python and heavy CLI dependencies.
- **Known Limitations**: Knowledge lookup is currently a stub. Remote MCP servers come through the orchestrator, not a LangChain MCP adapter.

### Claude Agents
The Claude Agents harness wraps the official `@anthropic-ai/claude-agent-sdk`. It provides a high-fidelity experience for Claude models.

- **SDK and Model Support**: Optimized for Anthropic Claude models.
- **Tool Handling**: Tools are hosted on an internal MCP server. Requires Zod schemas for all tools.
- **Streaming Behavior**: Complex mapping of SDK stream events to AG-UI events, including buffering of tool arguments during JSON deltas.
- **Session Lifecycle**: Stateless per turn, but supports SDK-level session persistence if configured.
- **Resource Requirements**: Largest image size due to the global installation of `@anthropic-ai/claude-code` and its dependencies.
- **Known Limitations**: Limited to Anthropic models; higher latency due to MCP overhead and subprocess management.

### PI Agent
The PI Agent harness uses `@mariozechner/pi-coding-agent`. It is a robust, strictly-typed harness optimized for coding tasks.

- **SDK and Model Support**: Supports OpenAI, Anthropic, and Google models.
- **Tool Handling**: Custom tools are converted from Zod to TypeBox. Native tools are optimized for performance.
- **Streaming Behavior**: Uses a subscription model to capture SDK events and map them to `text_delta` and `tool_call_*` events.
- **Session Lifecycle**: Maintains a `NativePiSession` within the container.
- **Resource Requirements**: Medium image size; shares the common Bun-based base layer.
- **Known Limitations**: No native Skills or Subagents support; strict schema requirements can be more rigid than other harnesses.

---

## AG-UI Event Coverage

All harnesses emit a standard set of events to drive the React dashboard:

| Event Type | Description |
| :--- | :--- |
| `text_delta` | Real-time streaming of assistant text. |
| `tool_call_start` | Indicates a tool invocation has begun (shows tool card). |
| `tool_call_end` | Indicates tool completion (updates card with result/error). |
| `approval_needed` | Triggers a Human-in-the-loop (HITL) approval card. |
| `approval_resolved` | Signals the user's decision (approve/reject) back to the harness. |
| `message_committed` | Persists the full message to the database. |
| `done` | Signals the end of the agent's turn and provides token usage. |
| `error` | Reports harness or model-level errors to the UI. |

For a detailed mapping of internal SDK events to AG-UI events, see [docs/harness-ag-ui-inventory.md](harness-ag-ui-inventory.md).

---

## Configuration Differences

Harnesses are configured via the `spec.harnessConfig` field in the agent manifest (`agent.yaml`).

### LangGraph Config
```yaml
harnessConfig:
  provider: openai | anthropic | google
  model: string
  apiKeyRef: "$secret:KEY_NAME"
  temperature: number (0-2)
  maxTokens: number
  reasoning: off | low | medium | high
  subagents: array
```

### Claude Agents Config
```yaml
harnessConfig:
  provider: anthropic
  model: string
  apiKeyRef: "$secret:ANTHROPIC_API_KEY"
  maxTurns: number (iteration limit)
```

### PI Agent Config
```yaml
harnessConfig:
  provider: openai | anthropic | google
  model: string
  apiKeyRef: "$secret:KEY_NAME"
```

---

## Migration Between Harnesses

Switching an agent from one harness to another is straightforward but requires updating the manifest:

1.  **Update `harness`**: Change `spec.harness` to the new harness ID (`langgraph`, `claude-agents`, or `pi-agent`).
2.  **Update `harnessConfig`**: Adjust the fields in `spec.harnessConfig` to match the new harness's schema (e.g., Claude Agents uses `maxTurns`, LangGraph uses `temperature`).
3.  **Check `nativeToolPolicy`**: All harnesses use the same `all`/`allow`/`deny`/`none` modes. Update only the SDK-owned names when changing harnesses: Claude names are typically capitalized (for example `Read` and `Bash`), while PI names are lowercase (for example `read` and `bash`).
4.  **Verify Tools**: Since all harnesses require Zod schemas for custom tools, your existing tool definitions should work across all harnesses without modification.
