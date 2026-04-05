# Writing a Custom Tool Provider

Tool providers are the primary way to extend `ctxmill` with new capabilities. Whether you want to wrap an external API, connect to a database, or expose local functions to your agents, you do it by implementing a `ToolProvider`.

## Architecture Overview

The tool system consists of three main components:

1.  **ToolProvider**: A source of tools. It lists available tools and optionally handles their execution.
2.  **ToolRegistry**: A central aggregator that collects tools from all registered providers.
3.  **ToolExecutor**: The engine that validates inputs against Zod schemas and runs the tool handlers.

When an agent requests a tool, the orchestrator looks up the tool in the `ToolRegistry`, identifies the responsible `ToolProvider`, and either calls the provider's `execute` method or runs the tool's `handler` directly if it's a local tool.

## The ToolProvider Interface

Every provider must implement the `ToolProvider` interface defined in `packages/ctxmill/src/tool/provider.ts`:

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
import { defineTool } from 'ctxmill';
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

  // The actual logic
  handler: async (input, ctx) => {
    // input is automatically validated and typed based on the Zod schema
    const { userId, includePrivate } = input as { userId: string; includePrivate: boolean };
    
    // ctx provides access to agentId, conversationId, and workspaceDir
    const data = await db.users.find(userId);
    return JSON.stringify(data);
  },
});
```

### The ToolContext Object

The `ToolContext` provides essential metadata and services to your tool handler:

*   `agentId`: The unique identifier of the agent calling the tool.
*   `conversationId`: The current conversation ID.
*   `instanceId`: The specific run/instance ID.
*   `workspaceDir`: The absolute path to the session-scoped workspace directory.
*   `knowledge`: A query interface for the agent's knowledge store.
*   `eventBus`: An interface to emit events back to the orchestrator.

### Tool Locations

The `location` property tells `ctxmill` where the tool should run:

*   `sandbox` (Default): Executes inside the agent's Docker container. Use this for tools that interact with the filesystem or run untrusted code.
*   `orchestrator`: Executes in the main `ctxmill` process. Use this for tools that need access to the database, event bus, or external APIs that require secrets not shared with the sandbox.
*   `daemon`: Executes in the sandbox daemon process. Reserved for system-level tools like `artifact_upload`.

## Built-in Providers

`ctxmill` ships with five standard providers:

1.  **Local**: Wraps tools defined directly in TypeScript with a `handler` function.
2.  **HTTP**: Dynamically creates tools from a list of HTTP endpoints (REST APIs).
3.  **MCP**: Connects to any Model Context Protocol server (stdio or HTTP).
4.  **Composio**: Integrates with the Composio tool ecosystem.
5.  **Artifact**: Provides system tools for persistent file storage.

## Step-by-Step: Creating a Custom Provider

Let's implement a simple `DatabaseToolProvider` that exposes a query tool.

### 1. Implement the Interface

```typescript
import { ToolProvider, ToolDefinition, ToolContext, defineTool } from 'ctxmill';
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

To make your tools available to agents, add the provider to the `ToolRegistry` during application startup (usually in `packages/ctxmill/src/config/container.ts` or your main entry point).

```typescript
const registry = container.resolve('toolRegistry');
registry.addProvider(new DatabaseToolProvider());
```

## Testing Tools

You can test your tool definitions by manually invoking the `LocalFunctionExecutor`.

```typescript
import { LocalFunctionExecutor } from 'ctxmill';
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
