# Programmatic Tool Calling (PTC)

## Problem

Tool responses can be enormous. For example, a bank reconciliation candidate search can return 178K characters (approximately 44K tokens) in a single JSON payload. When these results are injected directly into the LLM's context window, they quickly exhaust the token budget, leading to truncated responses or failed workflows.

## Solution

Programmatic Tool Calling (PTC) keeps tool results in code variable scope instead of the LLM context. The agent writes code that calls tools, processes the results locally, and prints only concise summaries. This approach reduces token usage from ~44K to ~50 tokens per tool call, a 99.9% reduction for large-payload tools.

## How It Works

PTC uses a local HTTP API and code generation to bridge the gap between the agent's code and the orchestrator's tools.

```text
+----------------+       gRPC (RequestTool)       +----------------+
| Orchestrator   | <----------------------------> | Sandbox Daemon |
| - Tool Registry|                                | - HTTP API     |
| - Providers    |                                | - PTC Codegen  |
+----------------+                                +--------+-------+
                                                           |
                                                           | Local HTTP
                                                           v
+----------------------------------------------------------+-------+
| Sandbox Container (/workspace)                                   |
|                                                                  |
|  +------------------+      exec      +------------------------+  |
|  | Claude Agent     | -------------> | bun .tools/script.ts   |  |
|  | (Bash Tool)      |                | - calls daemon API     |  |
|  +------------------+                | - processes JSON       |  |
|                                      | - prints summary       |  |
|                                      +------------------------+  |
+------------------------------------------------------------------+
```

1. **Tool marked programmatic**: A tool is configured with `programmatic: true` in its provider configuration.
2. **Flag flows**: This flag travels from the `ToolProvider` through the `ToolDefinition` and proto `ToolMetadata` to the sandbox.
3. **Startup codegen**: At session startup, the daemon generates scripts in `/workspace/.tools/`.
4. **System prompt augmented**: The system prompt is updated with PTC instructions and script paths.
5. **Agent execution**: Claude uses the Bash tool to run: `bun /workspace/.tools/get-candidates.ts <args>`.
6. **Script calls daemon**: The script calls the daemon's HTTP API on `localhost:8080`.
7. **Daemon routes to handler**: The daemon routes the request to the existing tool handler (proxying to the orchestrator via gRPC if necessary).
8. **Result stays in scope**: The full JSON result remains in the script's variable scope.
9. **Script prints summary**: The script prints a summary to stdout, which is the only part that enters the LLM context.

## Enabling PTC

PTC is an opt-in feature configured at the tool provider level.

### HTTP Tools
Set `programmatic: true` on an individual endpoint configuration:
```typescript
const config: HttpEndpointConfig = {
  name: 'get-candidates',
  url: 'https://api.example.com/candidates',
  method: 'POST',
  programmatic: true,
  // ...
};
```

### MCP Tools
Tools from an agent's MCP servers (see [mcp-servers.md](mcp-servers.md)) are not flagged programmatic yet: `mcpServers` has no field for it. Their results are capped at 100,000 characters instead.

### Which tools benefit?
- Tools returning large JSON responses (data fetching, search results, match candidates).
- Tools where the agent only needs a summary or specific fields from a large dataset.
- **NOT for**: small-response tools, side-effect tools requiring immediate feedback, or approval-gated tools.

## Generated Scripts

### _runtime.ts
This shared runtime file contains the `callTool()` function, error handling, and port configuration. It ensures that scripts communicate correctly with the daemon and that errors are reported to stderr rather than stdout.

### Per-tool wrappers
For each programmatic tool, a wrapper script is generated (e.g., `get-candidates.ts`). These scripts parse CLI arguments, call the tool via the runtime, and print a structured summary of the result.

### Custom scripts
Agents can write their own custom scripts that import from `_runtime.ts` for ad-hoc processing:
```typescript
import { callTool } from "./_runtime.ts";
const data = await callTool("get-candidates", { id: "123" });
// Custom logic to filter or aggregate data...
console.log(`Found ${data.length} candidates`);
```

## Daemon Tool API

### Endpoints
- `GET /tools`: Lists all available tool names.
- `POST /tools/:name`: Calls a specific tool and returns the JSON result.

### How routing works
The daemon calls the `toolDef.handler()` function, which already encapsulates the provider-specific logic. This means PTC works the same for HTTP and MCP tools without per-provider changes in the daemon.

### Error handling
PTC scripts are designed to be safe. They never dump raw payloads to stdout on error. Errors are sent to stderr, and the daemon returns 404 for unknown tools or 500 for handler failures.

## Observability

PTC tool calls currently go through the daemon tool API (`POST /tools/:name`)
without emitting tool-call observability events. `startToolApi` invokes the
tool handler and returns the JSON result directly; it does not emit
`tool_call.started`/`tool_call.completed` and does not tag calls with any
`executionMode`. Consequently the UI cannot yet distinguish PTC calls from
standard tool calls. The upside is that large PTC payloads stay in code scope
inside the sandbox rather than the message history. Adding PTC observability
is tracked in `ctx-s6o`.

## Provider Compatibility

| Provider | Handler Location | PTC Works? | Notes |
|----------|-----------------|------------|-------|
| HTTP | orchestrator (gRPC proxy) | Yes | Primary use case for large payloads |
| MCP | orchestrator (gRPC proxy) | Mechanism yes, flag not exposed | No `programmatic` field on `mcpServers` yet |
| Composio | n/a | n/a | Not wired |
| Local | sandbox (in-process) | No | Already in SDK scope; no context benefit |
| Artifact | daemon (S3) | Partial | Best for download-then-process workflows |
| Built-in | orchestrator | No benefit | Payloads are typically small |
