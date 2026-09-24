import { HTTPToolProvider, type HttpEndpointConfig } from '../tool/providers/http.js';
import { DefaultToolRegistry } from '../tool/registry.js';
import type { AgentDefinition } from '@stablehand/sandbox-daemon';
import type { DatabaseRepository } from '../database/repository.js';
import type { SecretProvider } from '../secrets/types.js';
import { createGuardedFetch } from '../util/egress.js';

/**
 * Guarded fetch shared by every agent HTTP tool provider so that
 * agent-supplied endpoints cannot reach private/control-plane networks
 * (SSRF). Lazily built from STABLEHAND_EGRESS_* env policy.
 */
let sharedGuardedFetch: typeof fetch | undefined;
function getGuardedFetch(): typeof fetch {
  if (!sharedGuardedFetch) {
    sharedGuardedFetch = createGuardedFetch();
  }
  return sharedGuardedFetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;

function isHttpMethod(value: unknown): value is HttpEndpointConfig['method'] {
  return typeof value === 'string' && (HTTP_METHODS as readonly string[]).includes(value);
}

function parseHttpMethod(value: unknown): HttpEndpointConfig['method'] {
  if (value === undefined) return 'POST';
  if (isHttpMethod(value)) return value;
  throw new Error(`Invalid HTTP tool method: ${String(value)}`);
}

function toHttpAuthentication(value: unknown): HttpEndpointConfig['authentication'] | undefined {
  if (!isRecord(value)) return undefined;
  const { type, secretName } = value;
  if ((type === 'bearer' || type === 'api-key') && isNonEmptyString(secretName)) {
    return {
      type,
      secretName,
      ...(value.allowEnvFallback === true ? { allowEnvFallback: true } : {}),
    };
  }
  return undefined;
}

export function mapAgentHttpToolsToConfigs(agentDef: AgentDefinition): HttpEndpointConfig[] {
  if (!isRecord(agentDef.metadata)) return [];
  const httpTools = agentDef.metadata.httpTools;
  if (!Array.isArray(httpTools)) return [];

  return httpTools.flatMap((tool): HttpEndpointConfig[] => {
    if (!isRecord(tool)) return [];
    const { name, description, endpoint } = tool;
    if (!isNonEmptyString(name) || !isNonEmptyString(description) || !isNonEmptyString(endpoint)) {
      return [];
    }

    const config: HttpEndpointConfig = {
      name,
      url: endpoint,
      method: parseHttpMethod(tool.method),
      description,
    };

    if (isRecord(tool.inputSchema)) {
      config.inputSchema = tool.inputSchema;
    }
    if (isStringRecord(tool.headers)) {
      config.headers = tool.headers;
    }
    if (typeof tool.timeoutMs === 'number') {
      config.timeoutMs = tool.timeoutMs;
    }
    const authentication = toHttpAuthentication(tool.authentication);
    if (authentication) {
      config.authentication = authentication;
    }
    if (tool.programmatic === true) {
      config.programmatic = true;
    }

    return [config];
  });
}

export function validateAgentHttpToolsConfig(httpTools: unknown): string | null {
  if (httpTools === undefined) return null;
  if (!Array.isArray(httpTools)) return 'HTTP tool requires name, description, and endpoint';

  const names = new Set<string>();
  for (const httpTool of httpTools) {
    if (!isRecord(httpTool) || !isNonEmptyString(httpTool.name) || !isNonEmptyString(httpTool.description) || !isNonEmptyString(httpTool.endpoint)) {
      return 'HTTP tool requires name, description, and endpoint';
    }
    if (names.has(httpTool.name)) {
      return `Duplicate HTTP tool name: ${httpTool.name}`;
    }
    names.add(httpTool.name);
    if (httpTool.method !== undefined && !isHttpMethod(httpTool.method)) {
      return `Invalid HTTP tool method: ${String(httpTool.method)}`;
    }
    if (httpTool.authentication !== undefined && toHttpAuthentication(httpTool.authentication) === undefined) {
      return 'HTTP tool authentication requires type bearer or api-key and secretName';
    }
  }
  return null;
}

export function getAgentHttpToolProviderName(agentId: string): string {
  return `http-${agentId}`;
}

async function resolveProviderSecrets(
  agentId: string,
  secretProvider?: SecretProvider,
): Promise<Record<string, string>> {
  if (!secretProvider) return {};

  const secrets: Record<string, string> = {};
  const keys = await secretProvider.list(agentId);
  for (const key of keys) {
    const value = await secretProvider.get(agentId, key);
    if (value !== null) {
      secrets[key] = value;
    }
  }
  return secrets;
}

export async function registerAgentHttpTools(
  toolRegistry: DefaultToolRegistry,
  agent: { id: string; name: string; metadata?: Record<string, unknown> | null },
  secretProvider?: SecretProvider,
  /** Injectable fetch (defaults to the SSRF egress guard). Override in tests. */
  fetchFn: typeof fetch = getGuardedFetch(),
): Promise<void> {
  const providerName = getAgentHttpToolProviderName(agent.id);
  toolRegistry.removeProvider(providerName);

  const configs = mapAgentHttpToolsToConfigs({
    name: agent.name,
    harness: 'langgraph',
    harnessConfig: {},
    systemPrompt: '',
    tools: [],
    metadata: agent.metadata ?? undefined,
  });
  if (configs.length === 0) {
    console.warn(
      `[httpTools] agent "${agent.name}" (${agent.id}) has no httpTools in metadata — no HTTP tool provider registered`,
    );
    await toolRegistry.refresh();
    return;
  }

  toolRegistry.addProvider(new HTTPToolProvider(configs, {
    name: providerName,
    secrets: await resolveProviderSecrets(agent.id, secretProvider),
    fetchFn,
  }));
  await toolRegistry.refresh();
}

export async function registerExistingAgentHttpTools(
  db: Pick<DatabaseRepository, 'listAgents'>,
  toolRegistry: DefaultToolRegistry,
  secretProvider?: SecretProvider,
): Promise<void> {
  const agents = await db.listAgents();
  for (const agent of agents) {
    await registerAgentHttpTools(toolRegistry, {
      id: agent.id,
      name: agent.name,
      metadata: agent.metadata ?? undefined,
    }, secretProvider);
  }
}
