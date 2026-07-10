/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * End-to-end tests for the emit-event tool flow through the gRPC proxy.
 *
 * Verifies the complete path:
 *   sandbox emit-event call -> tool proxy -> RequestTool RPC ->
 *   orchestrator dispatch -> EventBus.emitCustomAsync() -> success result
 *
 * Also verifies ToolMetadata marking, field name mapping, error propagation,
 * and payload data fidelity.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { create } from '@bufbuild/protobuf';
import {
  RequestToolResponseSchema,
  ToolMetadataSchema,
  ToolLocation,
  type ToolMetadata as ProtoToolMetadata,
} from '@ctxmill/proto/sandbox/v1';

import {
  createToolProxy,
  type OrchestratorServiceClient,
} from '@ctxmill/sandbox-daemon';
import { protoToToolDefs } from '../proto-convert.js';
import { toToolMetadata, toToolMetadataList } from '../../tool/metadata.js';
import { emitEventTool } from '../../tool/builtin/emit-event.js';
import { builtinTools, builtinToolNames } from '../../tool/builtin/index.js';
import {
  createOrchestratorServiceImpl,
  DefaultOrchestratorToolRegistry,
  registerDefaultToolHandlers,
} from '../../orchestrator/grpc/orchestrator-service.js';
import { TypedEventBus } from '../../events/bus.js';
import { zodToJsonSchema } from '../../tool/schema-convert.js';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function makeSuccessResponse(requestId: string, result: string) {
  return create(RequestToolResponseSchema, { requestId, result });
}

function makeErrorResponse(requestId: string, error: string) {
  return create(RequestToolResponseSchema, { requestId, result: '', error });
}

function makeMockClient(
  impl?: Partial<OrchestratorServiceClient>,
): OrchestratorServiceClient {
  return {
    requestTool: vi.fn().mockResolvedValue(
      makeSuccessResponse('req-1', '{"ok":true}'),
    ),
    registerArtifact: vi.fn(),
    resolveArtifact: vi.fn(),
    ...impl,
  };
}

function makeEventBus() {
  const bus = new TypedEventBus();
  vi.spyOn(bus, 'emitCustom');
  vi.spyOn(bus, 'emitCustomAsync');
  return bus;
}

function makeEmitEventProtoMetadata(): ProtoToolMetadata {
  const inputSchema = zodToJsonSchema(emitEventTool.input);
  return create(ToolMetadataSchema, {
    name: 'emit-event',
    description: emitEventTool.description,
    inputSchemaJson: JSON.stringify(inputSchema),
    location: ToolLocation.ORCHESTRATOR,
  });
}

describe('emit-event builtin registration', () => {
  it('is explicitly marked as an orchestrator tool', () => {
    expect(emitEventTool.location).toBe('orchestrator');
  });

  it('is included in the builtinTools array', () => {
    const found = builtinTools.find((t) => t.name === 'emit-event');
    expect(found).toBeDefined();
    expect(found!.name).toBe('emit-event');
  });

  it('is included in the builtinToolNames set', () => {
    expect(builtinToolNames.has('emit-event')).toBe(true);
  });
});

describe('emit-event ToolMetadata', () => {
  it('is marked as orchestrator location by toToolMetadata()', () => {
    const meta = toToolMetadata(emitEventTool);
    expect(meta.location).toBe('orchestrator');
    expect(meta.name).toBe('emit-event');
  });

  it('has the correct input schema with type and payload fields', () => {
    const meta = toToolMetadata(emitEventTool);
    const props = meta.inputSchema.properties as Record<string, Record<string, unknown>>;

    expect(props.type).toBeDefined();
    expect(props.type.type).toBe('string');
    expect(props.payload).toBeDefined();

    const required = meta.inputSchema.required as string[];
    expect(required).toContain('type');
    expect(required).toContain('payload');
  });

  it('appears as orchestrator in toToolMetadataList() bulk conversion', () => {
    const metaList = toToolMetadataList(builtinTools);
    const emitMeta = metaList.find((m) => m.name === 'emit-event');
    expect(emitMeta).toBeDefined();
    expect(emitMeta!.location).toBe('orchestrator');
  });
});

/* -------------------------------------------------------------------------- */
/*  Sandbox-side proxy: emit-event through createToolProxy                     */
/* -------------------------------------------------------------------------- */

describe('emit-event through sandbox tool proxy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('proxies emit-event call and returns orchestrator result', async () => {
    const requestTool = vi.fn().mockResolvedValue(
      makeSuccessResponse('rpc-1', JSON.stringify({ ok: true, eventType: 'email.classified' })),
    );
    const client = makeMockClient({ requestTool });

    const handler = createToolProxy('emit-event', client, 'run-1', 'agent-1', {
      retryDelays: [],
    });

    const result = await handler({
      type: 'email.classified',
      payload: { category: 'support', confidence: 0.95 },
    });

    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.eventType).toBe('email.classified');

    // Verify the RPC was called with correct serialization
    const callArgs = requestTool.mock.calls[0][0];
    expect(callArgs.sessionId).toBe('run-1');
    expect(callArgs.agentId).toBe('agent-1');
    expect(callArgs.toolName).toBe('emit-event');
    const sentArgs = JSON.parse(callArgs.argsJson);
    expect(sentArgs.type).toBe('email.classified');
    expect(sentArgs.payload.category).toBe('support');
    expect(sentArgs.payload.confidence).toBe(0.95);
  });

  it('payload data survives serialization round-trip', async () => {
    const complexPayload = {
      nested: { deep: { value: 42 } },
      array: [1, 'two', { three: true }],
      nullField: null,
      emptyStr: '',
      special: 'line\nbreak\ttab',
    };

    const requestTool = vi.fn().mockImplementation(async (req: any) => {
      // Echo back the received args to verify fidelity
      return makeSuccessResponse(req.requestId, req.argsJson);
    });
    const client = makeMockClient({ requestTool });

    const handler = createToolProxy('emit-event', client, 'run-1', 'agent-1', {
      retryDelays: [],
    });

    const result = await handler({
      type: 'data.test',
      payload: complexPayload,
    });

    const echoed = JSON.parse(result);
    expect(echoed.type).toBe('data.test');
    expect(echoed.payload.nested.deep.value).toBe(42);
    expect(echoed.payload.array).toEqual([1, 'two', { three: true }]);
    expect(echoed.payload.nullField).toBeNull();
    expect(echoed.payload.emptyStr).toBe('');
    expect(echoed.payload.special).toBe('line\nbreak\ttab');
  });

  it('throws orchestrator errors back through the proxy', async () => {
    const requestTool = vi.fn().mockResolvedValue(
      makeErrorResponse('rpc-1', 'EventBus is down'),
    );
    const client = makeMockClient({ requestTool });

    const handler = createToolProxy('emit-event', client, 'run-1', 'agent-1', {
      retryDelays: [],
    });

    await expect(handler({
      type: 'test.event',
      payload: {},
    })).rejects.toThrow('EventBus is down');
  });

  it('retries on transport failure and succeeds on subsequent attempt', async () => {
    const requestTool = vi.fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(
        makeSuccessResponse('rpc-2', JSON.stringify({ ok: true, eventType: 'retried' })),
      );

    const client = makeMockClient({ requestTool });

    const handler = createToolProxy('emit-event', client, 'run-1', 'agent-1', {
      retryDelays: [1], // Single fast retry for testing
    });

    const result = await handler({ type: 'retried', payload: {} });
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(requestTool).toHaveBeenCalledTimes(2);
  });
});

/* -------------------------------------------------------------------------- */
/*  Sandbox-side: protoToToolDefs wires proxy for emit-event                   */
/* -------------------------------------------------------------------------- */

describe('protoToToolDefs wires emit-event proxy', () => {
  it('creates a proxy handler for emit-event when orchestratorClient is provided', async () => {
    const requestTool = vi.fn().mockResolvedValue(
      makeSuccessResponse('rpc-1', JSON.stringify({ ok: true })),
    );
    const client = makeMockClient({ requestTool });

    const tools = [makeEmitEventProtoMetadata()];

    const defs = protoToToolDefs(tools, {
      orchestratorClient: client,
      sessionId: 'run-1',
      agentId: 'agent-1',
    });

    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('emit-event');

    // Call the handler — should proxy to orchestrator
    const result = await defs[0].handler(
      { type: 'test.event', payload: { key: 'val' } },
      {} as any,
    );
    expect(JSON.parse(result).ok).toBe(true);
    expect(requestTool).toHaveBeenCalledTimes(1);
  });

  it('fails fast when orchestratorClient is not provided', async () => {
    const tools = [makeEmitEventProtoMetadata()];

    expect(() => protoToToolDefs(tools)).toThrow(/proxy for "emit-event" is not connected/i);
  });

  it('reconstructs a working Zod schema from the proto metadata', () => {
    const tools = [makeEmitEventProtoMetadata()];
    const defs = protoToToolDefs(tools, {
      orchestratorClient: makeMockClient(),
      sessionId: 'run-1',
      agentId: 'agent-1',
    });

    // Should validate correctly
    const valid = (defs[0].input as { safeParse: (input: unknown) => { success: boolean } }).safeParse({
      type: 'email.sent',
      payload: { to: 'user@example.com' },
    });
    expect(valid.success).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Orchestrator-side: emit-event handler via registerDefaultToolHandlers      */
/* -------------------------------------------------------------------------- */

describe('orchestrator emit-event handler', () => {
  let eventBus: TypedEventBus;
  let registry: DefaultOrchestratorToolRegistry;

  beforeEach(() => {
    eventBus = makeEventBus();
    registry = new DefaultOrchestratorToolRegistry();
    registerDefaultToolHandlers(registry, eventBus);
    vi.restoreAllMocks();
    vi.spyOn(eventBus, 'emitCustomAsync');
  });

  it('dispatches emit-event with "type" field (matching Zod schema)', async () => {
    const handler = registry.get('emit-event')!;

    const result = await handler(
      { type: 'email.classified', payload: { category: 'support' } },
      { sessionId: 'run-1', agentId: 'agent-1', requestId: 'req-1' },
    );

    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.eventType).toBe('email.classified');

    expect(eventBus.emitCustomAsync).toHaveBeenCalledWith(
      'email.classified',
      'agent-1',
      expect.objectContaining({ category: 'support', runId: 'run-1', agentId: 'agent-1' }),
    );
  });

  it('returns an error string when no type field is provided', async () => {
    const handler = registry.get('emit-event')!;

    const result = await handler(
      { payload: { data: 'test' } },
      { sessionId: 'run-1', agentId: 'agent-1', requestId: 'req-1' },
    );

    expect(result).toBe('Error: emit-event requires a non-empty string "type"');
    expect(eventBus.emitCustomAsync).not.toHaveBeenCalled();
  });

  it('handles empty payload gracefully', async () => {
    const handler = registry.get('emit-event')!;

    const result = await handler(
      { type: 'empty.event' },
      { sessionId: 'run-1', agentId: 'agent-1', requestId: 'req-1' },
    );

    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);

    expect(eventBus.emitCustomAsync).toHaveBeenCalledWith(
      'empty.event',
      'agent-1',
      expect.objectContaining({ runId: 'run-1', agentId: 'agent-1' }),
    );
  });

  it('injects runId and agentId into the payload', async () => {
    const handler = registry.get('emit-event')!;

    await handler(
      { type: 'inject.test', payload: { original: true } },
      { sessionId: 'run-99', agentId: 'agent-X', requestId: 'req-1' },
    );

    expect(eventBus.emitCustomAsync).toHaveBeenCalledWith(
      'inject.test',
      'agent-X',
      expect.objectContaining({
        original: true,
        runId: 'run-99',
        agentId: 'agent-X',
      }),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  Full end-to-end: sandbox proxy -> orchestrator dispatch -> EventBus        */
/* -------------------------------------------------------------------------- */

describe('emit-event end-to-end: proxy -> orchestrator -> EventBus', () => {
  it('complete flow: sandbox tool call -> RequestTool RPC -> handler -> EventBus.emitCustomAsync()', async () => {
    // 1. Set up the orchestrator side
    const eventBus = makeEventBus();
    const registry = new DefaultOrchestratorToolRegistry();
    registerDefaultToolHandlers(registry, eventBus);
    const svcImpl = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    // 2. Create a mock client that delegates to the actual orchestrator service impl
    const client = makeMockClient({
      requestTool: async (req) => svcImpl.requestTool(req as any),
    });

    // 3. Create the sandbox-side proxy handler
    const handler = createToolProxy('emit-event', client, 'run-1', 'agent-1', {
      retryDelays: [],
    });

    // 4. Call the tool as the LLM would (using the Zod schema field names)
    const result = await handler({
      type: 'email.classified',
      payload: { category: 'billing', confidence: 0.87 },
    });

    // 5. Verify the proxy returned success
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.eventType).toBe('email.classified');

    // 6. Verify the EventBus was called on the orchestrator side
    expect(eventBus.emitCustomAsync).toHaveBeenCalledTimes(1);
    expect(eventBus.emitCustomAsync).toHaveBeenCalledWith(
      'email.classified',
      'agent-1',
      expect.objectContaining({
        category: 'billing',
        confidence: 0.87,
        runId: 'run-1',
        agentId: 'agent-1',
      }),
    );
  });

  it('complete flow: error in EventBus handler propagates back through proxy', async () => {
    const eventBus = makeEventBus();
    // Make emitCustomAsync throw
    vi.spyOn(eventBus, 'emitCustomAsync').mockImplementation(() => {
      throw new Error('EventBus internal error: queue full');
    });

    const registry = new DefaultOrchestratorToolRegistry();
    registerDefaultToolHandlers(registry, eventBus);
    const svcImpl = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const client = makeMockClient({
      requestTool: async (req) => svcImpl.requestTool(req as any),
    });

    const handler = createToolProxy('emit-event', client, 'run-1', 'agent-1', {
      retryDelays: [],
    });

    await expect(handler({
      type: 'will.fail',
      payload: {},
    })).rejects.toThrow('EventBus internal error: queue full');
  });

  it('complete flow with complex payload data preserved end-to-end', async () => {
    const eventBus = makeEventBus();
    const registry = new DefaultOrchestratorToolRegistry();
    registerDefaultToolHandlers(registry, eventBus);
    const svcImpl = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const client = makeMockClient({
      requestTool: async (req) => svcImpl.requestTool(req as any),
    });

    const handler = createToolProxy('emit-event', client, 'run-42', 'data-agent', {
      retryDelays: [],
    });

    const complexPayload = {
      records: [
        { id: 1, label: 'First', tags: ['a', 'b'] },
        { id: 2, label: 'Second', tags: ['c'] },
      ],
      metadata: {
        processingTime: 1250,
        model: 'gpt-4o',
        nested: { deep: true },
      },
      count: 2,
    };

    await handler({
      type: 'batch.processed',
      payload: complexPayload,
    });

    expect(eventBus.emitCustomAsync).toHaveBeenCalledTimes(1);
    const [eventType, agentId, payload] = (eventBus.emitCustomAsync as ReturnType<typeof vi.fn>).mock.calls[0];

    expect(eventType).toBe('batch.processed');
    expect(agentId).toBe('data-agent');
    expect(payload.records).toHaveLength(2);
    expect(payload.records[0].tags).toEqual(['a', 'b']);
    expect(payload.metadata.nested.deep).toBe(true);
    expect(payload.count).toBe(2);
    // Injected fields
    expect(payload.runId).toBe('run-42');
    expect(payload.agentId).toBe('data-agent');
  });

  it('complete flow via protoToToolDefs (full proto conversion path)', async () => {
    // This tests the complete proto conversion pipeline:
    // toToolMetadata -> proto metadata -> protoToToolDefs -> proxy handler -> orchestrator
    const eventBus = makeEventBus();
    const registry = new DefaultOrchestratorToolRegistry();
    registerDefaultToolHandlers(registry, eventBus);
    const svcImpl = createOrchestratorServiceImpl({ eventBus, toolRegistry: registry });

    const client = makeMockClient({
      requestTool: async (req) => svcImpl.requestTool(req as any),
    });

    // Convert the builtin emit-event tool through the full metadata pipeline
    const protoTools = [makeEmitEventProtoMetadata()];
    const toolDefs = protoToToolDefs(protoTools, {
      orchestratorClient: client,
      sessionId: 'run-proto',
      agentId: 'proto-agent',
    });

    expect(toolDefs).toHaveLength(1);
    const emitDef = toolDefs[0];
    expect(emitDef.name).toBe('emit-event');

    // Call through the full path
    const result = await emitDef.handler(
      { type: 'proto.test', payload: { source: 'sandbox' } },
      {} as any,
    );

    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.eventType).toBe('proto.test');

    expect(eventBus.emitCustomAsync).toHaveBeenCalledWith(
      'proto.test',
      'proto-agent',
      expect.objectContaining({
        source: 'sandbox',
        runId: 'run-proto',
        agentId: 'proto-agent',
      }),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  In-process emit-event tool (direct EventBus call)                          */
/* -------------------------------------------------------------------------- */

describe('emit-event in-process mode (direct EventBus call)', () => {
  it('awaits eventBus.emitCustomAsync when eventBus is in context', async () => {
    const eventBus = makeEventBus();

    const ctx = {
      agentId: 'agent-local',
      conversationId: 'conv-1',
      workspaceDir: '/tmp',
      eventBus,
    };

    const result = await emitEventTool.handler(
      { type: 'local.event', payload: { key: 'value' } },
      ctx,
    );

    expect(result).toContain('Event "local.event" emitted successfully');
    expect(result).toContain('1 payload field(s)');

    expect(eventBus.emitCustomAsync).toHaveBeenCalledWith(
      'local.event',
      'agent-local',
      { key: 'value' },
    );
  });

  it('does not report success before custom event persistence resolves', async () => {
    const observedOrder: string[] = [];
    let resolvePersist!: () => void;
    const persistGate = new Promise<void>((resolve) => {
      resolvePersist = resolve;
    });
    const eventBus = new TypedEventBus({
      persistEvent: vi.fn(async () => {
        observedOrder.push('persist:start');
        await persistGate;
        observedOrder.push('persist:done');
      }),
    });

    const ctx = {
      agentId: 'agent-local',
      conversationId: 'conv-1',
      workspaceDir: '/tmp',
      eventBus,
    };

    const resultPromise = emitEventTool.handler(
      { type: 'local.persisted', payload: { key: 'value' } },
      ctx,
    ).then((result) => {
      observedOrder.push('handler:done');
      return result;
    });

    await Promise.resolve();
    expect(observedOrder).toEqual(['persist:start']);

    resolvePersist();
    await expect(resultPromise).resolves.toContain('Event "local.persisted" emitted successfully');
    expect(observedOrder).toEqual(['persist:start', 'persist:done', 'handler:done']);
  });

  it('returns error message when eventBus is not available', async () => {
    const ctx = {
      agentId: 'agent-no-bus',
      conversationId: 'conv-1',
      workspaceDir: '/tmp',
      // no eventBus
    };

    const result = await emitEventTool.handler(
      { type: 'test', payload: {} },
      ctx,
    );

    expect(result).toContain('Error: Event bus is not available');
  });
});
