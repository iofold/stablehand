import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';
import type { ConnectRouter } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import {
  RequestToolRequestSchema,
  EmitEventRequestSchema,
  RegisterArtifactRequestSchema,
  ArtifactMetaSchema,
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
import {
  CALLBACK_AGENT_HEADER,
  CALLBACK_SESSION_HEADER,
  CALLBACK_TOKEN_HEADER,
  mintGrpcCallbackToken,
  validateGrpcCallbackAuth,
} from '../callback-auth.js';
import {
  mintTurnDeliveryCapability,
  type TurnDeliveryCapabilityClaims,
} from '../turn-delivery-capability.js';

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
  | 'tryAdmitToolRequest'
  | 'getToolDedup'
  | 'completeToolDedup'
  | 'getTurn'
  | 'getTurnDeliveryCapabilityClaims'
  | 'saveArtifactIfDeliveryOwned'
>;

const LIVE_DELIVERY_CLAIMS = {
  agentId: 'agent-1',
  ownerId: 'delivery-owner-1',
  fenceToken: 7,
  leaseExpiresAtMs: Date.now() + 60_000,
  restoreFenceToken: 3,
  containerId: 'container-1',
};

function withLiveDeliveryCapability<
  T extends {
    turnId: string;
    sandboxSessionId: string;
    agentId: string;
    deliveryCapability?: unknown;
  },
>(
  request: T,
  overrides: Partial<TurnDeliveryCapabilityClaims> = {},
  secret?: string,
): T {
  const claims: TurnDeliveryCapabilityClaims = {
    turnId: request.turnId,
    sandboxSessionId: request.sandboxSessionId,
    agentId: request.agentId,
    ownerId: LIVE_DELIVERY_CLAIMS.ownerId,
    fenceToken: LIVE_DELIVERY_CLAIMS.fenceToken,
    leaseExpiresAtMs: LIVE_DELIVERY_CLAIMS.leaseExpiresAtMs,
    restoreFenceToken: LIVE_DELIVERY_CLAIMS.restoreFenceToken,
    containerId: LIVE_DELIVERY_CLAIMS.containerId,
    ...overrides,
  };
  request.deliveryCapability = mintTurnDeliveryCapability(
    claims,
    secret ? { mode: 'enforce', secret } : { mode: 'open' },
  );
  return request;
}

function makeDedupRepository(overrides: Partial<ToolDedupRepository> = {}): DatabaseRepository {
  const repository: ToolDedupRepository = {
    tryAdmitToolRequest: vi.fn().mockResolvedValue('inserted'),
    getToolDedup: vi.fn().mockResolvedValue(undefined),
    completeToolDedup: vi.fn().mockResolvedValue(true),
    getTurn: vi.fn().mockResolvedValue(undefined),
    getTurnDeliveryCapabilityClaims: vi.fn().mockResolvedValue({
      ...LIVE_DELIVERY_CLAIMS,
      conversationId: 'conversation-1',
    }),
    saveArtifactIfDeliveryOwned: vi.fn().mockResolvedValue({
      id: 'artifact-1',
    }),
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

async function expectConnectError(
  promise: Promise<unknown>,
  code: Code,
): Promise<ConnectError> {
  const err = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );

  expect(err).toBeInstanceOf(ConnectError);
  if (!(err instanceof ConnectError)) {
    throw new Error('Expected a ConnectError');
  }
  expect(err.code).toBe(code);
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

  it('requires a signed delivery capability before consulting repository state', async () => {
    const handler = vi.fn().mockResolvedValue('must-not-run');
    const repository = makeDedupRepository();
    const svc = createOrchestratorServiceImpl({
      eventBus,
      toolRegistry: makeRegistry({ 'my-tool': handler }),
      repository,
    });

    await expectConnectError(svc.requestTool(create(RequestToolRequestSchema, {
      turnId: 'run-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      toolName: 'my-tool',
      argsJson: '{}',
      requestId: 'req-without-capability',
    })), Code.PermissionDenied);

    expect(repository.getTurnDeliveryCapabilityClaims).not.toHaveBeenCalled();
    expect(repository.tryAdmitToolRequest).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a tampered capability before consulting repository state', async () => {
    const secret = 'delivery-capability-secret';
    const handler = vi.fn().mockResolvedValue('must-not-run');
    const repository = makeDedupRepository();
    const svc = createOrchestratorServiceImpl({
      eventBus,
      toolRegistry: makeRegistry({ 'my-tool': handler }),
      repository,
      callbackAuthConfig: { mode: 'enforce', secret },
    });
    const request = withLiveDeliveryCapability(create(
      RequestToolRequestSchema,
      {
        turnId: 'run-1',
        sandboxSessionId: 'sandbox-1',
        agentId: 'agent-1',
        toolName: 'my-tool',
        argsJson: '{}',
        requestId: 'req-tampered-capability',
      },
    ), {}, secret);
    request.deliveryCapability!.ownerId = 'tampered-owner';

    await expectConnectError(
      svc.requestTool(request),
      Code.PermissionDenied,
    );
    expect(repository.getTurnDeliveryCapabilityClaims).not.toHaveBeenCalled();
    expect(repository.tryAdmitToolRequest).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects an expired signed capability before repository admission', async () => {
    const handler = vi.fn().mockResolvedValue('must-not-run');
    const repository = makeDedupRepository();
    const svc = createOrchestratorServiceImpl({
      eventBus,
      toolRegistry: makeRegistry({ 'my-tool': handler }),
      repository,
    });
    const request = withLiveDeliveryCapability(create(
      RequestToolRequestSchema,
      {
        turnId: 'run-1',
        sandboxSessionId: 'sandbox-1',
        agentId: 'agent-1',
        toolName: 'my-tool',
        argsJson: '{}',
        requestId: 'req-expired-capability',
      },
    ), { leaseExpiresAtMs: Date.now() - 1 });

    await expectConnectError(
      svc.requestTool(request),
      Code.FailedPrecondition,
    );
    expect(repository.getTurnDeliveryCapabilityClaims).not.toHaveBeenCalled();
    expect(repository.tryAdmitToolRequest).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects an expired callback before dedup admission or tool execution', async () => {
    const handler = vi.fn().mockResolvedValue('must-not-run');
    const registry = makeRegistry({ 'my-tool': handler });
    const repository = makeDedupRepository({
      getTurnDeliveryCapabilityClaims: vi.fn().mockResolvedValue(undefined),
    });
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry, repository });

    const err = await expectConnectError(svc.requestTool(withLiveDeliveryCapability(
      create(RequestToolRequestSchema, {
      turnId: 'run-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      toolName: 'my-tool',
      argsJson: '{}',
      requestId: 'req-stale',
      }),
    )), Code.FailedPrecondition);

    expect(err.message).toContain('live turn delivery');
    expect(repository.getTurnDeliveryCapabilityClaims).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 'run-1',
        sandboxSessionId: 'sandbox-1',
        agentId: 'agent-1',
      }),
    );
    expect(repository.tryAdmitToolRequest).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes the admitted delivery fence into a live tool callback', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    const registry = makeRegistry({ 'my-tool': handler });
    const repository = makeDedupRepository();
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry, repository });

    await svc.requestTool(withLiveDeliveryCapability(create(RequestToolRequestSchema, {
      turnId: 'run-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      toolName: 'my-tool',
      argsJson: '{}',
      requestId: 'req-live',
    })));

    expect(handler).toHaveBeenCalledWith({}, expect.objectContaining({
      turnId: 'run-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      requestId: 'req-live',
      deliveryFence: {
        ownerId: 'delivery-owner-1',
        fenceToken: 7,
      },
    }));
  });

  it('rejects a tool callback whose delivery expires during atomic admission', async () => {
    const handler = vi.fn().mockResolvedValue('must-not-run');
    const registry = makeRegistry({ 'my-tool': handler });
    const repository = makeDedupRepository({
      tryAdmitToolRequest: vi.fn().mockResolvedValue('stale'),
    });
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry, repository });

    await expectConnectError(svc.requestTool(withLiveDeliveryCapability(
      create(RequestToolRequestSchema, {
      turnId: 'run-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      toolName: 'my-tool',
      argsJson: '{}',
      requestId: 'req-raced',
      }),
    )), Code.FailedPrecondition);

    expect(repository.tryAdmitToolRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-raced',
        turnId: 'run-1',
        sandboxSessionId: 'sandbox-1',
        agentId: 'agent-1',
      }),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('dispatches to a registered tool handler and returns the result', async () => {
    const handler = vi.fn().mockResolvedValue('{"answer": 42}');
    const registry = makeRegistry({ 'my-tool': handler });
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const req = create(RequestToolRequestSchema, {
      turnId: 'run-1',
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
      { turnId: 'run-1', agentId: 'agent-1', requestId: 'req-1' },
    );
  });

  it('returns error when tool is not found', async () => {
    const registry = makeRegistry();
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const req = create(RequestToolRequestSchema, {
      turnId: 'run-1',
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
      turnId: 'run-1',
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
      turnId: 'run-1',
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
      turnId: 'run-1',
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
      turnId: 'run-1',
      agentId: 'agent-1',
      toolName: 'no-args',
      argsJson: '',
      requestId: 'req-6',
    });

    const resp = await svc.requestTool(req);

    expect(resp.result).toBe('ok');
    expect(handler).toHaveBeenCalledWith(
      {},
      { turnId: 'run-1', agentId: 'agent-1', requestId: 'req-6' },
    );
  });

  it('surfaces dedup finalization failures after handler success as retriable RPC failures', async () => {
    const handler = vi.fn().mockResolvedValue('{"ok": true}');
    const repository = makeDedupRepository({
      completeToolDedup: vi.fn().mockRejectedValue(new Error('dedup write failed')),
    });
    const registry = makeRegistry({ 'my-tool': handler });
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry, repository });

    const req = withLiveDeliveryCapability(create(RequestToolRequestSchema, {
      turnId: 'run-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      toolName: 'my-tool',
      argsJson: '{"x": 1}',
      requestId: 'req-finalize-success',
    }));

    const err = await withSilencedConsoleError(() => expectFinalizationFailure(
      svc.requestTool(req),
      'successful execution',
    ));

    expect(err.message).toContain('req-finalize-success');
    expect(err.message).toContain('dedup write failed');
    expect(handler).toHaveBeenCalledWith(
      { x: 1 },
      expect.objectContaining({
        turnId: 'run-1',
        agentId: 'agent-1',
        requestId: 'req-finalize-success',
      }),
    );
    expect(repository.completeToolDedup).toHaveBeenCalledWith(
      'req-finalize-success',
      '{"ok": true}',
      null,
      expect.objectContaining({
        turnId: 'run-1',
        sandboxSessionId: 'sandbox-1',
      }),
    );
  });

  it('surfaces dedup finalization failures after handler errors instead of returning cached-looking errors', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('tool exploded'));
    const repository = makeDedupRepository({
      completeToolDedup: vi.fn().mockRejectedValue(new Error('dedup write failed')),
    });
    const registry = makeRegistry({ boom: handler });
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry, repository });

    const req = withLiveDeliveryCapability(create(RequestToolRequestSchema, {
      turnId: 'run-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      toolName: 'boom',
      argsJson: '{}',
      requestId: 'req-finalize-error',
    }));

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
      expect.objectContaining({
        turnId: 'run-1',
        sandboxSessionId: 'sandbox-1',
      }),
    );
  });

  it('surfaces dedup finalization failures for unknown tools instead of returning a normal tool error', async () => {
    const repository = makeDedupRepository({
      completeToolDedup: vi.fn().mockRejectedValue(new Error('dedup write failed')),
    });
    const registry = makeRegistry();
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry, repository });

    const req = withLiveDeliveryCapability(create(RequestToolRequestSchema, {
      turnId: 'run-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      toolName: 'missing-tool',
      argsJson: '{}',
      requestId: 'req-finalize-unknown',
    }));

    const err = await withSilencedConsoleError(() => expectFinalizationFailure(
      svc.requestTool(req),
      'unknown tool',
    ));

    expect(err.message).toContain('req-finalize-unknown');
    expect(repository.completeToolDedup).toHaveBeenCalledWith(
      'req-finalize-unknown',
      null,
      'Unknown orchestrator tool: missing-tool',
      expect.objectContaining({
        turnId: 'run-1',
        sandboxSessionId: 'sandbox-1',
      }),
    );
  });

  it('surfaces dedup finalization failures for malformed args_json instead of returning a normal parse error', async () => {
    const handler = vi.fn();
    const repository = makeDedupRepository({
      completeToolDedup: vi.fn().mockRejectedValue(new Error('dedup write failed')),
    });
    const registry = makeRegistry({ 'my-tool': handler });
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry, repository });

    const req = withLiveDeliveryCapability(create(RequestToolRequestSchema, {
      turnId: 'run-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      toolName: 'my-tool',
      argsJson: 'not-json',
      requestId: 'req-finalize-json',
    }));

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
      expect.objectContaining({
        turnId: 'run-1',
        sandboxSessionId: 'sandbox-1',
      }),
    );
  });
});

describe('OrchestratorService — EmitEvent', () => {
  let eventBus: TypedEventBus;

  beforeEach(() => {
    eventBus = makeEventBus();
  });

  it('rejects an expired callback without persisting or dispatching its event', async () => {
    const listener = vi.fn();
    eventBus.on('stale.callback', listener);
    const repository = makeDedupRepository({
      getTurnDeliveryCapabilityClaims: vi.fn().mockResolvedValue(undefined),
    });
    const svc = createOrchestratorServiceImpl({
      eventBus,
      toolRegistry: makeRegistry(),
      repository,
    });

    await expectConnectError(svc.emitEvent(withLiveDeliveryCapability(
      create(EmitEventRequestSchema, {
      turnId: 'run-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      eventType: 'stale.callback',
      payloadJson: '{}',
      }),
    )), Code.FailedPrecondition);

    expect(eventBus.emitCustomAsync).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('persists a live callback event with its admitted delivery fence', async () => {
    const repository = makeDedupRepository();
    const svc = createOrchestratorServiceImpl({
      eventBus,
      toolRegistry: makeRegistry(),
      repository,
    });

    await svc.emitEvent(withLiveDeliveryCapability(create(EmitEventRequestSchema, {
      turnId: 'run-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      eventType: 'live.callback',
      payloadJson: '{"step":1}',
    })));

    expect(eventBus.emitCustomAsync).toHaveBeenCalledWith(
      'live.callback',
      'agent-1',
      expect.objectContaining({
        turnId: 'run-1',
        agentId: 'agent-1',
        step: 1,
      }),
      {
        deliveryFence: {
          ownerId: 'delivery-owner-1',
          fenceToken: 7,
        },
        sandboxSessionId: 'sandbox-1',
        activeGeneration: {
          restoreFenceToken: 3,
          containerId: 'container-1',
        },
      },
    );
  });

  it('reports ownership lost while a callback event was waiting to persist', async () => {
    const repository = makeDedupRepository();
    const svc = createOrchestratorServiceImpl({
      eventBus,
      toolRegistry: makeRegistry(),
      repository,
    });
    vi.mocked(eventBus.emitCustomAsync).mockResolvedValueOnce(false);

    const err = await expectConnectError(svc.emitEvent(withLiveDeliveryCapability(
      create(EmitEventRequestSchema, {
      turnId: 'run-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      eventType: 'lost.callback',
      payloadJson: '{}',
      }),
    )), Code.FailedPrecondition);

    expect(err.message).toContain('delivery ownership changed');
  });

  it('emits a custom event on the EventBus', async () => {
    const registry = makeRegistry();
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const req = create(EmitEventRequestSchema, {
      turnId: 'turn-1',
      agentId: 'agent-1',
      eventType: 'agent.progress',
      payloadJson: '{"step": 3, "agentId": "agent-1"}',
    });

    const resp = await svc.emitEvent(req);

    expect(resp).toBeDefined();
    expect(eventBus.emitCustomAsync).toHaveBeenCalledWith(
      'agent.progress',
      'agent-1',
      expect.objectContaining({ step: 3, agentId: 'agent-1', turnId: 'turn-1' }),
    );
  });

  it('injects turnId into the payload', async () => {
    const registry = makeRegistry();
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const req = create(EmitEventRequestSchema, {
      turnId: 'turn-42',
      eventType: 'test.event',
      payloadJson: '{"data": "hello"}',
    });

    await svc.emitEvent(req);

    expect(eventBus.emitCustomAsync).toHaveBeenCalledWith(
      'test.event',
      '',
      expect.objectContaining({ data: 'hello', turnId: 'turn-42' }),
    );
  });

  it('throws ConnectError when event_type is empty', async () => {
    const registry = makeRegistry();
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const req = create(EmitEventRequestSchema, {
      turnId: 'turn-1',
      eventType: '',
      payloadJson: '{}',
    });

    await expect(svc.emitEvent(req)).rejects.toThrow('event_type is required');
  });

  it('throws ConnectError when payload_json is malformed', async () => {
    const registry = makeRegistry();
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const req = create(EmitEventRequestSchema, {
      turnId: 'turn-1',
      eventType: 'test.event',
      payloadJson: '{bad',
    });

    await expect(svc.emitEvent(req)).rejects.toThrow('Invalid payload_json');
  });

  it('handles empty payload_json gracefully', async () => {
    const registry = makeRegistry();
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const req = create(EmitEventRequestSchema, {
      turnId: 'turn-1',
      eventType: 'simple.event',
      payloadJson: '',
    });

    await svc.emitEvent(req);

    expect(eventBus.emitCustomAsync).toHaveBeenCalledWith(
      'simple.event',
      '',
      expect.objectContaining({ turnId: 'turn-1' }),
    );
  });
});

describe('OrchestratorService — RegisterArtifact', () => {
  it('persists live artifact metadata through the exact delivery fence', async () => {
    const repository = makeDedupRepository({
      saveArtifactIfDeliveryOwned: vi.fn().mockResolvedValue({
        id: 'artifact-live',
      }),
    });
    const svc = createOrchestratorServiceImpl({
      eventBus: makeEventBus(),
      toolRegistry: makeRegistry(),
      repository,
    });

    const response = await svc.registerArtifact(withLiveDeliveryCapability(
      create(RegisterArtifactRequestSchema, {
      turnId: 'run-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      artifact: create(ArtifactMetaSchema, {
        id: 'artifact-live',
        turnId: 'run-1',
        agentId: 'agent-1',
        name: 'live.txt',
      }),
      }),
    ));

    expect(response.artifactId).toBe('artifact-live');
    expect(repository.saveArtifactIfDeliveryOwned).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'artifact-live',
        turnId: 'run-1',
        agentId: 'agent-1',
        name: 'live.txt',
      }),
      {
        turnId: 'run-1',
        sandboxSessionId: 'sandbox-1',
        agentId: 'agent-1',
        expectedDeliveryFence: {
          ownerId: 'delivery-owner-1',
          fenceToken: 7,
        },
        expectedActiveGeneration: {
          restoreFenceToken: 3,
          containerId: 'container-1',
        },
      },
    );
  });

  it('rejects an expired callback without saving artifact metadata', async () => {
    const repository = makeDedupRepository({
      getTurnDeliveryCapabilityClaims: vi.fn().mockResolvedValue(undefined),
    });
    const svc = createOrchestratorServiceImpl({
      eventBus: makeEventBus(),
      toolRegistry: makeRegistry(),
      repository,
    });

    await expectConnectError(svc.registerArtifact(withLiveDeliveryCapability(
      create(RegisterArtifactRequestSchema, {
      turnId: 'run-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      artifact: create(ArtifactMetaSchema, {
        id: 'artifact-stale',
        turnId: 'run-1',
        agentId: 'agent-1',
        name: 'stale.txt',
      }),
      }),
    )), Code.FailedPrecondition);

    expect(repository.saveArtifactIfDeliveryOwned).not.toHaveBeenCalled();
  });

  it('rejects request and artifact identity mismatches before any save', async () => {
    const repository = makeDedupRepository();
    const svc = createOrchestratorServiceImpl({
      eventBus: makeEventBus(),
      toolRegistry: makeRegistry(),
      repository,
    });

    const err = await expectConnectError(svc.registerArtifact(create(RegisterArtifactRequestSchema, {
      turnId: 'run-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      artifact: create(ArtifactMetaSchema, {
        id: 'artifact-mismatch',
        turnId: 'other-turn',
        agentId: 'agent-1',
        name: 'mismatch.txt',
      }),
    })), Code.InvalidArgument);

    expect(err.message).toContain('artifact turn');
    expect(repository.getTurnDeliveryCapabilityClaims).not.toHaveBeenCalled();
    expect(repository.saveArtifactIfDeliveryOwned).not.toHaveBeenCalled();
  });

  it('rejects an artifact callback whose delivery expires during its fenced save', async () => {
    const repository = makeDedupRepository({
      saveArtifactIfDeliveryOwned: vi.fn().mockResolvedValue(undefined),
    });
    const svc = createOrchestratorServiceImpl({
      eventBus: makeEventBus(),
      toolRegistry: makeRegistry(),
      repository,
    });

    await expectConnectError(svc.registerArtifact(withLiveDeliveryCapability(
      create(RegisterArtifactRequestSchema, {
      turnId: 'run-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      artifact: create(ArtifactMetaSchema, {
        id: 'artifact-raced',
        turnId: 'run-1',
        agentId: 'agent-1',
        name: 'raced.txt',
      }),
      }),
    )), Code.FailedPrecondition);

    expect(repository.saveArtifactIfDeliveryOwned).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'artifact-raced',
        turnId: 'run-1',
        agentId: 'agent-1',
      }),
      expect.objectContaining({
        turnId: 'run-1',
        sandboxSessionId: 'sandbox-1',
        agentId: 'agent-1',
      }),
    );
    expect(repository.saveArtifactIfDeliveryOwned).toHaveBeenCalledOnce();
  });
});

describe('OrchestratorService — authenticated stale callback boundary', () => {
  it('rejects valid-HMAC stale tool, event, and artifact callbacks with zero side effects', async () => {
    const sandboxSessionId = 'sandbox-stale';
    const agentId = 'agent-1';
    const turnId = 'run-1';
    const secret = 'callback-secret';
    const headers = new Headers({
      [CALLBACK_SESSION_HEADER]: sandboxSessionId,
      [CALLBACK_AGENT_HEADER]: agentId,
      [CALLBACK_TOKEN_HEADER]: mintGrpcCallbackToken(
        sandboxSessionId,
        agentId,
        secret,
      ),
    });
    const repository = makeDedupRepository({
      getTurnDeliveryCapabilityClaims: vi.fn().mockResolvedValue(undefined),
    });
    const toolHandler = vi.fn().mockResolvedValue('must-not-run');
    const eventBus = makeEventBus();
    const eventListener = vi.fn();
    (eventBus.on as unknown as (
      event: string,
      handler: (payload: unknown) => void,
    ) => void)('stale.callback', eventListener);
    const svc = createOrchestratorServiceImpl({
      eventBus,
      toolRegistry: makeRegistry({ 'my-tool': toolHandler }),
      repository,
      callbackAuthConfig: { mode: 'enforce', secret },
    });

    const toolRequest = withLiveDeliveryCapability(create(RequestToolRequestSchema, {
      turnId,
      sandboxSessionId,
      agentId,
      toolName: 'my-tool',
      argsJson: '{}',
      requestId: 'req-authenticated-stale',
    }), {}, secret);
    const eventRequest = withLiveDeliveryCapability(create(EmitEventRequestSchema, {
      turnId,
      sandboxSessionId,
      agentId,
      eventType: 'stale.callback',
      payloadJson: '{}',
    }), {}, secret);
    const artifactRequest = withLiveDeliveryCapability(create(RegisterArtifactRequestSchema, {
      turnId,
      sandboxSessionId,
      agentId,
      artifact: create(ArtifactMetaSchema, {
        id: 'artifact-authenticated-stale',
        turnId,
        agentId,
        name: 'stale.txt',
      }),
    }), {}, secret);

    for (const request of [toolRequest, eventRequest, artifactRequest]) {
      expect(() => validateGrpcCallbackAuth(
        { mode: 'enforce', secret },
        headers,
        request,
      )).not.toThrow();
    }

    await expectConnectError(svc.requestTool(toolRequest), Code.FailedPrecondition);
    await expectConnectError(svc.emitEvent(eventRequest), Code.FailedPrecondition);
    await expectConnectError(svc.registerArtifact(artifactRequest), Code.FailedPrecondition);

    expect(repository.tryAdmitToolRequest).not.toHaveBeenCalled();
    expect(toolHandler).not.toHaveBeenCalled();
    expect(eventBus.emitCustomAsync).not.toHaveBeenCalled();
    expect(eventListener).not.toHaveBeenCalled();
    expect(repository.saveArtifactIfDeliveryOwned).not.toHaveBeenCalled();
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
      {
        turnId: 'turn-1',
        conversationId: 'conversation-1',
        agentId: 'agent-1',
        requestId: 'req-1',
      },
    );

    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.eventType).toBe('my.custom.event');

    expect(eventBus.emitCustomAsync).toHaveBeenCalledWith(
      'my.custom.event',
      'agent-1',
      expect.objectContaining({
        key: 'value',
        turnId: 'turn-1',
        conversationId: 'conversation-1',
        agentId: 'agent-1',
      }),
    );
  });

  it('returns an error string when type is not provided', async () => {
    const eventBus = makeEventBus();
    const registry = new DefaultOrchestratorToolRegistry();
    registerDefaultToolHandlers(registry, eventBus);

    const handler = registry.get('emit-event')!;
    const result = await handler(
      {},
      { turnId: 'turn-1', agentId: 'agent-1', requestId: 'req-1' },
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
      { turnId: 'turn-1', agentId: 'agent-1', requestId: 'req-1' },
    );

    expect(result).toBe('Error: emit-event requires a non-empty string "type"');
    expect(eventBus.emitCustomAsync).not.toHaveBeenCalled();
  });
});

describe('createGrpcRoutes', () => {
  it('returns a function that can configure a ConnectRouter', () => {
    const eventBus = makeEventBus();
    const routesFn = createGrpcRoutes({ eventBus, repository: makeDedupRepository() });

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

    const routesFn = createGrpcRoutes({
      eventBus,
      toolRegistry: registry,
      repository: makeDedupRepository(),
    });

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
    createGrpcRoutes({
      eventBus,
      toolRegistry: registry,
      toolExecutor: executor,
      repository: makeDedupRepository(),
    });

    expect(registry.has('my-local-tool')).toBe(true);
    const handler = registry.get('my-local-tool')!;
    const result = await handler({ x: 21 }, { turnId: 'run-1', agentId: 'agent-1', requestId: 'req-1' });
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

    const routes = createGrpcRoutes({
      eventBus,
      toolDefinitionRegistry: defRegistry,
      repository: makeDedupRepository(),
    });
    expect(typeof routes).toBe('function');

    const registry = new DefaultOrchestratorToolRegistry(defRegistry, (ctx) => ({
      agentId: ctx.agentId,
      conversationId: ctx.conversationId ?? '',
      turnId: ctx.turnId,
      requestId: ctx.requestId,
      workspaceDir: '/workspace',
    }));

    expect(registry.has('http-health-check')).toBe(true);
    const handler = registry.get('http-health-check')!;
    const result = await handler({ url: 'http://example.com' }, { turnId: 'run-1', agentId: 'agent-1', requestId: 'req-1' });
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
    createGrpcRoutes({
      eventBus,
      toolRegistry: registry,
      toolExecutor: executor,
      repository: makeDedupRepository(),
    });

    const handler = registry.get('emit-event')!;
    const result = await handler(
      { type: 'test' },
      { turnId: 'turn-1', agentId: 'agent-1', requestId: 'req-1' },
    );
    expect(result).not.toBe('WRONG');
  });

  it('bridged handler receives agentId and turnId from gRPC context', async () => {
    const eventBus = makeEventBus();
    const { LocalFunctionExecutor } = await import('../../../tool/executor.js');
    const { z } = await import('zod');

    const receivedCtx = { agentId: '', turnId: '' };
    const executor = new LocalFunctionExecutor();
    executor.register({
      name: 'ctx-checker',
      description: 'checks context',
      input: z.object({}),
      handler: async (_input: unknown, ctx) => {
        receivedCtx.agentId = ctx.agentId;
        receivedCtx.turnId = ctx.turnId ?? '';
        return 'ok';
      },
    });

    const registry = new DefaultOrchestratorToolRegistry();
    createGrpcRoutes({
      eventBus,
      toolRegistry: registry,
      toolExecutor: executor,
      repository: makeDedupRepository(),
    });

    await registry.get('ctx-checker')!({}, { turnId: 'turn-42', agentId: 'agent-99', requestId: 'req-1' });
    expect(receivedCtx.agentId).toBe('agent-99');
    expect(receivedCtx.turnId).toBe('turn-42');
  });

  it('resolves HTTP tools added to DefaultToolRegistry AFTER gRPC routes are created', async () => {
    const { DefaultToolRegistry } = await import('../../../tool/registry.js');
    const { HTTPToolProvider } = await import('../../../tool/providers/http.js');
    const eventBus = makeEventBus();

    const defRegistry = new DefaultToolRegistry();

    createGrpcRoutes({
      eventBus,
      toolDefinitionRegistry: defRegistry,
      repository: makeDedupRepository(),
    });

    const grpcRegistry = new DefaultOrchestratorToolRegistry(defRegistry, (ctx) => ({
      agentId: ctx.agentId,
      conversationId: ctx.conversationId ?? '',
      turnId: ctx.turnId,
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
      conversationId: ctx.conversationId ?? '',
      turnId: ctx.turnId,
      requestId: ctx.requestId,
      workspaceDir: '/workspace',
    }));
    registerDefaultToolHandlers(grpcRegistry, eventBus);

    const impl = createOrchestratorServiceImpl({ eventBus, toolRegistry: grpcRegistry });
    const resp = await impl.requestTool(create(RequestToolRequestSchema, {
      turnId: 'run-1',
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
      conversationId: ctx.conversationId ?? '',
      turnId: ctx.turnId,
      requestId: ctx.requestId,
      workspaceDir: '/workspace',
    }));
    registerDefaultToolHandlers(grpcRegistry, eventBus);
    const impl = createOrchestratorServiceImpl({ eventBus, toolRegistry: grpcRegistry });

    const agentAResp = await impl.requestTool(create(RequestToolRequestSchema, {
      turnId: 'run-a',
      agentId: 'agent-a',
      toolName: 'shared-http-tool',
      argsJson: '{}',
      requestId: 'req-a',
    }));
    const agentBResp = await impl.requestTool(create(RequestToolRequestSchema, {
      turnId: 'run-b',
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
      turnId: 'turn-1',
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
      repository: {
        getArtifact,
        getTurnDeliveryCapabilityClaims: vi.fn().mockResolvedValue({
          ...LIVE_DELIVERY_CLAIMS,
          conversationId: 'conversation-1',
        }),
      } as unknown as DatabaseRepository,
      getArtifact,
    };
  }

  it('resolves an artifact owned by the authenticated agent', async () => {
    const eventBus = makeEventBus();
    const { repository } = makeArtifactRepository(makeArtifactRow({ agentId: 'agent-a' }));
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: makeRegistry(), repository });

    const resp = await svc.resolveArtifact(withLiveDeliveryCapability(
      create(ResolveArtifactRequestSchema, {
      artifactId: 'artifact-1',
      agentId: 'agent-a',
      turnId: 'run-1',
      sandboxSessionId: 'sandbox-1',
      }),
    ));

    expect(resp.error).toBeFalsy();
    expect(resp.artifact?.id).toBe('artifact-1');
    expect(resp.artifact?.storageKey).toBe('agents/agent-a/report.pdf');
  });

  it('denies cross-agent artifact resolution as not-found (IDOR guard)', async () => {
    const eventBus = makeEventBus();
    const { repository } = makeArtifactRepository(makeArtifactRow({ agentId: 'agent-a' }));
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: makeRegistry(), repository });

    const resp = await svc.resolveArtifact(withLiveDeliveryCapability(
      create(ResolveArtifactRequestSchema, {
      artifactId: 'artifact-1',
      agentId: 'agent-b',
      turnId: 'run-1',
      sandboxSessionId: 'sandbox-1',
      }),
    ));

    expect(resp.artifact).toBeUndefined();
    expect(resp.error).toBe('Artifact not found: artifact-1');
  });

  it('resolves unowned (null-agent) artifacts for any authenticated agent', async () => {
    const eventBus = makeEventBus();
    const { repository } = makeArtifactRepository(makeArtifactRow({ agentId: null }));
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: makeRegistry(), repository });

    const resp = await svc.resolveArtifact(withLiveDeliveryCapability(
      create(ResolveArtifactRequestSchema, {
      artifactId: 'artifact-1',
      agentId: 'agent-b',
      turnId: 'run-1',
      sandboxSessionId: 'sandbox-1',
      }),
    ));

    expect(resp.error).toBeFalsy();
    expect(resp.artifact?.id).toBe('artifact-1');
  });

  it('rejects artifact resolution without a canonical caller identity', async () => {
    const eventBus = makeEventBus();
    const { repository } = makeArtifactRepository(makeArtifactRow({ agentId: 'agent-a' }));
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: makeRegistry(), repository });

    await expectConnectError(svc.resolveArtifact(create(
      ResolveArtifactRequestSchema,
      {
        artifactId: 'artifact-1',
        agentId: '',
        turnId: 'run-1',
        sandboxSessionId: 'sandbox-1',
      },
    )), Code.InvalidArgument);
  });

  it('reports a genuinely missing artifact as not-found', async () => {
    const eventBus = makeEventBus();
    const { repository } = makeArtifactRepository(undefined);
    const svc = createOrchestratorServiceImpl({ eventBus, toolRegistry: makeRegistry(), repository });

    const resp = await svc.resolveArtifact(withLiveDeliveryCapability(
      create(ResolveArtifactRequestSchema, {
      artifactId: 'ghost',
      agentId: 'agent-a',
      turnId: 'run-1',
      sandboxSessionId: 'sandbox-1',
      }),
    ));

    expect(resp.artifact).toBeUndefined();
    expect(resp.error).toBe('Artifact not found: ghost');
  });
});
