import { z } from 'zod';
import type { ToolProvider } from '../provider.js';
import type { ToolDefinition, ToolContext } from '../types.js';

/**
 * Configuration for the Composio tool provider.
 */
export interface ComposioConfig {
  /** Composio API key */
  apiKey: string;
  /** Toolkits to load (e.g., ['github', 'slack', 'gmail']) */
  toolkits?: string[];
  /** User/entity ID for scoped tool execution */
  entityId?: string;
}

/**
 * Bridges Composio tools into the ctxmill ToolProvider interface.
 *
 * Tool names are prefixed with `composio.` to avoid collisions with
 * local or MCP tools.
 *
 * NOTE: This is a stub implementation. The @composio/core package
 * may not be available. Install it with:
 *   pnpm --filter ctxmill add @composio/core
 *
 * TODO: Complete implementation once @composio/core is confirmed installable
 * and its API surface is validated.
 */
export class ComposioToolProvider implements ToolProvider {
  readonly name = 'composio';
  private client: any = null;
  private cachedTools: ToolDefinition[] | null = null;

  private config: ComposioConfig;

  constructor(config: ComposioConfig) {
    this.config = config;
  }

  private async getClient(): Promise<any> {
    if (this.client) return this.client;

    try {
      const mod = await import('@composio/core' as string);
      const Composio = mod.Composio ?? mod.default;
      this.client = new Composio({ apiKey: this.config.apiKey });
      return this.client;
    } catch {
      throw new Error(
        'ComposioToolProvider: @composio/core is not installed. ' +
          'Run: pnpm --filter ctxmill add @composio/core',
      );
    }
  }

  async listTools(): Promise<ToolDefinition[]> {
    if (this.cachedTools) return this.cachedTools;

    const client = await this.getClient();
    const rawTools = await client.tools.list({
      toolkits: this.config.toolkits,
    });

    const tools: ToolDefinition[] = (rawTools ?? []).map(
      (t: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
      }) => {
        // Build a basic Zod schema from parameters if available
        const params = t.parameters ?? {};
        const properties = (params.properties ?? {}) as Record<
          string,
          Record<string, unknown>
        >;
        const required = (params.required ?? []) as string[];

        const shape: Record<string, z.ZodTypeAny> = {};
        const requiredSet = new Set(required);

        for (const [key, prop] of Object.entries(properties)) {
          let schema: z.ZodTypeAny;
          switch (prop.type) {
            case 'string':
              schema = z.string();
              break;
            case 'number':
            case 'integer':
              schema = z.number();
              break;
            case 'boolean':
              schema = z.boolean();
              break;
            default:
              schema = z.unknown();
          }
          if (prop.description) {
            schema = schema.describe(prop.description as string);
          }
          shape[key] = requiredSet.has(key) ? schema : schema.optional();
        }

        const zodInput = Object.keys(shape).length > 0
          ? z.object(shape)
          : z.object({});

        const prefixedName = `composio.${t.name}`;

        const def: ToolDefinition = {
          name: prefixedName,
          description: t.description ?? '',
          input: zodInput,
          handler: async (
            input: Record<string, unknown>,
            _ctx: ToolContext,
          ) => {
            return this.execute(prefixedName, input, _ctx);
          },
        };
        return def;
      },
    );

    this.cachedTools = tools;
    return tools;
  }

  async execute(
    toolName: string,
    args: unknown,
    _ctx: ToolContext,
  ): Promise<string> {
    const client = await this.getClient();

    // Strip the `composio.` prefix for the API call
    const rawName = toolName.startsWith('composio.')
      ? toolName.slice('composio.'.length)
      : toolName;

    const result = await client.tools.execute(rawName, {
      input: args as Record<string, unknown>,
      entityId: this.config.entityId,
    });

    if (typeof result === 'string') return result;
    return JSON.stringify(result);
  }
}
