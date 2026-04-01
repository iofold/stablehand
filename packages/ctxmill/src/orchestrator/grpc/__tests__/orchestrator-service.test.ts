import { describe, it, expect, vi, beforeEach } from 'vitest';
import { create } from '@bufbuild/protobuf';
import {
  RequestToolRequestSchema,
  EmitEventRequestSchema,
  RefreshSecretsRequestSchema,
} from '@ctxmill/proto/sandbox/v1';
import {
  createOrchestratorServiceImpl,
  DefaultOrchestratorToolRegistry,
  registerDefaultToolHandlers,
  type OrchestratorToolHandler,
} from '../orchestrator-service.js';
import { createGrpcRoutes } from '../router.js';
import { TypedEventBus } from '../../../events/bus.js';

function makeEventBus() {
  const bus = new TypedEventBus();
  // Spy on emitCustom
  vi.spyOn(bus, 'emitCustom');
  return bus;
}

function makeRegistry(handlers?: Record<string, OrchestratorToolHandler>) {
  const registry = new DefaultOrchestratorToolRegistry();
  if (handlers) {
    for (const [name, handler] of Object.entries(handlers)) {
      registry.set(name, handler);
    }
  }
  return registry;
}

describe('OrchestratorService — RequestTool', () => {
  let eventBus: TypedEventBus;

  beforeEach(() => {
    eventBus = makeEventBus();
  });

  it('dispatches to a registered tool handler and returns the result', async () => {
    const handler = vi.fn().mockResolvedValue('{"answer": 42}');
    const registry = makeRegistry({ 'my-tool': handler });
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const req = create(RequestToolRequestSchema, {
      sessionId: 'run-1',
      agentId: 'agent-1',
      toolName: 'my-tool',
      argsJson: '{"x": 1}',
      requestId: 'req-1',
    });

    const resp = await svc.requestTool(req);

    expect(resp.requestId).toBe('req-1');
    expect(resp.result).toBe('{"answer": 42}');
    expect(resp.error).toBeUndefined();
    expect(handler).toHaveBeenCalledWith(
      { x: 1 },
      { sessionId: 'run-1', agentId: 'agent-1', requestId: 'req-1' },
    );
  });

  it('returns error when tool is not found', async () => {
    const registry = makeRegistry();
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const req = create(RequestToolRequestSchema, {
      sessionId: 'run-1',
      agentId: 'agent-1',
      toolName: 'nonexistent',
      argsJson: '{}',
      requestId: 'req-2',
    });

    const resp = await svc.requestTool(req);

    expect(resp.requestId).toBe('req-2');
    expect(resp.error).toBe('Unknown orchestrator tool: nonexistent');
    expect(resp.result).toBe('');
  });

  it('returns error when args_json is malformed', async () => {
    const handler = vi.fn();
    const registry = makeRegistry({ 'my-tool': handler });
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const req = create(RequestToolRequestSchema, {
      sessionId: 'run-1',
      agentId: 'agent-1',
      toolName: 'my-tool',
      argsJson: 'not-json',
      requestId: 'req-3',
    });

    const resp = await svc.requestTool(req);

    expect(resp.error).toBe('Invalid args_json: failed to parse JSON');
    expect(handler).not.toHaveBeenCalled();
  });

  it('catches handler errors and returns them in the error field', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('tool exploded'));
    const registry = makeRegistry({ 'boom': handler });
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const req = create(RequestToolRequestSchema, {
      sessionId: 'run-1',
      agentId: 'agent-1',
      toolName: 'boom',
      argsJson: '{}',
      requestId: 'req-4',
    });

    const resp = await svc.requestTool(req);

    expect(resp.error).toBe('tool exploded');
    expect(resp.result).toBe('');
  });

  it('throws ConnectError when tool_name is empty', async () => {
    const registry = makeRegistry();
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const req = create(RequestToolRequestSchema, {
      sessionId: 'run-1',
      agentId: 'agent-1',
      toolName: '',
      argsJson: '{}',
      requestId: 'req-5',
    });

    await expect(svc.requestTool(req)).rejects.toThrow('tool_name is required');
  });

  it('handles empty args_json gracefully', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    const registry = makeRegistry({ 'no-args': handler });
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const req = create(RequestToolRequestSchema, {
      sessionId: 'run-1',
      agentId: 'agent-1',
      toolName: 'no-args',
      argsJson: '',
      requestId: 'req-6',
    });

    const resp = await svc.requestTool(req);

    expect(resp.result).toBe('ok');
    expect(handler).toHaveBeenCalledWith(
      {},
      { sessionId: 'run-1', agentId: 'agent-1', requestId: 'req-6' },
    );
  });
});

describe('OrchestratorService — EmitEvent', () => {
  let eventBus: TypedEventBus;

  beforeEach(() => {
    eventBus = makeEventBus();
  });

  it('emits a custom event on the EventBus', async () => {
    const registry = makeRegistry();
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const req = create(EmitEventRequestSchema, {
      sessionId: 'run-1',
      eventType: 'agent.progress',
      payloadJson: '{"step": 3, "agentId": "agent-1"}',
    });

    const resp = await svc.emitEvent(req);

    expect(resp).toBeDefined();
    expect(eventBus.emitCustom).toHaveBeenCalledWith(
      'agent.progress',
      'agent-1',
      expect.objectContaining({ step: 3, agentId: 'agent-1', runId: 'run-1' }),
    );
  });

  it('injects runId into the payload', async () => {
    const registry = makeRegistry();
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const req = create(EmitEventRequestSchema, {
      sessionId: 'run-42',
      eventType: 'test.event',
      payloadJson: '{"data": "hello"}',
    });

    await svc.emitEvent(req);

    expect(eventBus.emitCustom).toHaveBeenCalledWith(
      'test.event',
      '',
      expect.objectContaining({ data: 'hello', runId: 'run-42' }),
    );
  });

  it('throws ConnectError when event_type is empty', async () => {
    const registry = makeRegistry();
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const req = create(EmitEventRequestSchema, {
      sessionId: 'run-1',
      eventType: '',
      payloadJson: '{}',
    });

    await expect(svc.emitEvent(req)).rejects.toThrow('event_type is required');
  });

  it('throws ConnectError when payload_json is malformed', async () => {
    const registry = makeRegistry();
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const req = create(EmitEventRequestSchema, {
      sessionId: 'run-1',
      eventType: 'test.event',
      payloadJson: '{bad',
    });

    await expect(svc.emitEvent(req)).rejects.toThrow('Invalid payload_json');
  });

  it('handles empty payload_json gracefully', async () => {
    const registry = makeRegistry();
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const req = create(EmitEventRequestSchema, {
      sessionId: 'run-1',
      eventType: 'simple.event',
      payloadJson: '',
    });

    await svc.emitEvent(req);

    expect(eventBus.emitCustom).toHaveBeenCalledWith(
      'simple.event',
      '',
      expect.objectContaining({ runId: 'run-1' }),
    );
  });
});

describe('OrchestratorService — RefreshSecrets', () => {
  it('returns a stub response indicating not implemented', async () => {
    const eventBus = makeEventBus();
    const registry = makeRegistry();
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const req = create(RefreshSecretsRequestSchema, {
      sessionId: 'run-1',
      agentId: 'agent-1',
    });

    const resp = await svc.refreshSecrets(req);

    expect(resp.success).toBe(false);
    expect(resp.error).toContain('not yet implemented');
    expect(resp.secretsPath).toBe('');
  });
});

describe('DefaultOrchestratorToolRegistry', () => {
  it('stores and retrieves tool handlers', () => {
    const registry = new DefaultOrchestratorToolRegistry();
    const handler: OrchestratorToolHandler = async () => 'result';

    registry.set('my-tool', handler);

    expect(registry.has('my-tool')).toBe(true);
    expect(registry.get('my-tool')).toBe(handler);
    expect(registry.has('other')).toBe(false);
    expect(registry.get('other')).toBeUndefined();
  });
});

describe('registerDefaultToolHandlers', () => {
  it('registers the emit-event handler that calls eventBus.emitCustom', async () => {
    const eventBus = makeEventBus();
    const registry = new DefaultOrchestratorToolRegistry();

    registerDefaultToolHandlers(registry, eventBus);

    expect(registry.has('emit-event')).toBe(true);

    const handler = registry.get('emit-event')!;
    const result = await handler(
      { event_type: 'my.custom.event', payload: { key: 'value' } },
      { sessionId: 'run-1', agentId: 'agent-1', requestId: 'req-1' },
    );

    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.eventType).toBe('my.custom.event');

    expect(eventBus.emitCustom).toHaveBeenCalledWith(
      'my.custom.event',
      'agent-1',
      expect.objectContaining({ key: 'value', runId: 'run-1', agentId: 'agent-1' }),
    );
  });

  it('defaults event_type to "custom" when not provided', async () => {
    const eventBus = makeEventBus();
    const registry = new DefaultOrchestratorToolRegistry();
    registerDefaultToolHandlers(registry, eventBus);

    const handler = registry.get('emit-event')!;
    await handler(
      {},
      { sessionId: 'run-1', agentId: 'agent-1', requestId: 'req-1' },
    );

    expect(eventBus.emitCustom).toHaveBeenCalledWith(
      'custom',
      'agent-1',
      expect.objectContaining({ runId: 'run-1', agentId: 'agent-1' }),
    );
  });
});

describe('createGrpcRoutes', () => {
  it('returns a function that can configure a ConnectRouter', () => {
    const eventBus = makeEventBus();
    const routesFn = createGrpcRoutes({ eventBus });

    expect(typeof routesFn).toBe('function');

    // Verify it can be called with a mock router without errors
    const mockRouter = {
      service: vi.fn(),
      rpc: vi.fn(),
    };

    // The routes function should call router.service with the OrchestratorService descriptor
    routesFn(mockRouter as any);

    expect(mockRouter.service).toHaveBeenCalledTimes(1);
    // First arg should be the OrchestratorService descriptor
    const [serviceDesc, impl] = mockRouter.service.mock.calls[0];
    expect(serviceDesc).toBeDefined();
    expect(impl).toBeDefined();
    expect(typeof impl.requestTool).toBe('function');
    expect(typeof impl.emitEvent).toBe('function');
    expect(typeof impl.refreshSecrets).toBe('function');
  });

  it('accepts a pre-built tool registry', () => {
    const eventBus = makeEventBus();
    const registry = makeRegistry({
      'custom-tool': async () => 'custom-result',
    });

    const routesFn = createGrpcRoutes({ eventBus, toolRegistry: registry });

    // Should also have default handlers registered
    expect(registry.has('emit-event')).toBe(true);
    // Should still have the custom one
    expect(registry.has('custom-tool')).toBe(true);

    const mockRouter = { service: vi.fn(), rpc: vi.fn() };
    routesFn(mockRouter as any);
    expect(mockRouter.service).toHaveBeenCalledTimes(1);
  });

  it('bridges toolExecutor tools into the gRPC registry', async () => {
    const eventBus = makeEventBus();
    const { LocalFunctionExecutor } = await import('../../../tool/executor.js');
    const { z } = await import('zod');

    const executor = new LocalFunctionExecutor();
    executor.register({
      name: 'my-local-tool',
      description: 'A local tool',
      input: z.object({ x: z.number() }),
      handler: async (input: unknown) => JSON.stringify({ result: (input as { x: number }).x * 2 }),
    });

    const registry = new DefaultOrchestratorToolRegistry();
    createGrpcRoutes({ eventBus, toolRegistry: registry, toolExecutor: executor });

    expect(registry.has('my-local-tool')).toBe(true);
    const handler = registry.get('my-local-tool')!;
    const result = await handler({ x: 21 }, { sessionId: 'run-1', agentId: 'agent-1', requestId: 'req-1' });
    expect(JSON.parse(result)).toEqual({ result: 42 });
  });

  it('bridges toolDefinitionRegistry tools into the gRPC registry', async () => {
    const eventBus = makeEventBus();
    const { DefaultToolRegistry } = await import('../../../tool/registry.js');
    const { z } = await import('zod');

    const defRegistry = new DefaultToolRegistry();
    defRegistry.addProvider({
      name: 'test-http',
      async listTools() {
        return [{
          name: 'http-health-check',
          description: 'HTTP health check tool',
          input: z.object({ url: z.string() }),
          location: 'orchestrator' as const,
          handler: async (input: unknown) => JSON.stringify({ status: 'ok', url: (input as { url: string }).url }),
        }];
      },
    });
    await defRegistry.refresh();

    const routes = createGrpcRoutes({ eventBus, toolDefinitionRegistry: defRegistry });
    expect(typeof routes).toBe('function');

    const registry = new DefaultOrchestratorToolRegistry(defRegistry, (ctx) => ({
      agentId: ctx.agentId,
      conversationId: '',
      instanceId: ctx.sessionId,
      requestId: ctx.requestId,
      workspaceDir: '/workspace',
      knowledge: { query: async () => ({ items: [] }) },
    }));

    expect(registry.has('http-health-check')).toBe(true);
    const handler = registry.get('http-health-check')!;
    const result = await handler({ url: 'http://example.com' }, { sessionId: 'run-1', agentId: 'agent-1', requestId: 'req-1' });
    expect(JSON.parse(result)).toEqual({ status: 'ok', url: 'http://example.com' });
  });

  it('does not overwrite existing gRPC handlers with bridged tools', async () => {
    const eventBus = makeEventBus();
    const { LocalFunctionExecutor } = await import('../../../tool/executor.js');
    const { z } = await import('zod');

    const executor = new LocalFunctionExecutor();
    executor.register({
      name: 'emit-event',
      description: 'should not overwrite',
      input: z.object({}),
      handler: async () => 'WRONG',
    });

    const registry = new DefaultOrchestratorToolRegistry();
    createGrpcRoutes({ eventBus, toolRegistry: registry, toolExecutor: executor });

    const handler = registry.get('emit-event')!;
    const result = await handler(
      { type: 'test' },
      { sessionId: 'run-1', agentId: 'agent-1', requestId: 'req-1' },
    );
    expect(result).not.toBe('WRONG');
  });

  it('bridged handler receives agentId and runId from gRPC context', async () => {
    const eventBus = makeEventBus();
    const { LocalFunctionExecutor } = await import('../../../tool/executor.js');
    const { z } = await import('zod');

    const receivedCtx = { agentId: '', instanceId: '' };
    const executor = new LocalFunctionExecutor();
    executor.register({
      name: 'ctx-checker',
      description: 'checks context',
      input: z.object({}),
      handler: async (_input: unknown, ctx) => {
        receivedCtx.agentId = ctx.agentId;
        receivedCtx.instanceId = ctx.instanceId ?? '';
        return 'ok';
      },
    });

    const registry = new DefaultOrchestratorToolRegistry();
    createGrpcRoutes({ eventBus, toolRegistry: registry, toolExecutor: executor });

    await registry.get('ctx-checker')!({}, { sessionId: 'run-42', agentId: 'agent-99', requestId: 'req-1' });
    expect(receivedCtx.agentId).toBe('agent-99');
    expect(receivedCtx.instanceId).toBe('run-42');
  });

  it('resolves HTTP tools added to DefaultToolRegistry AFTER gRPC routes are created', async () => {
    const { DefaultToolRegistry } = await import('../../../tool/registry.js');
    const { HTTPToolProvider } = await import('../../../tool/providers/http.js');
    const eventBus = makeEventBus();

    const defRegistry = new DefaultToolRegistry();

    createGrpcRoutes({ eventBus, toolDefinitionRegistry: defRegistry });

    const grpcRegistry = new DefaultOrchestratorToolRegistry(defRegistry, (ctx) => ({
      agentId: ctx.agentId,
      conversationId: '',
      instanceId: ctx.sessionId,
      requestId: ctx.requestId,
      workspaceDir: '/workspace',
      knowledge: { query: async () => ({ items: [] }) },
    }));

    expect(grpcRegistry.has('detect-column-mapping')).toBe(false);

    defRegistry.addProvider(new HTTPToolProvider([{
      name: 'detect-column-mapping',
      url: 'http://localhost:9999/noop',
      method: 'POST',
      description: 'Detect columns',
    }], { name: 'http-agent-04' }));
    await defRegistry.refresh();

    expect(grpcRegistry.has('detect-column-mapping')).toBe(true);
    const handler = grpcRegistry.get('detect-column-mapping');
    expect(typeof handler).toBe('function');
  });

  it('requestTool dispatches dynamically-registered HTTP tools via delegate', async () => {
    const { DefaultToolRegistry } = await import('../../../tool/registry.js');
    const { z } = await import('zod');
    const eventBus = makeEventBus();

    const defRegistry = new DefaultToolRegistry();
    defRegistry.addProvider({
      name: 'http-test',
      async listTools() {
        return [{
          name: 'detect-column-mapping',
          description: 'Detect columns',
          input: z.object({}),
          location: 'orchestrator' as const,
          handler: async () => JSON.stringify({ columns: ['date', 'amount'] }),
        }];
      },
      async execute() { return ''; },
    });
    await defRegistry.refresh();

    const grpcRegistry = new DefaultOrchestratorToolRegistry(defRegistry, (ctx) => ({
      agentId: ctx.agentId,
      conversationId: '',
      instanceId: ctx.sessionId,
      requestId: ctx.requestId,
      workspaceDir: '/workspace',
      knowledge: { query: async () => ({ items: [] }) },
    }));
    registerDefaultToolHandlers(grpcRegistry, eventBus);

    const impl = createOrchestratorServiceImpl({ eventBus, toolRegistry: grpcRegistry });
    const resp = await impl.requestTool(create(RequestToolRequestSchema, {
      sessionId: 'run-1',
      agentId: 'agent-04',
      toolName: 'detect-column-mapping',
      argsJson: '{}',
      requestId: 'req-1',
    }));

    expect(resp.error).toBeFalsy();
    expect(JSON.parse(resp.result)).toEqual({ columns: ['date', 'amount'] });
  });
});
