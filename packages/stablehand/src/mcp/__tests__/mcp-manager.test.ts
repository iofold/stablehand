import { afterEach, describe, expect, it } from 'vitest';
import type { McpServerDefinition } from '@stablehand/contracts';
import type { ToolContext } from '@stablehand/sandbox-daemon';

import { DefaultToolRegistry } from '../../tool/registry.js';
import { readSandboxScopeSecrets, TOOL_SECRET_SCOPE_ID } from '../../secrets/scopes.js';
import type { EgressPolicy } from '../../util/egress.js';
import { McpConnectError, McpServerManager, type McpAgentRef } from '../manager.js';
import { mcpOAuthSecretKey } from '../oauth.js';
import { MemorySecretProvider } from './support/memory-secrets.js';
import { startTestMcpServer, type TestMcpServerHandle } from './support/test-mcp-server.js';

const LOOPBACK_ALLOWED: EgressPolicy = {
  enforce: true,
  allowlist: ['127.0.0.1'],
  allowlistOnly: false,
  maxRedirects: 5,
};

const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function agent(id: string, mcpServers: McpServerDefinition[]): McpAgentRef {
  return { id, name: `${id}-name`, metadata: { mcpServers } };
}

describe('McpServerManager', () => {
  let server: TestMcpServerHandle | undefined;
  let manager: McpServerManager | undefined;

  afterEach(async () => {
    await manager?.close();
    manager = undefined;
    await server?.close();
    server = undefined;
  });

  function setup(secrets = new MemorySecretProvider()) {
    const registry = new DefaultToolRegistry();
    manager = new McpServerManager({
      toolRegistry: registry,
      secretProvider: secrets,
      egressPolicy: () => LOOPBACK_ALLOWED,
      discoveryTimeoutMs: 5_000,
      logger: quietLogger,
    });
    return { registry, secrets, manager };
  }

  it('registers each agent\'s servers as agent-scoped tools without naming them in tools[]', async () => {
    server = await startTestMcpServer();
    const { registry, manager: mcp } = setup();
    const owner = agent('agent-owner', [{ name: 'notes', url: server.url, tools: ['list_notes', 'delete_note'] }]);
    await mcp.sync(owner);

    expect(registry.listForAgent([], 'agent-owner').map((tool) => tool.name).sort())
      .toEqual(['notes__delete_note', 'notes__list_notes']);
    expect(registry.listForAgent([], 'agent-other').map((tool) => tool.name)).toEqual([]);
    expect(registry.getTool('notes__list_notes', 'agent-other')).toBeUndefined();
    expect(registry.getTool('notes__delete_note', 'agent-owner')?.requiresApproval).toBe(true);

    const entry = registry.listEntries().find((candidate) => candidate.tool.name === 'notes__list_notes');
    expect(entry).toMatchObject({ source: 'mcp', agentScope: 'agent-owner', catalog: { displayName: 'List notes', server: 'notes' } });

    const [status] = await mcp.status(owner);
    expect(status).toMatchObject({ name: 'notes', state: 'ready', authType: 'none', connected: true, toolCount: 2 });

    // Removing the server from the agent removes its tools.
    await mcp.sync(agent('agent-owner', []));
    expect(registry.listForAgent([], 'agent-owner')).toEqual([]);
  });

  it('connects an OAuth server end to end and keeps the tokens out of the sandbox scope', async () => {
    server = await startTestMcpServer({ type: 'oauth' });
    const { registry, secrets, manager: mcp } = setup();
    const notesAgent = agent('agent-oauth', [{ name: 'granola', url: server.url, auth: { type: 'oauth' } }]);

    await mcp.sync(notesAgent);
    let [status] = await mcp.status(notesAgent);
    expect(status).toMatchObject({ state: 'needs_auth', connected: false, toolCount: 0 });
    expect(status?.message).toMatch(/Connect/);

    const redirectUri = 'https://stablehand.example.com/api/mcp/oauth/callback';
    const started = await mcp.startConnect(notesAgent, 'granola', redirectUri);
    expect(started.host).toBe(new URL(server.origin).host);
    expect(server.oauth.registrations).toBe(1);
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(authorizationUrl.searchParams.get('resource')).toBe(server.url);

    // The person signs in; the provider redirects to Stablehand's callback.
    const redirect = await server.oauth.authorize(started.authorizationUrl);
    const callback = {
      code: redirect.searchParams.get('code') ?? '',
      state: redirect.searchParams.get('state') ?? '',
      iss: redirect.searchParams.get('iss') ?? '',
    };
    const loadAgent = async (id: string) => (id === notesAgent.id ? notesAgent : undefined);
    await expect(mcp.finishConnect(callback, loadAgent)).resolves.toEqual({
      agentName: 'agent-oauth-name',
      serverName: 'granola',
    });

    [status] = await mcp.status(notesAgent);
    expect(status).toMatchObject({ state: 'ready', connected: true, toolCount: 6 });

    const ctx: ToolContext = { agentId: notesAgent.id, conversationId: 'c', workspaceDir: '/workspace' };
    const listNotes = registry.getTool('granola__list_notes', notesAgent.id);
    expect(await listNotes?.handler({}, ctx)).toContain('Pricing review');
    const accessToken = server.oauth.issuedAccessTokens[0]!;
    expect(server.calls.at(-1)?.authorization).toBe(`Bearer ${accessToken}`);

    // Stored encrypted in the tools scope only, never where the sandbox reads.
    const stored = await secrets.get(notesAgent.id, mcpOAuthSecretKey('granola'), TOOL_SECRET_SCOPE_ID);
    expect(stored).toContain(accessToken);
    expect(await readSandboxScopeSecrets(secrets, notesAgent.id)).toEqual({});
    expect(JSON.stringify(registry.listForAgent([], notesAgent.id))).not.toContain(accessToken);

    // The state is single use.
    await expect(mcp.finishConnect(callback, loadAgent)).rejects.toBeInstanceOf(McpConnectError);

    // An expired access token is refreshed by the orchestrator, not the person.
    server.oauth.expireAccessTokens();
    await mcp.refreshServer(notesAgent.id, 'granola');
    expect(server.oauth.refreshes).toBe(1);
    expect(await registry.getTool('granola__get_note', notesAgent.id)?.handler({ id: 'n2' }, ctx)).toContain('Hiring sync');

    // Disconnecting forgets the sign-in and withdraws the tools.
    await mcp.disconnect(notesAgent, 'granola');
    [status] = await mcp.status(notesAgent);
    expect(status).toMatchObject({ state: 'needs_auth', connected: false, toolCount: 0 });
    expect(registry.listForAgent([], notesAgent.id)).toEqual([]);
  });

  it('rejects a callback whose state was tampered with or replaced', async () => {
    server = await startTestMcpServer({ type: 'oauth' });
    const { manager: mcp } = setup();
    const notesAgent = agent('agent-state', [{ name: 'granola', url: server.url, auth: { type: 'oauth' } }]);
    await mcp.sync(notesAgent);
    const loadAgent = async () => notesAgent;

    await expect(mcp.finishConnect({ code: 'x', state: 'not-a-state' }, loadAgent))
      .rejects.toMatchObject({ status: 400 });

    const first = await mcp.startConnect(notesAgent, 'granola', 'https://a.example.com/api/mcp/oauth/callback');
    const firstRedirect = await server.oauth.authorize(first.authorizationUrl);
    // A second Connect replaces the pending sign-in; the first link is dead.
    await mcp.startConnect(notesAgent, 'granola', 'https://a.example.com/api/mcp/oauth/callback');
    await expect(mcp.finishConnect({
      code: firstRedirect.searchParams.get('code') ?? '',
      state: firstRedirect.searchParams.get('state') ?? '',
    }, loadAgent)).rejects.toMatchObject({ status: 409 });

    await expect(mcp.startConnect(agent('agent-state', [{ name: 'plain', url: server.url }]), 'plain', 'https://a.example.com/cb'))
      .rejects.toMatchObject({ status: 400 });
  });
});
