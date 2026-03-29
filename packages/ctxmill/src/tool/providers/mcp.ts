import { z } from 'zod';
import type { ToolProvider } from '../provider.js';
import type { ToolDefinition, ToolContext } from '../types.js';

/**
 * Configuration for connecting to an MCP server.
 */
export type MCPTransportConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

/**
 * Converts a JSON Schema property object into a Zod schema.
 * Handles the common subset used by MCP tool definitions.
 */
function jsonSchemaPropertyToZod(prop: Record<string, unknown>): z.ZodTypeAny {
  const type = prop.type as string | undefined;
  switch (type) {
    case 'string':
      return z.string();
    case 'number':
    case 'integer':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array': {
      const items = prop.items as Record<string, unknown> | undefined;
      return z.array(items ? jsonSchemaPropertyToZod(items) : z.unknown());
    }
    case 'object': {
      const properties = prop.properties as Record<string, Record<string, unknown>> | undefined;
      if (properties) {
        return buildZodObject(properties, (prop.required as string[]) ?? []);
      }
      return z.record(z.string(), z.unknown());
    }
    default:
      return z.unknown();
  }
}

function buildZodObject(
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const requiredSet = new Set(required);
  for (const [key, prop] of Object.entries(properties)) {
    let schema = jsonSchemaPropertyToZod(prop);
    if (prop.description) {
      schema = schema.describe(prop.description as string);
    }
    shape[key] = requiredSet.has(key) ? schema : schema.optional();
  }
  return z.object(shape);
}

/**
 * Connects to an MCP server and exposes its tools via the ToolProvider interface.
 *
 * Uses the Model Context Protocol SDK to:
 * - Discover tools via client.listTools()
 * - Convert JSON Schema definitions to Zod schemas
 * - Execute tools via client.callTool()
 */
export class MCPToolProvider implements ToolProvider {
  readonly name: string;
  private client: any = null;
  private transport: any = null;
  private cachedTools: ToolDefinition[] | null = null;

  private config: MCPTransportConfig;

  constructor(config: MCPTransportConfig, name?: string) {
    this.config = config;
    this.name = name ?? `mcp-${config.type}`;
  }

  /**
   * Initialize the MCP client and connect to the server.
   * Lazily called on first listTools()/execute() if not called manually.
   */
  async connect(): Promise<void> {
    if (this.client) return;

    // Dynamic import to avoid hard dependency if MCP SDK is not installed
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

    this.client = new Client({ name: 'ctxmill', version: '1.0.0' });

    if (this.config.type === 'stdio') {
      const { StdioClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/stdio.js'
      );
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env: this.config.env,
      });
    } else {
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      );
      this.transport = new StreamableHTTPClientTransport(
        new URL(this.config.url),
      );
    }

    await this.client.connect(this.transport);
  }

  async listTools(): Promise<ToolDefinition[]> {
    if (this.cachedTools) return this.cachedTools;

    await this.connect();

    const response = await this.client.listTools();
    const tools: ToolDefinition[] = (response.tools ?? []).map(
      (mcpTool: { name: string; description?: string; inputSchema?: Record<string, unknown> }) => {
        const inputSchema = mcpTool.inputSchema ?? {};
        const properties = (inputSchema.properties ?? {}) as Record<
          string,
          Record<string, unknown>
        >;
        const required = (inputSchema.required ?? []) as string[];

        const zodInput = Object.keys(properties).length > 0
          ? buildZodObject(properties, required)
          : z.object({});

        const def: ToolDefinition = {
          name: mcpTool.name,
          description: mcpTool.description ?? '',
          input: zodInput,
          location: 'orchestrator',
          handler: async (input: unknown, _ctx: ToolContext) => {
            return this.execute(mcpTool.name, input as Record<string, unknown>, _ctx);
          },
        };
        return def;
      },
    );

    this.cachedTools = tools;
    return tools;
  }

  async execute(toolName: string, args: unknown, _ctx: ToolContext): Promise<string> {
    await this.connect();

    const result = await this.client.callTool({
      name: toolName,
      arguments: args as Record<string, unknown>,
    });

    // MCP tool results contain a `content` array of content blocks
    const content = result.content ?? [];
    const textParts = content
      .filter((c: { type: string }) => c.type === 'text')
      .map((c: { text: string }) => c.text);

    if (textParts.length > 0) {
      return textParts.join('\n');
    }

    // Fallback: stringify the whole result
    return JSON.stringify(result);
  }

  /**
   * Disconnect from the MCP server and release resources.
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Ignore disconnect errors
      }
      this.client = null;
      this.transport = null;
      this.cachedTools = null;
    }
  }
}
