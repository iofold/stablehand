import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import type { McpServerDefinition, McpServerStatus } from '@stablehand/contracts';

import type { DefaultToolRegistry } from '../tool/registry.js';
import type { SecretProvider } from '../secrets/types.js';
import { readToolSecret } from '../secrets/scopes.js';
import { createGuardedFetch, resolveEgressPolicy, type EgressPolicy } from '../util/egress.js';
import { getAgentMcpServers, mcpProviderName, mcpProviderPrefix } from './config.js';
import {
  decodeOAuthState,
  oauthStatesMatch,
  secretBackedOAuthStore,
  StoredOAuthClientProvider,
  type McpOAuthStore,
} from './oauth.js';
import { McpServerToolProvider } from './provider.js';

interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface McpAgentRef {
  id: string;
  name: string;
  metadata?: Record<string, unknown> | null;
}

export interface McpServerManagerDeps {
  toolRegistry: DefaultToolRegistry;
  secretProvider?: SecretProvider;
  logger?: Logger;
  /** Read per request so env changes in tests apply; defaults to STABLEHAND_EGRESS_*. */
  egressPolicy?: () => EgressPolicy;
  /** Base fetch under the egress guard (tests). */
  baseFetch?: typeof fetch;
  discoveryTimeoutMs?: number;
}

export class McpConnectError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502) {
    super(message);
    this.name = 'McpConnectError';
  }
}

interface ManagedServer {
  provider: McpServerToolProvider;
  fingerprint: string;
}

const consoleLogger: Logger = {
  info: (message, ...args) => console.info(message, ...args),
  warn: (message, ...args) => console.warn(message, ...args),
  error: (message, ...args) => console.error(message, ...args),
};

/**
 * Keeps each agent's declared MCP servers registered in the tool registry as
 * agent-scoped providers, and runs the OAuth connect flow for servers that
 * need a person to sign in. One instance per orchestrator.
 */
export class McpServerManager {
  private readonly servers = new Map<string, Map<string, ManagedServer>>();
  private readonly logger: Logger;

  constructor(private readonly deps: McpServerManagerDeps) {
    this.logger = deps.logger ?? consoleLogger;
  }

  private policy(): EgressPolicy {
    return this.deps.egressPolicy ? this.deps.egressPolicy() : resolveEgressPolicy();
  }

  private oauthStore(agentId: string, serverName: string): McpOAuthStore | undefined {
    return this.deps.secretProvider
      ? secretBackedOAuthStore(this.deps.secretProvider, agentId, serverName)
      : undefined;
  }

  private createProvider(agentId: string, server: McpServerDefinition): McpServerToolProvider {
    const oauthStore = server.auth?.type === 'oauth' ? this.oauthStore(agentId, server.name) : undefined;
    return new McpServerToolProvider({
      agentId,
      server,
      readSecret: (name) => readToolSecret(this.deps.secretProvider, agentId, name),
      ...(oauthStore ? { oauthStore } : {}),
      egressPolicy: this.policy(),
      ...(this.deps.baseFetch ? { baseFetch: this.deps.baseFetch } : {}),
      ...(this.deps.discoveryTimeoutMs ? { discoveryTimeoutMs: this.deps.discoveryTimeoutMs } : {}),
      logger: this.logger,
    });
  }

  /**
   * Bring the registry in line with the agent's declared servers: new or
   * changed servers are (re)connected and listed, removed ones closed.
   * Unchanged servers keep their connection and cached tools.
   */
  async sync(agent: McpAgentRef): Promise<void> {
    const declared = getAgentMcpServers(agent.metadata);
    const current = this.servers.get(agent.id) ?? new Map<string, ManagedServer>();
    const next = new Map<string, ManagedServer>();
    const toDiscover: McpServerToolProvider[] = [];

    for (const server of declared) {
      const fingerprint = JSON.stringify(server);
      const existing = current.get(server.name);
      if (existing && existing.fingerprint === fingerprint) {
        next.set(server.name, existing);
        continue;
      }
      if (existing) {
        await this.retire(existing);
      }
      const provider = this.createProvider(agent.id, server);
      this.deps.toolRegistry.addProvider(provider);
      next.set(server.name, { provider, fingerprint });
      toDiscover.push(provider);
    }
    for (const [name, existing] of current) {
      if (!next.has(name)) {
        await this.retire(existing);
      }
    }
    // Providers left over from an earlier process state or a rename.
    for (const providerName of this.deps.toolRegistry.providerNamesForAgent(agent.id)) {
      if (!providerName.startsWith(mcpProviderPrefix(agent.id))) continue;
      const serverName = providerName.slice(mcpProviderPrefix(agent.id).length);
      if (!next.has(serverName)) {
        this.deps.toolRegistry.removeProvider(providerName);
      }
    }

    if (next.size > 0) {
      this.servers.set(agent.id, next);
    } else {
      this.servers.delete(agent.id);
    }
    await Promise.all(toDiscover.map((provider) => provider.discover()));
    await this.deps.toolRegistry.refresh();
  }

  async syncAll(agents: readonly McpAgentRef[]): Promise<void> {
    for (const agent of agents) {
      try {
        await this.sync(agent);
      } catch (error) {
        this.logger.error(`[mcp] could not register MCP servers for agent ${agent.id}:`, error);
      }
    }
  }

  async remove(agentId: string): Promise<void> {
    const current = this.servers.get(agentId);
    this.servers.delete(agentId);
    if (current) {
      for (const managed of current.values()) {
        await this.retire(managed);
      }
    }
    await this.deps.toolRegistry.refresh();
  }

  private async retire(managed: ManagedServer): Promise<void> {
    this.deps.toolRegistry.removeProvider(managed.provider.name);
    await managed.provider.close();
  }

  private managed(agentId: string, serverName: string): ManagedServer | undefined {
    return this.servers.get(agentId)?.get(serverName);
  }

  /** Re-list one server's tools (after a connect, or on request). */
  async refreshServer(agentId: string, serverName: string): Promise<void> {
    const managed = this.managed(agentId, serverName);
    if (!managed) {
      throw new McpConnectError(`Agent has no MCP server named ${serverName}`, 404);
    }
    await managed.provider.close();
    await managed.provider.discover();
    await this.deps.toolRegistry.refresh();
  }

  async status(agent: McpAgentRef): Promise<McpServerStatus[]> {
    const declared = getAgentMcpServers(agent.metadata);
    return Promise.all(declared.map(async (server): Promise<McpServerStatus> => {
      const runtime = this.managed(agent.id, server.name)?.provider.status();
      const connected = server.auth?.type === 'oauth'
        ? Boolean((await this.oauthStore(agent.id, server.name)?.load())?.tokens)
        : runtime?.state === 'ready';
      return {
        name: server.name,
        url: server.url,
        authType: server.auth?.type ?? 'none',
        state: runtime?.state ?? 'connecting',
        ...(runtime?.message ? { message: runtime.message } : {}),
        connected,
        toolCount: runtime?.toolCount ?? 0,
        lastListedAt: runtime?.lastListedAt ?? null,
        tools: runtime?.tools ?? [],
      };
    }));
  }

  // ── OAuth connect flow ────────────────────────────────────────────────

  private oauthServer(agent: McpAgentRef, serverName: string): McpServerDefinition {
    const server = getAgentMcpServers(agent.metadata).find((candidate) => candidate.name === serverName);
    if (!server) {
      throw new McpConnectError(`Agent has no MCP server named ${serverName}`, 404);
    }
    if (server.auth?.type !== 'oauth') {
      throw new McpConnectError(`${serverName} does not use OAuth; it reads its token from a secret`, 400);
    }
    return server;
  }

  /**
   * Start a connection: discover the authorization server, register this
   * deployment as a client if needed (dynamic client registration), and
   * return the sign-in URL for a person to open. Stablehand never opens it.
   */
  async startConnect(
    agent: McpAgentRef,
    serverName: string,
    redirectUri: string,
  ): Promise<{ authorizationUrl: string; host: string; expiresAt: number }> {
    const server = this.oauthServer(agent, serverName);
    const store = this.oauthStore(agent.id, server.name);
    if (!store) {
      throw new McpConnectError('Secret storage is not configured, so OAuth tokens cannot be kept', 409);
    }
    // A fresh connect replaces any stored sign-in.
    await store.update((record) => {
      delete record.tokens;
      delete record.connectedAt;
      delete record.pending;
    });
    const provider = await StoredOAuthClientProvider.load({
      store,
      redirectUri,
      agentId: agent.id,
      serverName: server.name,
      ...(server.auth?.type === 'oauth' && server.auth.scopes ? { scopes: server.auth.scopes } : {}),
    });
    let result: 'AUTHORIZED' | 'REDIRECT';
    try {
      // The interactive step runs under the egress guard but not the host
      // pin: the authorization server's host is only known after discovery.
      result = await auth(provider, {
        serverUrl: server.url,
        fetchFn: createGuardedFetch(this.policy(), this.deps.baseFetch),
      });
    } catch (error) {
      throw new McpConnectError(
        `Could not start sign-in for ${server.name}: ${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    }
    if (result === 'AUTHORIZED') {
      await this.refreshServer(agent.id, server.name);
      throw new McpConnectError(`${server.name} is already connected`, 409);
    }
    const authorizationUrl = provider.authorizationUrl;
    const pending = provider.currentRecord.pending;
    if (!authorizationUrl || !pending) {
      throw new McpConnectError(`${server.name} did not return a sign-in URL`, 502);
    }
    return {
      authorizationUrl: authorizationUrl.toString(),
      host: authorizationUrl.host,
      expiresAt: pending.expiresAt,
    };
  }

  /**
   * Finish a connection from the OAuth redirect: check the single-use state,
   * exchange the code (PKCE) for tokens, store them, then list the tools.
   */
  async finishConnect(
    params: { state: string; code: string; iss?: string },
    loadAgent: (agentId: string) => Promise<McpAgentRef | undefined>,
  ): Promise<{ agentName: string; serverName: string }> {
    const decoded = decodeOAuthState(params.state);
    if (!decoded) {
      throw new McpConnectError('This sign-in link is not valid. Start again from Connect.', 400);
    }
    const agent = await loadAgent(decoded.agentId);
    if (!agent) {
      throw new McpConnectError('The agent for this sign-in no longer exists.', 404);
    }
    const server = this.oauthServer(agent, decoded.serverName);
    const store = this.oauthStore(agent.id, server.name);
    if (!store) {
      throw new McpConnectError('Secret storage is not configured, so OAuth tokens cannot be kept', 409);
    }
    const record = await store.load();
    const pending = record.pending;
    if (!pending || !oauthStatesMatch(pending.state, params.state)) {
      throw new McpConnectError('This sign-in link was already used or replaced. Start again from Connect.', 409);
    }
    if (pending.expiresAt < Date.now()) {
      throw new McpConnectError('This sign-in took longer than 10 minutes. Start again from Connect.', 409);
    }
    // RFC 9207: when the authorization server names itself, it must be the
    // one discovery found (mix-up defence).
    const expectedIssuer = record.discoveryState?.authorizationServerMetadata?.issuer;
    if (params.iss && expectedIssuer && params.iss !== expectedIssuer) {
      throw new McpConnectError('The sign-in came back from a different authorization server. Start again.', 400);
    }

    const provider = await StoredOAuthClientProvider.load({
      store,
      redirectUri: pending.redirectUri,
      agentId: agent.id,
      serverName: server.name,
      ...(server.auth?.type === 'oauth' && server.auth.scopes ? { scopes: server.auth.scopes } : {}),
    });
    try {
      await auth(provider, {
        serverUrl: server.url,
        authorizationCode: params.code,
        fetchFn: createGuardedFetch(this.policy(), this.deps.baseFetch),
      });
    } catch (error) {
      throw new McpConnectError(
        `${server.name} did not accept the sign-in: ${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    } finally {
      await store.update((current) => {
        delete current.pending;
      });
    }
    if (!this.managed(agent.id, server.name)) {
      await this.sync(agent);
    } else {
      await this.refreshServer(agent.id, server.name);
    }
    return { agentName: agent.name, serverName: server.name };
  }

  /** Forget the stored sign-in; the server's tools disappear until reconnected. */
  async disconnect(agent: McpAgentRef, serverName: string): Promise<void> {
    const server = this.oauthServer(agent, serverName);
    await this.oauthStore(agent.id, server.name)?.clear();
    if (this.managed(agent.id, server.name)) {
      await this.refreshServer(agent.id, server.name);
    }
  }

  /** Provider name for an agent's server (diagnostics and tests). */
  static providerName(agentId: string, serverName: string): string {
    return mcpProviderName(agentId, serverName);
  }

  async close(): Promise<void> {
    for (const agentServers of this.servers.values()) {
      for (const managed of agentServers.values()) {
        await managed.provider.close();
      }
    }
    this.servers.clear();
  }
}
