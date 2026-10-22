import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerDefinition, McpServerToolSummary } from '@stablehand/contracts';
import { jsonSchemaToZod, type ToolContext, type ToolDefinition } from '@stablehand/sandbox-daemon';

import type { ToolCatalogInfo, ToolProvider, ToolSourceKind } from '../tool/provider.js';
import { EgressBlockedError, type EgressPolicy } from '../util/egress.js';
import { parseSecretReference } from '../secrets/scopes.js';
import {
  agentToolName,
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  humanizeMcpToolName,
  isMcpToolAllowed,
  MAX_MCP_RESULT_CHARS,
  mcpProviderName,
  mcpToolRequiresApproval,
  type McpToolAnnotations,
} from './config.js';
import { createMcpFetch } from './egress.js';
import {
  authorizationHosts,
  StoredOAuthClientProvider,
  type McpOAuthStore,
} from './oauth.js';

interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

export type McpServerState = 'connecting' | 'ready' | 'needs_auth' | 'error';

export interface McpServerRuntimeStatus {
  state: McpServerState;
  message?: string;
  toolCount: number;
  lastListedAt: number | null;
  tools: McpServerToolSummary[];
}

export interface McpServerToolProviderDeps {
  agentId: string;
  server: McpServerDefinition;
  /** Reads one of the agent's tools-scope secrets (never the sandbox scope). */
  readSecret: (name: string) => Promise<string | null>;
  /** Where an `oauth` server's tokens live. */
  oauthStore?: McpOAuthStore;
  egressPolicy?: EgressPolicy;
  /** Base fetch under the egress guard (tests inject one). */
  baseFetch?: typeof fetch;
  logger?: Logger;
  /** Connect and list timeout. */
  discoveryTimeoutMs?: number;
}

interface ToolMeta {
  mcpName: string;
  displayName: string;
  requiresApproval: boolean;
  inputSchema: Record<string, unknown>;
}

interface ContentBlock {
  type?: unknown;
  text?: unknown;
  mimeType?: unknown;
  uri?: unknown;
  name?: unknown;
  resource?: { uri?: unknown; text?: unknown; mimeType?: unknown };
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 20_000;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_TOOLS_PER_SERVER = 100;
const MAX_LIST_PAGES = 10;
const CLIENT_INFO = { name: 'stablehand', version: '0.1.0' };

/** Raised for configuration the operator must fix (missing secret, not connected). */
class McpSetupError extends Error {
  constructor(message: string, readonly state: 'needs_auth' | 'error') {
    super(message);
    this.name = 'McpSetupError';
  }
}

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Harness tool schemas mark every optional field nullable (OpenAI strict
 * mode), so models send `null` for fields they skip. MCP servers validate
 * against their own schema, where those fields are simply optional: drop the
 * nulls the original schema does not allow.
 */
export function stripDisallowedNulls(value: unknown, schema: Record<string, unknown> | undefined): unknown {
  if (!isRecord(value)) return value;
  const properties = isRecord(schema?.properties) ? schema.properties : {};
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const propertySchema = isRecord(properties[key]) ? properties[key] as Record<string, unknown> : undefined;
    if (entry === null) {
      const type = propertySchema?.type;
      const allowsNull = type === 'null' || (Array.isArray(type) && type.includes('null'));
      if (!allowsNull) continue;
    }
    result[key] = propertySchema?.type === 'object' ? stripDisallowedNulls(entry, propertySchema) : entry;
  }
  return result;
}

function describeBlock(block: ContentBlock): string | undefined {
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : undefined;
    case 'image':
    case 'audio':
      return `[${String(block.type)} ${typeof block.mimeType === 'string' ? block.mimeType : ''} not shown]`.replace('  ', ' ');
    case 'resource':
      if (typeof block.resource?.text === 'string') return block.resource.text;
      return `[resource ${String(block.resource?.uri ?? '')}]`;
    case 'resource_link':
      return `[link] ${typeof block.name === 'string' ? `${block.name}: ` : ''}${String(block.uri ?? '')}`;
    default:
      return undefined;
  }
}

/** Turns a `tools/call` result into the string a harness hands the model. */
export function formatMcpToolResult(result: Record<string, unknown>, maxChars = MAX_MCP_RESULT_CHARS): string {
  const content = Array.isArray(result.content) ? result.content as ContentBlock[] : [];
  const parts = content.map(describeBlock).filter((part): part is string => part !== undefined);
  let text = parts.join('\n');
  if (text.trim() === '' && result.structuredContent !== undefined) {
    text = JSON.stringify(result.structuredContent);
  }
  if (text.trim() === '' && result.toolResult !== undefined) {
    text = JSON.stringify(result.toolResult);
  }
  if (result.isError === true) {
    throw new Error(text.trim() !== '' ? text.slice(0, 4_000) : 'The MCP tool reported an error without details');
  }
  if (text.length > maxChars) {
    const omitted = text.length - maxChars;
    text = `${text.slice(0, maxChars)}\n[Result truncated: ${omitted} more characters. Ask the tool for fewer items.]`;
  }
  return text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The tools of one remote MCP server, offered to one agent. The client runs
 * in the orchestrator: bearer tokens and OAuth tokens are read from the
 * agent's tools-scope secrets here and never reach the sandbox, which only
 * ever sees tool names, schemas and results.
 *
 * `listTools()` never touches the network; `discover()` connects, lists and
 * caches, and the manager calls it on agent save, after a connect and on
 * request. A server that is down leaves the agent's other tools working.
 */
export class McpServerToolProvider implements ToolProvider {
  readonly name: string;
  readonly source: ToolSourceKind = 'mcp';
  readonly agentScope: string;
  readonly attachAll = true;

  private client?: Client;
  private connecting?: Promise<Client>;
  private tools: ToolDefinition[] = [];
  private readonly toolMeta = new Map<string, ToolMeta>();
  private state: McpServerState = 'connecting';
  private message?: string;
  private lastListedAt: number | null = null;
  private oauthHosts: string[] = [];
  private readonly logger: Logger;
  private readonly serverHost: string;

  constructor(private readonly deps: McpServerToolProviderDeps) {
    this.name = mcpProviderName(deps.agentId, deps.server.name);
    this.agentScope = deps.agentId;
    this.logger = deps.logger ?? noopLogger;
    this.serverHost = new URL(deps.server.url).hostname.toLowerCase();
  }

  get server(): McpServerDefinition {
    return this.deps.server;
  }

  async listTools(): Promise<ToolDefinition[]> {
    return this.tools;
  }

  status(): McpServerRuntimeStatus {
    return {
      state: this.state,
      ...(this.message ? { message: this.message } : {}),
      toolCount: this.tools.length,
      lastListedAt: this.lastListedAt,
      tools: this.tools.map((tool) => {
        const meta = this.toolMeta.get(tool.name);
        return {
          name: tool.name,
          mcpName: meta?.mcpName ?? tool.name,
          displayName: meta?.displayName ?? tool.name,
          requiresApproval: tool.requiresApproval === true,
        };
      }),
    };
  }

  catalogInfo(tool: ToolDefinition): ToolCatalogInfo | undefined {
    const meta = this.toolMeta.get(tool.name);
    return meta ? { displayName: meta.displayName, server: this.deps.server.name } : { server: this.deps.server.name };
  }

  /** Connect, list every allowed tool and cache the result. Never throws. */
  async discover(): Promise<McpServerRuntimeStatus> {
    try {
      const client = await this.getClient();
      const listed: Array<Record<string, unknown>> = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const response = await client.listTools(
          cursor ? { cursor } : undefined,
          { timeout: this.deps.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS },
        );
        listed.push(...(response.tools as Array<Record<string, unknown>>));
        cursor = typeof response.nextCursor === 'string' ? response.nextCursor : undefined;
        if (!cursor) break;
      }
      this.buildTools(listed);
      this.state = 'ready';
      this.message = undefined;
      this.lastListedAt = Date.now();
      this.logger.info(`[mcp] ${this.deps.server.name}: ${this.tools.length} tool(s) for agent ${this.deps.agentId}`);
    } catch (error) {
      await this.resetClient();
      this.recordFailure(error);
    }
    return this.status();
  }

  async execute(toolName: string, args: unknown, _ctx: ToolContext): Promise<string> {
    const meta = this.toolMeta.get(toolName);
    if (!meta) {
      throw new Error(`MCP server ${this.deps.server.name} has no tool ${toolName}`);
    }
    const request = {
      name: meta.mcpName,
      arguments: stripDisallowedNulls(isRecord(args) ? args : {}, meta.inputSchema) as Record<string, unknown>,
    };
    const timeout = this.deps.server.timeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS;

    for (let attempt = 0; ; attempt++) {
      let client: Client;
      try {
        client = await this.getClient();
      } catch (error) {
        this.recordFailure(error);
        throw new Error(this.message ?? errorMessage(error), { cause: error });
      }
      try {
        const result = await client.callTool(request, undefined, { timeout });
        return formatMcpToolResult(result as Record<string, unknown>);
      } catch (error) {
        // A Streamable HTTP session the server forgot answers 404 before the
        // call runs, so reconnecting and sending it again is safe. Anything
        // else may have reached the server; do not repeat it.
        const sessionExpired = error instanceof StreamableHTTPError && error.code === 404;
        if (error instanceof StreamableHTTPError || error instanceof UnauthorizedError || sessionExpired) {
          await this.resetClient();
        }
        if (sessionExpired && attempt === 0) {
          continue;
        }
        if (error instanceof UnauthorizedError) {
          this.recordFailure(error);
          throw new Error(this.message ?? 'The MCP server refused the stored credentials', { cause: error });
        }
        throw error;
      }
    }
  }

  async close(): Promise<void> {
    await this.resetClient();
  }

  // ── internals ─────────────────────────────────────────────────────────

  private recordFailure(error: unknown): void {
    const label = this.deps.server.name;
    if (error instanceof McpSetupError) {
      this.state = error.state;
      this.message = error.message;
    } else if (error instanceof UnauthorizedError || (error instanceof StreamableHTTPError && error.code === 401)) {
      this.state = 'needs_auth';
      this.message = this.deps.server.auth?.type === 'oauth'
        ? `${label} asked for a new sign-in. Connect it again from the agent's Tools tab.`
        : `${label} refused the token. Check the secret named in this server's auth.`;
    } else if (error instanceof EgressBlockedError) {
      this.state = 'error';
      this.message = error.message;
    } else {
      this.state = 'error';
      this.message = `${label} could not be reached: ${errorMessage(error).slice(0, 300)}`;
    }
    if (this.state === 'needs_auth') {
      // Tools that cannot be called until someone acts should not be offered.
      // A server that is merely down keeps its last list.
      this.tools = [];
      this.toolMeta.clear();
    }
    this.logger.warn(`[mcp] ${label} (agent ${this.deps.agentId}): ${this.message}`);
  }

  private async resetClient(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    if (!client) return;
    try {
      await client.close();
    } catch (error) {
      this.logger.warn(`[mcp] closing ${this.deps.server.name} failed: ${errorMessage(error)}`);
    }
  }

  private async resolveSecretRef(reference: string, field: string): Promise<string> {
    const secretName = parseSecretReference(reference);
    if (!secretName) {
      throw new McpSetupError(`${this.deps.server.name}: ${field} must be a $secret:NAME reference`, 'error');
    }
    const value = await this.deps.readSecret(secretName);
    if (!value) {
      throw new McpSetupError(
        `${this.deps.server.name} needs the secret ${secretName}. Add it on this agent as a tools-only secret.`,
        'needs_auth',
      );
    }
    return value;
  }

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = this.connect().then(
        (client) => {
          this.client = client;
          return client;
        },
        (error: unknown) => {
          this.connecting = undefined;
          throw error;
        },
      );
    }
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    const { server } = this.deps;
    const headers: Record<string, string> = {};
    let authProvider: StoredOAuthClientProvider | undefined;
    const auth = server.auth ?? { type: 'none' as const };
    if (auth.type === 'bearer') {
      headers.Authorization = `Bearer ${await this.resolveSecretRef(auth.token, 'auth.token')}`;
    } else if (auth.type === 'header') {
      headers[auth.name] = await this.resolveSecretRef(auth.value, 'auth.value');
    } else if (auth.type === 'oauth') {
      if (!this.deps.oauthStore) {
        throw new McpSetupError(`${server.name} uses OAuth, but no token store is configured`, 'error');
      }
      authProvider = await StoredOAuthClientProvider.load({
        store: this.deps.oauthStore,
        agentId: this.deps.agentId,
        serverName: server.name,
        ...(auth.scopes ? { scopes: auth.scopes } : {}),
      });
      if (!authProvider.currentRecord.tokens) {
        throw new McpSetupError(
          `${server.name} is not connected yet. Open the agent's Tools tab and press Connect.`,
          'needs_auth',
        );
      }
      this.oauthHosts = authorizationHosts(authProvider.currentRecord);
    }

    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      fetch: createMcpFetch({
        allowedHosts: () => [this.serverHost, ...this.oauthHosts],
        ...(this.deps.egressPolicy ? { policy: this.deps.egressPolicy } : {}),
        ...(this.deps.baseFetch ? { baseFetch: this.deps.baseFetch } : {}),
      }),
      requestInit: { headers },
      ...(authProvider ? { authProvider } : {}),
    });
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: this.deps.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS });
    } catch (error) {
      await transport.close().catch((closeError: unknown) => {
        this.logger.warn(`[mcp] closing a failed ${server.name} transport: ${errorMessage(closeError)}`);
      });
      throw error;
    }
    return client;
  }

  private buildTools(listed: Array<Record<string, unknown>>): void {
    const tools: ToolDefinition[] = [];
    this.toolMeta.clear();
    for (const raw of listed) {
      if (tools.length >= MAX_TOOLS_PER_SERVER) {
        this.logger.warn(`[mcp] ${this.deps.server.name} lists more than ${MAX_TOOLS_PER_SERVER} tools; narrow it with tools: [...]`);
        break;
      }
      const mcpName = typeof raw.name === 'string' ? raw.name : undefined;
      if (!mcpName || !isMcpToolAllowed(this.deps.server, mcpName)) continue;

      let name = agentToolName(this.deps.server.name, mcpName);
      if (this.toolMeta.has(name)) {
        name = agentToolName(this.deps.server.name, `${mcpName}_${tools.length}`);
      }
      const annotations = isRecord(raw.annotations) ? raw.annotations as McpToolAnnotations : undefined;
      const title = typeof annotations?.title === 'string'
        ? annotations.title
        : typeof raw.title === 'string' ? raw.title : undefined;
      const displayName = title ?? humanizeMcpToolName(mcpName);
      const inputSchema = isRecord(raw.inputSchema) ? raw.inputSchema : { type: 'object', properties: {} };
      let input: z.ZodType;
      try {
        input = jsonSchemaToZod({ ...inputSchema, type: 'object' });
      } catch (error) {
        this.logger.warn(`[mcp] ${this.deps.server.name}/${mcpName}: schema not convertible (${errorMessage(error)}); accepting any object`);
        input = z.object({}).catchall(z.unknown());
      }
      const requiresApproval = mcpToolRequiresApproval(this.deps.server, mcpName, annotations);
      const description = (typeof raw.description === 'string' && raw.description.trim() !== ''
        ? raw.description.trim()
        : displayName).slice(0, MAX_DESCRIPTION_CHARS);

      this.toolMeta.set(name, { mcpName, displayName, requiresApproval, inputSchema });
      const toolName = name;
      tools.push({
        name: toolName,
        description,
        input,
        location: 'orchestrator',
        timeout: this.deps.server.timeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS,
        ...(requiresApproval ? { requiresApproval: true } : {}),
        handler: async (toolInput: unknown, ctx: ToolContext) => this.execute(toolName, toolInput, ctx),
      });
    }
    this.tools = tools;
  }
}
