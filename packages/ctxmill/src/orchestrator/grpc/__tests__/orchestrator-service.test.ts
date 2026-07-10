import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';
import type { ConnectRouter } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import {
  RequestToolRequestSchema,
  EmitEventRequestSchema,
  ResolveArtifactRequestSchema,
} from '@ctxmill/proto/sandbox/v1';
import type { ArtifactRow } from '../../../database/types.js';
import {
  createOrchestratorServiceImpl,
  DefaultOrchestratorToolRegistry,
  registerDefaultToolHandlers,
  type OrchestratorToolHandler,
} from '../orchestrator-service.js';
import { createGrpcRoutes } from '../router.js';
import { TypedEventBus } from '../../../events/bus.js';
import type { DatabaseRepository } from '../../../database/repository.js';

function makeEventBus() {
  const bus = new TypedEventBus();
  vi.spyOn(bus, 'emitCustom');
  vi.spyOn(bus, 'emitCustomAsync');
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

type ToolDedupRepository = Pick<
  DatabaseRepository,
  'tryInsertToolDedup' | 'getToolDedup' | 'completeToolDedup'
>;

function makeDedupRepository(overrides: Partial<ToolDedupRepository> = {}): DatabaseRepository {
  const repository: ToolDedupRepository = {
    tryInsertToolDedup: vi.fn().mockResolvedValue(true),
    getToolDedup: vi.fn().mockResolvedValue(undefined),
    completeToolDedup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  return repository as unknown as DatabaseRepository;
}

async function expectFinalizationFailure(promise: Promise<unknown>, phase: string): Promise<ConnectError> {
  const err = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );

  expect(err).toBeInstanceOf(ConnectError);
  if (!(err instanceof ConnectError)) {
    throw new Error('Expected finalization failure to be a ConnectError');
  }
  expect(err.code).toBe(Code.Unavailable);
  expect(err.message).toContain(phase);
  return err;
}

async function withSilencedConsoleError<T>(fn: () => Promise<T>): Promise<T> {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    return await fn();
  } finally {
    consoleError.mockRestore();
  }
}

type MockConnectRouter = ConnectRouter & {
  service: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
};

function makeMockConnectRouter(): MockConnectRouter {
  return {
    service: vi.fn(),
    rpc: vi.fn(),
  } as unknown as MockConnectRouter;
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

  it('surfaces dedup finalization failures after handler success as retriable RPC failures', async () => {
    const handler = vi.fn().mockResolvedValue('{"ok": true}');
    const repository = makeDedupRepository({
      completeToolDedup: vi.fn().mockRejectedValue(new Error('dedup write failed')),
    });
    const registry = makeRegistry({ 'my-tool': handler });
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry, repository });

    const req = create(RequestToolRequestSchema, {
      sessionId: 'run-1',
      agentId: 'agent-1',
      toolName: 'my-tool',
      argsJson: '{"x": 1}',
      requestId: 'req-finalize-success',
    });

    const err = await withSilencedConsoleError(() => expectFinalizationFailure(
      svc.requestTool(req),
      'successful execution',
    ));

    expect(err.message).toContain('req-finalize-success');
    expect(err.message).toContain('dedup write failed');
    expect(handler).toHaveBeenCalledWith(
      { x: 1 },
      { sessionId: 'run-1', agentId: 'agent-1', requestId: 'req-finalize-success' },
    );
    expect(repository.completeToolDedup).toHaveBeenCalledWith(
      'req-finalize-success',
      '{"ok": true}',
      null,
    );
  });

  it('surfaces dedup finalization failures after handler errors instead of returning cached-looking errors', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('tool exploded'));
    const repository = makeDedupRepository({
      completeToolDedup: vi.fn().mockRejectedValue(new Error('dedup write failed')),
    });
    const registry = makeRegistry({ boom: handler });
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry, repository });

    const req = create(RequestToolRequestSchema, {
      sessionId: 'run-1',
      agentId: 'agent-1',
      toolName: 'boom',
      argsJson: '{}',
      requestId: 'req-finalize-error',
    });

    const err = await withSilencedConsoleError(() => expectFinalizationFailure(
      svc.requestTool(req),
      'failed execution',
    ));

    expect(err.message).toContain('req-finalize-error');
    expect(err.message).toContain('dedup write failed');
    expect(handler).toHaveBeenCalledOnce();
    expect(repository.completeToolDedup).toHaveBeenCalledWith(
      'req-finalize-error',
      null,
      'tool exploded',
    );
  });

  it('surfaces dedup finalization failures for unknown tools instead of returning a normal tool error', async () => {
    const repository = makeDedupRepository({
      completeToolDedup: vi.fn().mockRejectedValue(new Error('dedup write failed')),
    });
    const registry = makeRegistry();
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry, repository });

    const req = create(RequestToolRequestSchema, {
      sessionId: 'run-1',
      agentId: 'agent-1',
      toolName: 'missing-tool',
      argsJson: '{}',
      requestId: 'req-finalize-unknown',
    });

    const err = await withSilencedConsoleError(() => expectFinalizationFailure(
      svc.requestTool(req),
      'unknown tool',
    ));

    expect(err.message).toContain('req-finalize-unknown');
    expect(repository.completeToolDedup).toHaveBeenCalledWith(
      'req-finalize-unknown',
      null,
      'Unknown orchestrator tool: missing-tool',
    );
  });

  it('surfaces dedup finalization failures for malformed args_json instead of returning a normal parse error', async () => {
    const handler = vi.fn();
    const repository = makeDedupRepository({
      completeToolDedup: vi.fn().mockRejectedValue(new Error('dedup write failed')),
    });
    const registry = makeRegistry({ 'my-tool': handler });
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry, repository });

    const req = create(RequestToolRequestSchema, {
      sessionId: 'run-1',
      agentId: 'agent-1',
      toolName: 'my-tool',
      argsJson: 'not-json',
      requestId: 'req-finalize-json',
    });

    const err = await withSilencedConsoleError(() => expectFinalizationFailure(
      svc.requestTool(req),
      'invalid args_json',
    ));

    expect(err.message).toContain('req-finalize-json');
    expect(handler).not.toHaveBeenCalled();
    expect(repository.completeToolDedup).toHaveBeenCalledWith(
      'req-finalize-json',
      null,
      'Invalid args_json: failed to parse JSON',
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
    expect(eventBus.emitCustomAsync).toHaveBeenCalledWith(
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

    expect(eventBus.emitCustomAsync).toHaveBeenCalledWith(
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

    expect(eventBus.emitCustomAsync).toHaveBeenCalledWith(
      'simple.event',
      '',
      expect.objectContaining({ runId: 'run-1' }),
    );
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
  it('registers the emit-event handler that awaits eventBus.emitCustomAsync', async () => {
    const eventBus = makeEventBus();
    const registry = new DefaultOrchestratorToolRegistry();

    registerDefaultToolHandlers(registry, eventBus);

    expect(registry.has('emit-event')).toBe(true);

    const handler = registry.get('emit-event')!;
    const result = await handler(
      { type: 'my.custom.event', payload: { key: 'value' } },
      { sessionId: 'run-1', agentId: 'agent-1', requestId: 'req-1' },
    );

    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.eventType).toBe('my.custom.event');

    expect(eventBus.emitCustomAsync).toHaveBeenCalledWith(
      'my.custom.event',
      'agent-1',
      expect.objectContaining({ key: 'value', runId: 'run-1', agentId: 'agent-1' }),
    );
  });

  it('returns an error string when type is not provided', async () => {
    const eventBus = makeEventBus();
    const registry = new DefaultOrchestratorToolRegistry();
    registerDefaultToolHandlers(registry, eventBus);

    const handler = registry.get('emit-event')!;
    const result = await handler(
      {},
      { sessionId: 'run-1', agentId: 'agent-1', requestId: 'req-1' },
    );

    expect(result).toBe('Error: emit-event requires a non-empty string "type"');
    expect(eventBus.emitCustomAsync).not.toHaveBeenCalled();
  });

  it('returns an error string when type is empty', async () => {
    const eventBus = makeEventBus();
    const registry = new DefaultOrchestratorToolRegistry();
    registerDefaultToolHandlers(registry, eventBus);

    const handler = registry.get('emit-event')!;
    const result = await handler(
      { type: '   ', payload: { key: 'value' } },
      { sessionId: 'run-1', agentId: 'agent-1', requestId: 'req-1' },
    );

    expect(result).toBe('Error: emit-event requires a non-empty string "type"');
    expect(eventBus.emitCustomAsync).not.toHaveBeenCalled();
  });
});

describe('createGrpcRoutes', () => {
  it('returns a function that can configure a ConnectRouter', () => {
    const eventBus = makeEventBus();
    const routesFn = createGrpcRoutes({ eventBus });

    expect(typeof routesFn).toBe('function');

    // Verify it can be called with a mock router without errors
    const mockRouter = makeMockConnectRouter();

    // The routes function should call router.service with the OrchestratorService descriptor
    routesFn(mockRouter);

    expect(mockRouter.service).toHaveBeenCalledTimes(1);
    // First arg should be the OrchestratorService descriptor
    const [serviceDesc, impl] = mockRouter.service.mock.calls[0];
    expect(serviceDesc).toBeDefined();
    expect(impl).toBeDefined();
    expect(typeof impl.requestTool).toBe('function');
    expect(typeof impl.emitEvent).toBe('function');
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

    const mockRouter = makeMockConnectRouter();
    routesFn(mockRouter);
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

  it('requestTool resolves duplicate HTTP tool names using the requesting agentId', async () => {
    const { DefaultToolRegistry } = await import('../../../tool/registry.js');
    const { z } = await import('zod');
    const eventBus = makeEventBus();

    const defRegistry = new DefaultToolRegistry();
    defRegistry.addProvider({
      name: 'http-agent-a',
      async listTools() {
        return [{
          name: 'shared-http-tool',
          description: 'Agent A tool',
          input: z.object({}),
          location: 'orchestrator' as const,
          handler: async () => JSON.stringify({ owner: 'agent-a' }),
        }];
      },
      async execute() { return ''; },
    });
    defRegistry.addProvider({
      name: 'http-agent-b',
      async listTools() {
        return [{
          name: 'shared-http-tool',
          description: 'Agent B tool',
          input: z.object({}),
          location: 'orchestrator' as const,
          handler: async () => JSON.stringify({ owner: 'agent-b' }),
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
    }));
    registerDefaultToolHandlers(grpcRegistry, eventBus);
    const impl = createOrchestratorServiceImpl({ eventBus, toolRegistry: grpcRegistry });

    const agentAResp = await impl.requestTool(create(RequestToolRequestSchema, {
      sessionId: 'run-a',
      agentId: 'agent-a',
      toolName: 'shared-http-tool',
      argsJson: '{}',
      requestId: 'req-a',
    }));
    const agentBResp = await impl.requestTool(create(RequestToolRequestSchema, {
      sessionId: 'run-b',
      agentId: 'agent-b',
      toolName: 'shared-http-tool',
      argsJson: '{}',
      requestId: 'req-b',
    }));

    expect(JSON.parse(agentAResp.result)).toEqual({ owner: 'agent-a' });
    expect(JSON.parse(agentBResp.result)).toEqual({ owner: 'agent-b' });
  });
});

describe('OrchestratorService — ResolveArtifact ownership', () => {
  function makeArtifactRow(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
    return {
      id: 'artifact-1',
      agentId: 'agent-a',
      sessionId: 'turn-1',
      conversationId: null,
      name: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      storageKey: 'agents/agent-a/report.pdf',
      bucket: 'artifacts',
      metadata: null,
      createdAt: 1_700_000_000_000,
      ...overrides,
    } as ArtifactRow;
  }

  function makeArtifactRepository(row: ArtifactRow | undefined): {
    repository: DatabaseRepository;
    getArtifact: ReturnType<typeof vi.fn>;
  } {
    const getArtifact = vi.fn().mockResolvedValue(row);
    return {
      repository: { getArtifact } as unknown as DatabaseRepository,
      getArtifact,
    };
  }

  it('resolves an artifact owned by the authenticated agent', async () => {
    const eventBus = makeEventBus();
    const { repository } = makeArtifactRepository(makeArtifactRow({ agentId: 'agent-a' }));
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: makeRegistry(), repository });

    const resp = await svc.resolveArtifact(create(ResolveArtifactRequestSchema, {
      artifactId: 'artifact-1',
      agentId: 'agent-a',
    }));

    expect(resp.error).toBeFalsy();
    expect(resp.artifact?.id).toBe('artifact-1');
    expect(resp.artifact?.storageKey).toBe('agents/agent-a/report.pdf');
  });

  it('denies cross-agent artifact resolution as not-found (IDOR guard)', async () => {
    const eventBus = makeEventBus();
    const { repository } = makeArtifactRepository(makeArtifactRow({ agentId: 'agent-a' }));
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: makeRegistry(), repository });

    const resp = await svc.resolveArtifact(create(ResolveArtifactRequestSchema, {
      artifactId: 'artifact-1',
      agentId: 'agent-b',
    }));

    expect(resp.artifact).toBeUndefined();
    expect(resp.error).toBe('Artifact not found: artifact-1');
  });

  it('resolves unowned (null-agent) artifacts for any authenticated agent', async () => {
    const eventBus = makeEventBus();
    const { repository } = makeArtifactRepository(makeArtifactRow({ agentId: null }));
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: makeRegistry(), repository });

    const resp = await svc.resolveArtifact(create(ResolveArtifactRequestSchema, {
      artifactId: 'artifact-1',
      agentId: 'agent-b',
    }));

    expect(resp.error).toBeFalsy();
    expect(resp.artifact?.id).toBe('artifact-1');
  });

  it('resolves without an ownership constraint in open/dev mode (empty caller agent)', async () => {
    const eventBus = makeEventBus();
    const { repository } = makeArtifactRepository(makeArtifactRow({ agentId: 'agent-a' }));
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: makeRegistry(), repository });

    const resp = await svc.resolveArtifact(create(ResolveArtifactRequestSchema, {
      artifactId: 'artifact-1',
      agentId: '',
    }));

    expect(resp.error).toBeFalsy();
    expect(resp.artifact?.id).toBe('artifact-1');
  });

  it('reports a genuinely missing artifact as not-found', async () => {
    const eventBus = makeEventBus();
    const { repository } = makeArtifactRepository(undefined);
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: makeRegistry(), repository });

    const resp = await svc.resolveArtifact(create(ResolveArtifactRequestSchema, {
      artifactId: 'ghost',
      agentId: 'agent-a',
    }));

    expect(resp.artifact).toBeUndefined();
    expect(resp.error).toBe('Artifact not found: ghost');
  });
});
