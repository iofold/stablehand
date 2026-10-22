/**
 * Agents declare remote MCP servers; the orchestrator connects, lists their
 * tools, enforces approval and runs OAuth. Everything here goes through the
 * real HTTP API, the real tool registry and the real RequestTool path a
 * sandbox uses, against a real Streamable HTTP MCP server on loopback.
 */
import { type RequestToolRequest } from '@stablehand/proto/sandbox/v1';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createOrchestratorServiceImpl,
  DefaultOrchestratorToolRegistry,
} from '../../packages/stablehand/src/orchestrator/grpc/orchestrator-service.js';
import { mintTurnDeliveryCapability } from '../../packages/stablehand/src/orchestrator/grpc/turn-delivery-capability.js';
import { createToolApprovalGate } from '../../packages/stablehand/src/orchestrator/tool-approval-gate.js';
import { readSandboxScopeSecrets } from '../../packages/stablehand/src/secrets/scopes.js';
import {
  startTestMcpServer,
  type TestMcpServerHandle,
} from '../../packages/stablehand/src/mcp/__tests__/support/test-mcp-server.js';
import { allowConsoleErrors } from '../setup-strict.js';
import { createTestApp, type TestAppHandle } from '../utils/test-app.js';

const CALLBACK_SECRET = 'mcp-integration-secret';

const BASE_AGENT = {
  harness: 'langgraph',
  harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
  systemPrompt: 'Use the notes server.',
  tools: [],
};

interface StatusBody {
  servers: Array<{
    name: string;
    state: string;
    message?: string;
    connected: boolean;
    toolCount: number;
    tools: Array<{ name: string; displayName: string; requiresApproval: boolean }>;
  }>;
}

describe('agent MCP servers', () => {
  let testApp: TestAppHandle | undefined;
  let bearerServer: TestMcpServerHandle;
  let oauthServer: TestMcpServerHandle;
  const previousAllowlist = process.env.STABLEHAND_EGRESS_ALLOWLIST;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    process.env.STABLEHAND_EGRESS_ALLOWLIST = '127.0.0.1';
    bearerServer = await startTestMcpServer({ type: 'bearer', token: 'notes-token-value' });
    oauthServer = await startTestMcpServer({ type: 'oauth' });
    testApp = await createTestApp({ dirPrefix: 'stablehand-mcp-servers-' });
  });

  afterAll(async () => {
    await testApp?.close();
    await bearerServer?.close();
    await oauthServer?.close();
    if (previousAllowlist === undefined) {
      delete process.env.STABLEHAND_EGRESS_ALLOWLIST;
    } else {
      process.env.STABLEHAND_EGRESS_ALLOWLIST = previousAllowlist;
    }
  });

  function app() {
    if (!testApp) throw new Error('test app not started');
    return testApp.app;
  }

  async function status(agentId: string): Promise<StatusBody> {
    const res = await app().inject({ method: 'GET', url: `/api/agents/${agentId}/mcp-servers` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<StatusBody>();
  }

  it('declares a bearer server, reads its token from tools-scope secrets, and lists its tools in the catalog', async () => {
    const created = await app().inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        ...BASE_AGENT,
        name: 'mcp-bearer-agent',
        mcpServers: [{
          name: 'notes',
          url: bearerServer.url,
          auth: { type: 'bearer', token: '$secret:NOTES_TOKEN' },
          tools: ['list_notes', 'get_note', 'delete_note'],
        }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const agentId = created.json<{ id: string; mcpServers: unknown[] }>().id;
    expect(created.json<{ mcpServers: unknown[] }>().mcpServers).toHaveLength(1);

    let body = await status(agentId);
    expect(body.servers[0]).toMatchObject({ name: 'notes', state: 'needs_auth', toolCount: 0 });
    expect(body.servers[0]?.message).toContain('NOTES_TOKEN');

    const secret = await app().inject({
      method: 'POST',
      url: `/api/agents/${agentId}/secrets`,
      payload: { key: 'NOTES_TOKEN', value: 'notes-token-value', scope: 'tools' },
    });
    expect(secret.statusCode).toBe(201);
    const sandboxSecret = await app().inject({
      method: 'POST',
      url: `/api/agents/${agentId}/secrets`,
      payload: { key: 'OPENAI_API_KEY', value: 'sk-model' },
    });
    expect(sandboxSecret.statusCode).toBe(201);

    const refreshed = await app().inject({ method: 'POST', url: `/api/agents/${agentId}/mcp-servers/notes/refresh` });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    body = refreshed.json<StatusBody>();
    expect(body.servers[0]).toMatchObject({ state: 'ready', connected: true, toolCount: 3 });
    expect(body.servers[0]?.tools).toEqual(expect.arrayContaining([
      { name: 'notes__list_notes', mcpName: 'list_notes', displayName: 'List notes', requiresApproval: false },
      { name: 'notes__delete_note', mcpName: 'delete_note', displayName: 'Delete note', requiresApproval: true },
    ]));

    // The token reached the MCP server and nothing the sandbox env is built from.
    const container = testApp!.container;
    expect(await readSandboxScopeSecrets(container.secretProvider, agentId)).toEqual({ OPENAI_API_KEY: 'sk-model' });

    const catalog = await app().inject({ method: 'GET', url: '/api/catalogs/tools' });
    expect(catalog.json<Array<Record<string, unknown>>>()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'notes__list_notes',
        displayName: 'List notes',
        source: 'mcp',
        server: 'notes',
        location: 'orchestrator',
      }),
      expect.objectContaining({ name: 'notes__delete_note', requiresApproval: true }),
    ]));

    // The agent's sandbox is offered the MCP tools without naming them.
    const offered = container.toolRegistry.listForAgent([], agentId).map((tool) => tool.name);
    expect(offered).toEqual(expect.arrayContaining(['notes__list_notes', 'notes__get_note', 'notes__delete_note']));
  });

  it('pauses a destructive MCP tool on an approval through the RequestTool path', async () => {
    const created = await app().inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        ...BASE_AGENT,
        name: 'mcp-approval-agent',
        mcpServers: [{ name: 'notes', url: bearerServer.url, auth: { type: 'bearer', token: '$secret:NOTES_TOKEN' } }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const agentId = created.json<{ id: string }>().id;
    await app().inject({
      method: 'POST',
      url: `/api/agents/${agentId}/secrets`,
      payload: { key: 'NOTES_TOKEN', value: 'notes-token-value', scope: 'tools' },
    });
    await app().inject({ method: 'POST', url: `/api/agents/${agentId}/mcp-servers/notes/refresh` });

    const { container } = testApp!;
    const db = container.db;
    const conversation = await db.createConversation(agentId);
    const sandboxSession = await db.createSandboxSession({
      conversationId: conversation.id,
      agentId,
      harnessName: 'langgraph',
      containerName: 'mcp-approval-container',
      containerId: 'mcp-approval-container-id',
    });
    const turn = await db.createTurn({
      sandboxSessionId: sandboxSession.id,
      agentId,
      conversationId: conversation.id,
      mode: 'background',
    });
    const lease = await db.claimTurnDeliveryLease({ turnId: turn.id, ownerId: 'mcp-owner', leaseDurationMs: 60_000 });
    if (!lease) throw new Error('no lease');
    expect(await db.activateTurnDelivery({
      turnId: turn.id,
      sandboxSessionId: sandboxSession.id,
      ownerId: lease.ownerId,
      fenceToken: lease.fenceToken,
      expectedActiveGeneration: {
        restoreFenceToken: sandboxSession.restoreFenceToken,
        containerId: sandboxSession.containerId,
      },
    })).toBe(true);

    const registry = new DefaultOrchestratorToolRegistry(
      container.toolRegistry,
      (ctx) => ({ agentId: ctx.agentId, conversationId: ctx.conversationId ?? '', workspaceDir: '/workspace' }),
      { approvalGate: createToolApprovalGate({ interruptManager: container.interruptManager, eventBus: container.eventBus }) },
    );
    const service = createOrchestratorServiceImpl({
      eventBus: container.eventBus,
      toolRegistry: registry,
      repository: db,
      callbackAuthConfig: { mode: 'enforce', secret: CALLBACK_SECRET },
    });
    const request = (toolName: string, args: unknown, requestId: string): RequestToolRequest => ({
      $typeName: 'stablehand.sandbox.v1.RequestToolRequest',
      turnId: turn.id,
      sandboxSessionId: sandboxSession.id,
      agentId,
      toolName,
      argsJson: JSON.stringify(args),
      requestId,
      deliveryCapability: mintTurnDeliveryCapability({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        agentId,
        ownerId: lease.ownerId,
        fenceToken: lease.fenceToken,
        leaseExpiresAtMs: lease.leaseExpiresAt,
        restoreFenceToken: sandboxSession.restoreFenceToken,
        ...(sandboxSession.containerId ? { containerId: sandboxSession.containerId } : {}),
      }, { mode: 'enforce', secret: CALLBACK_SECRET }),
    });

    const read = await service.requestTool(request('notes__get_note', { id: 'n1' }, 'mcp-read'));
    expect(read.result).toContain('Pricing review');

    const callsBefore = bearerServer.calls.length;
    const pending = service.requestTool(request('notes__delete_note', { id: 'n2' }, 'mcp-delete'));
    await vi.waitFor(async () => {
      expect((await db.getPendingInterruptForTurn(turn.id))?.toolName).toBe('notes__delete_note');
    }, { timeout: 5_000, interval: 25 });
    expect(bearerServer.calls.length).toBe(callsBefore);

    await container.interruptManager.resolveForTurn(turn.id, 'approve', undefined, agentId);
    const approved = await pending;
    expect(approved.error).toBeFalsy();
    expect(approved.result).toBe('deleted n2');
    expect(bearerServer.calls.at(-1)).toMatchObject({ name: 'delete_note', arguments: { id: 'n2' } });
  });

  it('connects an OAuth server through the connect route and the public callback', async () => {
    const created = await app().inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        ...BASE_AGENT,
        name: 'mcp-oauth-agent',
        mcpServers: [{ name: 'granola', url: oauthServer.url, auth: { type: 'oauth' }, tools: ['list_notes', 'get_note'] }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const agentId = created.json<{ id: string }>().id;
    expect((await status(agentId)).servers[0]).toMatchObject({ state: 'needs_auth', connected: false });

    const connect = await app().inject({
      method: 'POST',
      url: `/api/agents/${agentId}/mcp-servers/granola/connect`,
      payload: { redirectOrigin: 'https://stablehand.example.com' },
    });
    expect(connect.statusCode, connect.body).toBe(200);
    const { authorizationUrl, host } = connect.json<{ authorizationUrl: string; host: string }>();
    expect(host).toBe(new URL(oauthServer.origin).host);
    expect(new URL(authorizationUrl).searchParams.get('redirect_uri'))
      .toBe('https://stablehand.example.com/api/mcp/oauth/callback');

    const redirect = await oauthServer.oauth.authorize(authorizationUrl);
    const callback = await app().inject({ method: 'GET', url: `${redirect.pathname}${redirect.search}` });
    expect(callback.statusCode, callback.body).toBe(200);
    expect(callback.headers['content-type']).toContain('text/html');
    expect(callback.headers['referrer-policy']).toBe('no-referrer');
    expect(callback.body).toContain('granola is connected');
    expect(callback.body).not.toContain(oauthServer.oauth.issuedAccessTokens[0]!);

    expect((await status(agentId)).servers[0]).toMatchObject({ state: 'ready', connected: true, toolCount: 2 });

    const replay = await app().inject({ method: 'GET', url: `${redirect.pathname}${redirect.search}` });
    expect(replay.statusCode).toBe(409);

    const disconnect = await app().inject({ method: 'DELETE', url: `/api/agents/${agentId}/mcp-servers/granola/connection` });
    expect(disconnect.statusCode).toBe(204);
    expect((await status(agentId)).servers[0]).toMatchObject({ state: 'needs_auth', connected: false, toolCount: 0 });
  });

  it('refuses an http server the egress policy does not allow, and removes servers with the agent', async () => {
    const blocked = await app().inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        ...BASE_AGENT,
        name: 'mcp-blocked-agent',
        mcpServers: [{ name: 'internal', url: 'http://notes-mcp.internal:8787/mcp' }],
      },
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json<{ code: string; error: string }>()).toMatchObject({ code: 'mcp_server_blocked' });
    expect(blocked.json<{ error: string }>().error).toContain('STABLEHAND_EGRESS_ALLOWLIST');

    const literalToken = await app().inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        ...BASE_AGENT,
        name: 'mcp-literal-token-agent',
        mcpServers: [{ name: 'notes', url: bearerServer.url, auth: { type: 'bearer', token: 'notes-token-value' } }],
      },
    });
    expect(literalToken.statusCode).toBe(400);

    const created = await app().inject({
      method: 'POST',
      url: '/api/agents',
      payload: { ...BASE_AGENT, name: 'mcp-lifecycle-agent', mcpServers: [{ name: 'notes', url: bearerServer.url }] },
    });
    const agentId = created.json<{ id: string }>().id;
    const { container } = testApp!;
    expect(container.toolRegistry.providerNamesForAgent(agentId)).toEqual([`mcp-${agentId}-notes`]);

    const patched = await app().inject({ method: 'PATCH', url: `/api/agents/${agentId}`, payload: { mcpServers: null } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json<{ mcpServers: unknown[] }>().mcpServers).toEqual([]);
    expect(container.toolRegistry.providerNamesForAgent(agentId)).toEqual([]);

    await app().inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      payload: { mcpServers: [{ name: 'notes', url: bearerServer.url }] },
    });
    expect(container.toolRegistry.providerNamesForAgent(agentId)).toHaveLength(1);
    const removed = await app().inject({ method: 'DELETE', url: `/api/agents/${agentId}` });
    expect(removed.statusCode).toBeLessThan(300);
    expect(container.toolRegistry.providerNamesForAgent(agentId)).toEqual([]);
  });
});
