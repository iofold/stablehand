import { z } from 'zod';
import type { ToolProvider } from '../provider.js';
import type { ToolDefinition, ToolContext } from '@ctxmill/sandbox-daemon';

const DEFAULT_BASE_URL = 'https://backend.composio.dev';
const COMPOSIO_PREFIX = 'composio.';

type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
};

type ComposioSessionResponse = {
  session_id: string;
  mcp?: {
    url?: string;
    headers?: Record<string, string>;
  };
  tool_router_tools?: ComposioToolDescriptor[];
};

type ComposioToolDescriptor = {
  name: string;
  description?: string;
  input_schema?: JsonSchema;
  inputSchema?: JsonSchema;
  parameters?: JsonSchema;
};

interface ComposioClient {
  createSession(config: ComposioConfig): Promise<ComposioSessionResponse>;
  listSessionTools(sessionId: string): Promise<ComposioToolDescriptor[]>;
  executeSessionTool(
    sessionId: string,
    toolName: string,
    arguments_: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface ComposioConfig {
  apiKey: string;
  toolkits?: string[];
  userId?: string;
  baseUrl?: string;
  /** List of tool names that should be marked as programmatic. */
  programmaticTools?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonSchemaToZod(schema: JsonSchema | undefined): z.ZodTypeAny {
  switch (schema?.type) {
    case 'string':
      return z.string();
    case 'number':
    case 'integer':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(jsonSchemaToZod(schema.items));
    case 'object': {
      const properties = schema.properties ?? {};
      const required = schema.required ?? [];
      return buildZodObject(properties, required);
    }
    default:
      return z.unknown();
  }
}

function buildZodObject(
  properties: Record<string, JsonSchema>,
  required: string[],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const requiredSet = new Set(required);

  for (const [key, property] of Object.entries(properties)) {
    let schema = jsonSchemaToZod(property);
    if (property.description) {
      schema = schema.describe(property.description);
    }
    shape[key] = requiredSet.has(key) ? schema : schema.optional();
  }

  return z.object(shape);
}

function getToolInputSchema(tool: ComposioToolDescriptor): JsonSchema {
  return tool.input_schema ?? tool.inputSchema ?? tool.parameters ?? { type: 'object', properties: {} };
}

function normalizeToolArguments(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : {};
}

function normalizeToolResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }

  if (isRecord(result) && typeof result.data === 'string') {
    return result.data;
  }

  return JSON.stringify(result) ?? String(result);
}

class RestComposioClient implements ComposioClient {
  constructor(private readonly config: ComposioConfig) {}

  private get baseUrl(): string {
    return this.config.baseUrl ?? DEFAULT_BASE_URL;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Composio request failed (${response.status}): ${body}`);
    }

    return response.json() as Promise<T>;
  }

  async createSession(config: ComposioConfig): Promise<ComposioSessionResponse> {
    return this.request<ComposioSessionResponse>('/api/v3/tool_router/session', {
      method: 'POST',
      body: JSON.stringify({
        user_id: config.userId ?? 'default',
        toolkits: config.toolkits ?? [],
      }),
    });
  }

  async listSessionTools(sessionId: string): Promise<ComposioToolDescriptor[]> {
    return this.request<ComposioToolDescriptor[]>(`/api/v3/tool_router/session/${sessionId}/tools`, {
      method: 'GET',
    });
  }

  async executeSessionTool(
    sessionId: string,
    toolName: string,
    arguments_: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request<unknown>(`/api/v3/tool_router/session/${sessionId}/execute`, {
      method: 'POST',
      body: JSON.stringify({
        tool: toolName,
        arguments: arguments_,
      }),
    });
  }
}

export class ComposioToolProvider implements ToolProvider {
  readonly name = 'composio';

  private readonly client: ComposioClient;
  private sessionId: string | null = null;
  private cachedSessionTools: ComposioToolDescriptor[] | null = null;
  private cachedTools: ToolDefinition[] | null = null;
  private programmaticToolNames: Set<string>;

  constructor(
    private readonly config: ComposioConfig,
    client?: ComposioClient,
  ) {
    this.client = client ?? new RestComposioClient(config);
    this.programmaticToolNames = new Set(config.programmaticTools ?? []);
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionId) {
      return this.sessionId;
    }

    const session = await this.client.createSession(this.config);
    this.sessionId = session.session_id;
    this.cachedSessionTools = session.tool_router_tools ?? null;
    return this.sessionId;
  }

  async listTools(): Promise<ToolDefinition[]> {
    if (this.cachedTools) {
      return this.cachedTools;
    }

    const sessionId = await this.ensureSession();
    this.cachedSessionTools = await this.client.listSessionTools(sessionId);

    const tools: ToolDefinition[] = this.cachedSessionTools.map((tool) => {
      const inputSchema = getToolInputSchema(tool);
      const properties = inputSchema.properties ?? {};
      const required = inputSchema.required ?? [];
      const zodInput = Object.keys(properties).length > 0
        ? buildZodObject(properties, required)
        : z.object({});

      const prefixedName = `${COMPOSIO_PREFIX}${tool.name}`;

      return {
        name: prefixedName,
        description: tool.description ?? '',
        input: zodInput,
        location: 'orchestrator',
        programmatic: this.programmaticToolNames.has(tool.name),
        handler: async (input: unknown, ctx: ToolContext) => this.execute(prefixedName, input, ctx),
      } satisfies ToolDefinition;
    });

    this.cachedTools = tools;
    return tools;
  }

  async execute(toolName: string, args: unknown, _ctx: ToolContext): Promise<string> {
    const sessionId = await this.ensureSession();
    const rawName = toolName.startsWith(COMPOSIO_PREFIX)
      ? toolName.slice(COMPOSIO_PREFIX.length)
      : toolName;

    const result = await this.client.executeSessionTool(
      sessionId,
      rawName,
      normalizeToolArguments(args),
    );

    return normalizeToolResult(result);
  }
}
