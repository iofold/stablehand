import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { RequestToolRequestSchema } from '@stablehand/proto/sandbox/v1';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { DatabaseRepository } from '../../../database/repository.js';
import { TypedEventBus } from '../../../events/bus.js';
import { DefaultToolRegistry } from '../../../tool/registry.js';
import { HTTPToolProvider } from '../../../tool/providers/http.js';
import { mapAgentHttpToolsToConfigs } from '../../http-tools.js';
import {
  createOrchestratorServiceImpl,
  DefaultOrchestratorToolRegistry,
  registerDefaultToolHandlers,
} from '../orchestrator-service.js';
import { mintTurnDeliveryCapability } from '../turn-delivery-capability.js';

const AGENT_ID = 'agent-restricted';
const AUTH = { mode: 'enforce' as const, secret: 'synthetic-tool-grant-test-secret' };

function storedAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    name: 'Restricted agent',
    harness: 'langgraph',
    harnessConfig: '{}',
    systemPrompt: '',
    tools: [],
    description: null,
    workspaceDir: null,
    manifest: null,
    metadata: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function setup(agent = storedAgent()) {
  const eventBus = new TypedEventBus();
  const registry = new DefaultOrchestratorToolRegistry();
  const repository = {
    getAgent: vi.fn().mockResolvedValue(agent),
    getTurnDeliveryCapabilityClaims: vi.fn().mockResolvedValue({ conversationId: 'conversation-1' }),
    tryAdmitToolRequest: vi.fn().mockResolvedValue('inserted'),
    completeToolDedup: vi.fn().mockResolvedValue(true),
  };
  const createService = (toolRegistry = registry) => createOrchestratorServiceImpl({
    eventBus,
    toolRegistry,
    repository: repository as unknown as DatabaseRepository,
    callbackAuthConfig: AUTH,
  });
  return { eventBus, registry, repository, createService };
}

function request(toolName: string) {
  const claims = {
    turnId: 'turn-1',
    sandboxSessionId: 'sandbox-1',
    agentId: AGENT_ID,
    ownerId: 'owner-1',
    fenceToken: 1,
    leaseExpiresAtMs: Date.now() + 60_000,
    restoreFenceToken: 1,
    containerId: 'container-1',
  };
  return create(RequestToolRequestSchema, {
    turnId: claims.turnId,
    sandboxSessionId: claims.sandboxSessionId,
    agentId: claims.agentId,
    requestId: `request-${toolName}`,
    toolName,
    argsJson: '{}',
    deliveryCapability: mintTurnDeliveryCapability(claims, AUTH),
  });
}

async function expectDenied(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ConnectError);
  expect(error).toMatchObject({ code: Code.PermissionDenied });
}

describe('RequestTool enforces the agent tool grant', () => {
  it('rejects a registered tool absent from the authenticated agent catalog', async () => {
    const { registry, repository, createService } = setup();
    const handler = vi.fn(async () => 'sensitive result');
    registry.set('private-tool', handler);

    await expectDenied(createService().requestTool(request('private-tool')));

    expect(handler).not.toHaveBeenCalled();
    expect(repository.tryAdmitToolRequest).not.toHaveBeenCalled();
  });

  it('allows an explicitly declared tool', async () => {
    const { registry, createService } = setup(storedAgent({ tools: ['private-tool'] }));
    registry.set('private-tool', async () => 'allowed result');

    const response = await createService().requestTool(request('private-tool'));

    expect(response.result).toBe('allowed result');
  });

  it('includes HTTP tool names persisted in agent metadata', async () => {
    const { registry, createService } = setup(storedAgent({
      metadata: { httpTools: [{ name: 'agent-http-tool' }] },
    }));
    registry.set('agent-http-tool', async () => 'HTTP result');

    const response = await createService().requestTool(request('agent-http-tool'));

    expect(response.result).toBe('HTTP result');
  });

  it('rejects disabled builtins even when also named in tools', async () => {
    const { eventBus, registry, createService } = setup(storedAgent({
      tools: ['emit-event'],
      metadata: { builtinToolPolicy: { policy: 'none' } },
    }));
    registerDefaultToolHandlers(registry, eventBus);

    await expectDenied(createService().requestTool(request('emit-event')));
  });

  it('reads builtin policy from the manifest and respects the API override', async () => {
    const manifest = { spec: { builtinToolPolicy: { policy: 'none' } } };
    const { eventBus, registry, repository, createService } = setup(storedAgent({ manifest }));
    registerDefaultToolHandlers(registry, eventBus);
    const service = createService();

    await expectDenied(service.requestTool(request('emit-event')));
    repository.getAgent.mockResolvedValue(storedAgent({
      manifest,
      metadata: { builtinToolPolicy: { policy: 'all' } },
    }));
    const response = await service.requestTool(request('emit-event'));

    expect(response.result).toContain('requires a non-empty string');
  });

  it('does not cache a revoked tool grant across requests', async () => {
    const { registry, repository, createService } = setup(storedAgent({ tools: ['private-tool'] }));
    const handler = vi.fn(async () => 'allowed result');
    registry.set('private-tool', handler);
    const service = createService();
    await service.requestTool(request('private-tool'));
    repository.getAgent.mockResolvedValue(storedAgent());

    await expectDenied(service.requestTool(request('private-tool')));

    expect(handler).toHaveBeenCalledOnce();
  });

  it('fails closed when the authenticated agent has been deleted', async () => {
    const { registry, repository, createService } = setup();
    repository.getAgent.mockResolvedValue(undefined);
    registry.set('private-tool', async () => 'must not run');

    await expectDenied(createService().requestTool(request('private-tool')));
  });

  it('preserves attached MCP tools and rejects another agent provider', async () => {
    const ownServer = { name: 'own', url: 'https://mcp.example.test/mcp' };
    const { createService, repository } = setup(storedAgent({ metadata: { mcpServers: [ownServer] } }));
    const definitions = new DefaultToolRegistry();
    for (const [agentId, name] of [[AGENT_ID, 'own-mcp-tool'], ['agent-other', 'foreign-mcp-tool']]) {
      const provider = {
        name: `mcp-${agentId}`,
        source: 'mcp' as const,
        server: agentId === AGENT_ID ? ownServer : { ...ownServer, name: 'foreign' },
        agentScope: agentId,
        attachAll: true,
        async listTools() {
          return [{ name, description: 'Test MCP tool', input: z.object({}), handler: async () => name }];
        },
      };
      definitions.addProvider(provider);
    }
    await definitions.refresh();
    const registry = new DefaultOrchestratorToolRegistry(definitions, (ctx) => ({
      agentId: ctx.agentId,
      conversationId: '',
      workspaceDir: '/workspace',
    }));
    const service = createService(registry);

    expect((await service.requestTool(request('own-mcp-tool'))).result).toBe('own-mcp-tool');
    await expectDenied(service.requestTool(request('foreign-mcp-tool')));

    // A stale provider cache on this replica cannot retain authority after
    // another replica removes or narrows the stored MCP declaration.
    repository.getAgent.mockResolvedValue(storedAgent({
      tools: ['own-mcp-tool'],
      metadata: { mcpServers: [{ ...ownServer, tools: ['different-tool'] }] },
    }));
    await expectDenied(service.requestTool(request('own-mcp-tool')));
    repository.getAgent.mockResolvedValue(storedAgent({ tools: ['own-mcp-tool'] }));
    await expectDenied(service.requestTool(request('own-mcp-tool')));
  });

  it('rejects stale HTTP endpoint, credential and approval definitions before executing a cached tool', async () => {
    const httpTool = {
      name: 'send-request',
      description: 'Synthetic API tool',
      endpoint: 'https://tools.example.test/send',
      method: 'POST',
      authentication: { type: 'bearer', secretName: 'API_KEY' },
    };
    const metadata = { httpTools: [httpTool] };
    const { repository, createService } = setup(storedAgent({ metadata }));
    const fetchFn = vi.fn(async () => new Response('{"ok":true}'));
    const definitions = new DefaultToolRegistry();
    definitions.addProvider(new HTTPToolProvider(mapAgentHttpToolsToConfigs({
      name: 'Restricted agent', harness: 'langgraph', harnessConfig: {},
      systemPrompt: '', tools: [], metadata,
    }), {
      name: `http-${AGENT_ID}`,
      agentScope: AGENT_ID,
      fetchFn,
      secrets: { API_KEY: 'synthetic-scoped-key' },
    }));
    await definitions.refresh();
    const registry = new DefaultOrchestratorToolRegistry(definitions, (ctx) => ({
      agentId: ctx.agentId, conversationId: '', workspaceDir: '/workspace',
    }));
    const service = createService(registry);
    expect((await service.requestTool(request(httpTool.name))).error).toBeFalsy();
    expect(fetchFn).toHaveBeenCalledOnce();

    for (const changed of [
      { ...httpTool, requiresApproval: true },
      { ...httpTool, endpoint: 'https://tools.example.test/new-endpoint' },
      { ...httpTool, authentication: { type: 'bearer', secretName: 'ROTATED_KEY' } },
    ]) {
      repository.getAgent.mockResolvedValue(storedAgent({ metadata: { httpTools: [changed] } }));
      await expectDenied(service.requestTool(request(httpTool.name)));
    }
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
