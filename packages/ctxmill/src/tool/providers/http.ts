import { z } from 'zod';
import type { ToolProvider } from '../provider.js';
import type { ToolDefinition, ToolContext } from '../types.js';

/**
 * Authentication configuration for HTTP tool endpoints.
 */
export interface HttpAuthConfig {
  type: 'bearer' | 'api-key';
  /** Name of the secret (resolved from environment or SecretProvider). */
  secretName: string;
}

/**
 * Configuration for a single HTTP endpoint exposed as a tool.
 */
export interface HttpEndpointConfig {
  name: string;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  description: string;
  /** JSON Schema describing the expected input. */
  inputSchema?: Record<string, unknown>;
  /** Static headers to include on every request. */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds (default: 30 000). */
  timeout?: number;
  /** Optional authentication configuration. */
  authentication?: HttpAuthConfig;
}

const DEFAULT_TIMEOUT = 30_000;

/**
 * Converts a JSON Schema property object into a Zod schema.
 * Handles the common subset used by HTTP tool definitions.
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
      const properties = prop.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
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
 * Resolve an authentication secret by name.
 *
 * Looks in `secrets` (agent-scoped secrets passed in ToolContext-adjacent
 * config) first, then falls back to `process.env`.
 */
function resolveSecret(
  secretName: string,
  secrets?: Record<string, string>,
): string | undefined {
  if (secrets && secrets[secretName]) {
    return secrets[secretName];
  }
  return process.env[secretName];
}

/**
 * Tool provider that wraps external HTTP endpoints as agent tools.
 *
 * Each configured endpoint becomes a ToolDefinition whose handler
 * makes an HTTP request and returns the response body.
 *
 * Automatic headers injected on every request:
 *  - `X-Agent-Id` — the executing agent's identifier
 *  - `X-Instance-Id` — the run/instance identifier
 *  - `X-Conversation-Id` — the conversation identifier
 */
export class HTTPToolProvider implements ToolProvider {
  readonly name: string;
  private endpoints: HttpEndpointConfig[];
  private cachedTools: ToolDefinition[] | null = null;
  /** Optional pre-resolved secrets map (e.g. from HarnessRunConfig). */
  private secrets: Record<string, string>;
  /** Injected fetch implementation (defaults to global fetch). */
  private fetchFn: typeof fetch;

  constructor(
    endpoints: HttpEndpointConfig[],
    options?: {
      name?: string;
      secrets?: Record<string, string>;
      fetchFn?: typeof fetch;
    },
  ) {
    this.endpoints = endpoints;
    this.name = options?.name ?? 'http';
    this.secrets = options?.secrets ?? {};
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
  }

  async listTools(): Promise<ToolDefinition[]> {
    if (this.cachedTools) return this.cachedTools;

    const tools: ToolDefinition[] = this.endpoints.map((ep) => {
      const zodInput = this.buildInputSchema(ep);

      const def: ToolDefinition = {
        name: ep.name,
        description: ep.description,
        input: zodInput,
        timeout: ep.timeout ?? DEFAULT_TIMEOUT,
        handler: async (
          input: unknown,
          ctx: ToolContext,
        ) => {
          return this.execute(ep.name, input as Record<string, unknown>, ctx);
        },
      };
      return def;
    });

    this.cachedTools = tools;
    return tools;
  }

  async execute(
    toolName: string,
    args: unknown,
    ctx: ToolContext,
  ): Promise<string> {
    const ep = this.endpoints.find((e) => e.name === toolName);
    if (!ep) {
      throw new Error(`HTTPToolProvider: unknown tool "${toolName}"`);
    }

    const timeout = ep.timeout ?? DEFAULT_TIMEOUT;

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Agent-Id': ctx.agentId,
      'X-Conversation-Id': ctx.conversationId,
      ...(ctx.instanceId ? { 'X-Instance-Id': ctx.instanceId } : {}),
      ...(ep.headers ?? {}),
    };

    // Resolve authentication
    if (ep.authentication) {
      const secret = resolveSecret(
        ep.authentication.secretName,
        this.secrets,
      );
      if (secret) {
        if (ep.authentication.type === 'bearer') {
          headers['Authorization'] = `Bearer ${secret}`;
        } else {
          // api-key: use X-API-Key header
          headers['X-API-Key'] = secret;
        }
      }
    }

    // Build request options
    const fetchOptions: RequestInit = {
      method: ep.method,
      headers,
    };

    // Attach body for non-GET methods
    if (ep.method !== 'GET' && args != null) {
      fetchOptions.body = JSON.stringify(args);
    }

    // Abort signal with timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    fetchOptions.signal = controller.signal;

    try {
      const response = await this.fetchFn(ep.url, fetchOptions);

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `HTTP ${response.status} ${response.statusText}: ${body}`.trim(),
        );
      }

      return await response.text();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(
          `HTTPToolProvider: request to "${ep.name}" timed out after ${timeout}ms`,
        );
      }
      // Re-wrap non-Error objects
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(
          `HTTPToolProvider: request to "${ep.name}" timed out after ${timeout}ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Build a Zod schema from the endpoint's inputSchema (JSON Schema).
   * Falls back to z.object({}) if no schema is provided.
   */
  private buildInputSchema(ep: HttpEndpointConfig): z.ZodTypeAny {
    if (!ep.inputSchema) {
      return z.object({});
    }

    const properties = (ep.inputSchema.properties ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const required = (ep.inputSchema.required ?? []) as string[];

    if (Object.keys(properties).length > 0) {
      return buildZodObject(properties, required);
    }

    return z.object({});
  }
}
