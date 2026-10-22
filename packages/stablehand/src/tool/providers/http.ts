import { z } from 'zod';
import type { ToolProvider, ToolSourceKind } from '../provider.js';
import type { ToolDefinition, ToolContext } from '@stablehand/sandbox-daemon';

/**
 * Authentication configuration for HTTP tool endpoints.
 */
export interface HttpAuthConfig {
  type: 'bearer' | 'api-key';
  /** Name of the secret (resolved from environment or SecretProvider). */
  secretName: string;
  /** Explicitly opt in to process.env fallback when no scoped secret exists. */
  allowEnvFallback?: boolean;
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
  timeoutMs?: number;
  /** Optional authentication configuration. */
  authentication?: HttpAuthConfig;
  /** Mark this tool as programmatic (default: false). */
  programmatic?: boolean;
}

const DEFAULT_TIMEOUT = 30_000;

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
type SupportedHttpMethod = (typeof HTTP_METHODS)[number];

function isSupportedHttpMethod(value: unknown): value is SupportedHttpMethod {
  return typeof value === 'string' && (HTTP_METHODS as readonly string[]).includes(value);
}

/**
 * Validate a single HttpEndpointConfig and throw a descriptive error if it
 * is ambiguous, malformed, or specifies an invalid HTTP method.
 *
 * Fails closed: the HTTPToolProvider must never coerce bad config into
 * plausible behavior (for example, silently rewriting `TRACE` to `POST`).
 */
function assertValidEndpointConfig(ep: HttpEndpointConfig, index: number): void {
  const where = `endpoint[${index}]${ep?.name ? ` "${ep.name}"` : ''}`;

  if (typeof ep !== 'object' || ep === null) {
    throw new Error(`HTTPToolProvider: ${where} must be an object`);
  }
  if (typeof ep.name !== 'string' || ep.name.trim() === '') {
    throw new Error(`HTTPToolProvider: ${where} requires a non-empty "name"`);
  }
  if (typeof ep.url !== 'string' || ep.url.trim() === '') {
    throw new Error(`HTTPToolProvider: ${where} requires a non-empty "url"`);
  }
  if (typeof ep.description !== 'string' || ep.description.trim() === '') {
    throw new Error(`HTTPToolProvider: ${where} requires a non-empty "description"`);
  }
  if (!isSupportedHttpMethod(ep.method)) {
    throw new Error(
      `HTTPToolProvider: ${where} has invalid HTTP method "${String(ep.method)}" (allowed: ${HTTP_METHODS.join(', ')})`,
    );
  }
  if (ep.timeoutMs !== undefined && (typeof ep.timeoutMs !== 'number' || !Number.isFinite(ep.timeoutMs) || ep.timeoutMs <= 0)) {
    throw new Error(`HTTPToolProvider: ${where} "timeoutMs" must be a positive finite number`);
  }
  if (ep.headers !== undefined) {
    if (typeof ep.headers !== 'object' || ep.headers === null || Array.isArray(ep.headers)) {
      throw new Error(`HTTPToolProvider: ${where} "headers" must be a string-valued object`);
    }
    for (const [key, value] of Object.entries(ep.headers)) {
      if (typeof value !== 'string') {
        throw new Error(`HTTPToolProvider: ${where} header "${key}" must be a string`);
      }
    }
  }
  if (ep.authentication !== undefined) {
    const auth = ep.authentication;
    if (typeof auth !== 'object' || auth === null) {
      throw new Error(`HTTPToolProvider: ${where} "authentication" must be an object`);
    }
    if (auth.type !== 'bearer' && auth.type !== 'api-key') {
      throw new Error(
        `HTTPToolProvider: ${where} authentication.type must be "bearer" or "api-key" (got "${String(auth.type)}")`,
      );
    }
    if (typeof auth.secretName !== 'string' || auth.secretName.trim() === '') {
      throw new Error(`HTTPToolProvider: ${where} authentication.secretName must be a non-empty string`);
    }
    if (auth.allowEnvFallback !== undefined && typeof auth.allowEnvFallback !== 'boolean') {
      throw new Error(`HTTPToolProvider: ${where} authentication.allowEnvFallback must be boolean when set`);
    }
  }
  if (ep.inputSchema !== undefined && (typeof ep.inputSchema !== 'object' || ep.inputSchema === null || Array.isArray(ep.inputSchema))) {
    throw new Error(`HTTPToolProvider: ${where} "inputSchema" must be a JSON Schema object when set`);
  }
  if (ep.programmatic !== undefined && typeof ep.programmatic !== 'boolean') {
    throw new Error(`HTTPToolProvider: ${where} "programmatic" must be boolean when set`);
  }
}

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
 * config) first. Ambient process.env fallback is disabled unless explicitly
 * requested by endpoint config.
 */
function resolveSecret(
  secretName: string,
  secrets?: Record<string, string>,
  allowEnvFallback = false,
): string | undefined {
  if (secrets && secrets[secretName]) {
    return secrets[secretName];
  }
  return allowEnvFallback ? process.env[secretName] : undefined;
}

/**
 * Tool provider that wraps external HTTP endpoints as agent tools.
 *
 * Each configured endpoint becomes a ToolDefinition whose handler
 * makes an HTTP request and returns the response body.
 *
 * Automatic headers injected on every request:
 *  - `X-Agent-Id` — the executing agent's identifier
 *  - `X-Turn-Id` — the executing turn identifier
 *  - `X-Sandbox-Session-Id` — the persistent sandbox identifier, when present
 *  - `X-Conversation-Id` — the conversation identifier
 */
export class HTTPToolProvider implements ToolProvider {
  readonly name: string;
  readonly source: ToolSourceKind = 'http';
  readonly agentScope?: string;
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
      /** Agent that owns these endpoints; other agents never see them. */
      agentScope?: string;
      secrets?: Record<string, string>;
      fetchFn?: typeof fetch;
    },
  ) {
    if (!Array.isArray(endpoints)) {
      throw new Error('HTTPToolProvider: endpoints must be an array');
    }
    const seen = new Set<string>();
    endpoints.forEach((ep, index) => {
      assertValidEndpointConfig(ep, index);
      if (seen.has(ep.name)) {
        throw new Error(`HTTPToolProvider: duplicate endpoint name "${ep.name}"`);
      }
      seen.add(ep.name);
    });

    this.endpoints = endpoints;
    this.name = options?.name ?? 'http';
    if (options?.agentScope !== undefined) {
      this.agentScope = options.agentScope;
    }
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
        location: 'orchestrator',
        // Internal ToolDefinition keeps `timeout` (registry-internal, not the public API field).
        timeout: ep.timeoutMs ?? DEFAULT_TIMEOUT,
        programmatic: ep.programmatic ?? false,
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

    const timeout = ep.timeoutMs ?? DEFAULT_TIMEOUT;

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Agent-Id': ctx.agentId,
      'X-Conversation-Id': ctx.conversationId,
      ...(ctx.turnId ? { 'X-Turn-Id': ctx.turnId } : {}),
      ...(ctx.sandboxSessionId ? { 'X-Sandbox-Session-Id': ctx.sandboxSessionId } : {}),
      ...(ep.headers ?? {}),
    };

    // Resolve authentication
    if (ep.authentication) {
      const secret = resolveSecret(
        ep.authentication.secretName,
        this.secrets,
        ep.authentication.allowEnvFallback === true,
      );
      if (!secret) {
        throw new Error(`HTTPToolProvider: missing secret "${ep.authentication.secretName}" for tool "${ep.name}"`);
      }
      if (ep.authentication.type === 'bearer') {
        headers['Authorization'] = `Bearer ${secret}`;
      } else {
        // api-key: use X-API-Key header
        headers['X-API-Key'] = secret;
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
          { cause: err },
        );
      }
      // Re-wrap non-Error objects
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(
          `HTTPToolProvider: request to "${ep.name}" timed out after ${timeout}ms`,
          { cause: err },
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
