# Writing a Custom Tool Provider

Tool providers are the primary way to extend `stablehand` with new capabilities. Whether you want to wrap an external API, connect to a database, or expose local functions to your agents, you do it by implementing a `ToolProvider`.

## Architecture Overview

The tool system consists of three main components:

1.  **ToolProvider**: A source of tools. It lists available tools and optionally handles their execution.
2.  **ToolRegistry**: A central aggregator that collects tools from all registered providers.
3.  **ToolExecutor**: The engine that validates inputs against Zod schemas and runs the tool handlers.

When an agent requests a tool, the orchestrator looks up the tool in the `ToolRegistry`, identifies the responsible `ToolProvider`, and either calls the provider's `execute` method or runs the tool's `handler` directly if it's a local tool.

## The ToolProvider Interface

Every provider must implement the `ToolProvider` interface defined in `packages/stablehand/src/tool/provider.ts`:

```typescript
export interface ToolProvider {
  /** Unique name for the provider (e.g., 'github', 'slack', 'internal-db') */
  readonly name: string;

  /** Returns a list of tools this provider offers */
  listTools(): Promise<ToolDefinition[]>;

  /** 
   * Optional: Handles tool execution. 
   * If omitted, the registry assumes tools have a 'handler' property in their definition.
   */
  execute?(toolName: string, args: unknown, ctx: ToolContext): Promise<string>;
}
```

## Defining Tools with `defineTool()`

The `defineTool()` helper provides type safety when creating tool definitions. It ensures your tool matches the `ToolDefinition` interface.

```typescript
import { defineTool } from 'stablehand';
import { z } from 'zod';

export const myTool = defineTool({
  name: 'get_user_data',
  description: 'Retrieve user profile information from the internal database',
  
  // Zod schema for input validation (REQUIRED)
  input: z.object({
    userId: z.string().describe('The unique identifier for the user'),
    includePrivate: z.boolean().default(false).describe('Whether to include private fields'),
  }),

  // Optional: Triggers a Human-in-the-Loop approval card in the UI
  requiresApproval: true,

  // Optional: Execution location hint
  location: 'orchestrator',

  // Optional: Generate programmatic tool-call helper scripts inside the sandbox.
  programmatic: true,

  // The actual logic
  handler: async (input, ctx) => {
    // input is automatically validated and typed based on the Zod schema
    const { userId, includePrivate } = input as { userId: string; includePrivate: boolean };
    
    // ctx provides explicit agent, conversation, turn, sandbox, and workspace context
    const data = await db.users.find(userId);
    return JSON.stringify(data);
  },
});
```

### The ToolContext Object

The `ToolContext` provides essential metadata and services to your tool handler:

*   `agentId`: The unique identifier of the agent calling the tool.
*   `conversationId`: The durable conversation/thread ID.
*   `turnId`: The current execution ID, when the tool call belongs to a turn.
*   `sandboxSessionId`: The sandbox container lifecycle ID, when available.
*   `requestId`: The tool request ID when available.
*   `workspaceDir`: The absolute path to the conversation workspace directory.
*   `eventBus`: An interface to emit events back to the orchestrator.

### Tool Locations

The `location` property tells `stablehand` where the tool should run:

*   `sandbox` (Default): Executes inside the agent's Docker container. Use this for tools that interact with the filesystem or run untrusted code.
*   `orchestrator`: Executes in the main `stablehand` process. Use this for tools that need access to the database, event bus, or external APIs that require secrets not shared with the sandbox.
*   `daemon`: Executes in the sandbox daemon process. Reserved for system-level tools like `artifact_upload`.

### Programmatic Tool Calling

Tools with `programmatic: true` are eligible for generated TypeScript helper
scripts under `/workspace/.tools` inside the sandbox. Those scripts call the
daemon-local API, which then routes execution to the correct location. Leave
`programmatic` unset for tools that should only be called through normal harness
tool-calling.

## Built-in Providers

The default container (`packages/stablehand/src/config/container.ts`) registers these providers:

1.  **Local**: Wraps tools defined directly in TypeScript with a `handler` function.
2.  **HTTP**: Dynamically creates tools from a list of HTTP endpoints (REST APIs). One provider is registered per agent that declares HTTP tools.
3.  **Artifact**: Provides daemon-location metadata for persistent file storage tools; bytes upload/download at the daemon location rather than through orchestrator byte proxying. Registered only when S3 storage is configured.
4.  **Browser**: Provides daemon-location `browse` and `screenshot` tools backed by the Chromium in each harness image. Registered alongside Artifact.

Two more provider classes are exported but **not registered by the default stack**, so agents cannot use them without custom wiring:

- **MCP**: Connects to a Model Context Protocol server (stdio or HTTP).
- **Composio**: Integrates with the Composio tool ecosystem.

## Step-by-Step: Creating a Custom Provider

Let's implement a simple `DatabaseToolProvider` that exposes a query tool.

### 1. Implement the Interface

```typescript
import { ToolProvider, ToolDefinition, ToolContext, defineTool } from 'stablehand';
import { z } from 'zod';

export class DatabaseToolProvider implements ToolProvider {
  readonly name = 'my-db';

  async listTools(): Promise<ToolDefinition[]> {
    return [
      defineTool({
        name: 'query_db',
        description: 'Run a read-only SQL query against the analytics database',
        input: z.object({
          sql: z.string().describe('The SQL query to execute'),
        }),
        location: 'orchestrator',
        handler: async (input, ctx) => {
          const { sql } = input as { sql: string };
          // Implementation logic here
          return JSON.stringify(await myDb.execute(sql));
        },
      }),
    ];
  }
}
```

### 2. Register the Provider

To make your tools available to agents, add the provider to the `ToolRegistry` during application startup (usually in `packages/stablehand/src/config/container.ts` or your main entry point).

```typescript
const registry = container.resolve('toolRegistry');
registry.addProvider(new DatabaseToolProvider());
```

## Testing Tools

You can test your tool definitions by manually invoking the `LocalFunctionExecutor`.

```typescript
import { LocalFunctionExecutor } from 'stablehand';
import { myTool } from './my-tool.js';

const executor = new LocalFunctionExecutor();
executor.register(myTool);

const result = await executor.execute({
  id: 'test-call',
  name: 'get_user_data',
  arguments: { userId: '123' }
}, mockContext);

console.log(result.result);
```

### Validation Rules

*   **Zod is Mandatory**: Every tool must have an `input` property that is a valid Zod schema.
*   **Strings Only**: Tool handlers must return a `Promise<string>`. If you have structured data, `JSON.stringify` it.
*   **Timeouts**: You can specify a `timeout` in milliseconds in the `ToolDefinition`. The default is 30 seconds.
