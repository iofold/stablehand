/**
 * Tests for the sandbox tool proxy — verifies that orchestrator-location
 * tools are correctly proxied via gRPC with retries and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { ConnectError, Code } from '@connectrpc/connect';
import {
  RequestToolResponseSchema,
  TurnDeliveryCapabilitySchema,
} from '@stablehand/proto/sandbox/v1';

import {
  createToolProxy,
  type OrchestratorServiceClient,
} from '../tool-proxy.js';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function makeSuccessResponse(requestId: string, result: string) {
  return create(RequestToolResponseSchema, {
    requestId,
    result,
  });
}

function makeErrorResponse(requestId: string, error: string) {
  return create(RequestToolResponseSchema, {
    requestId,
    result: '',
    error,
  });
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

function callbackRoute(turnId = 'run-1', agentId = 'agent-1') {
  const leaseExpiresAtMs = Date.now() + 60_000;
  const deliveryContext = {
    identity: {
      turnId,
      sandboxSessionId: 'sandbox-session-1',
      agentId,
      ownerId: 'owner-1',
      fenceToken: 1,
      restoreFenceToken: 0,
      containerId: 'container-1',
    },
    capability: create(TurnDeliveryCapabilitySchema, {
      ownerId: 'owner-1',
      fenceToken: 1n,
      leaseExpiresAtMs: BigInt(leaseExpiresAtMs),
      restoreFenceToken: 0n,
      containerId: 'container-1',
      agentId,
      signature: 'stablehand-open-turn-delivery-capability-v1',
    }),
    leaseExpiresAtMs,
    abortController: new AbortController(),
  };
  return {
    sandboxSessionId: 'sandbox-session-1',
    agentId,
    resolveDeliveryContext: () => deliveryContext,
  };
}

/* -------------------------------------------------------------------------- */
/*  createToolProxy                                                            */
/* -------------------------------------------------------------------------- */

describe('createToolProxy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the canonical sandbox callback identity with every tool request', async () => {
    const client = makeMockClient();
    const handler = createToolProxy(
      'search',
      client,
      {
        ...callbackRoute('turn-1'),
      },
      { retryDelays: [] },
    );

    await handler({});

    expect(client.requestTool).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 'turn-1',
        sandboxSessionId: 'sandbox-session-1',
        agentId: 'agent-1',
      }),
      expect.any(Object),
    );
  });

  it('sends a RequestTool RPC and returns the result', async () => {
    const client = makeMockClient({
      requestTool: vi.fn().mockResolvedValue(
        makeSuccessResponse('rpc-1', '{"found":3}'),
      ),
    });

    const handler = createToolProxy('search', client, callbackRoute(), {
      retryDelays: [],
    });
    const result = await handler({ query: 'hello' });

    expect(result).toBe('{"found":3}');
    expect(client.requestTool).toHaveBeenCalledTimes(1);

    const callArgs = (client.requestTool as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.turnId).toBe('run-1');
    expect(callArgs.agentId).toBe('agent-1');
    expect(callArgs.toolName).toBe('search');
    expect(JSON.parse(callArgs.argsJson)).toEqual({ query: 'hello' });
    expect(callArgs.requestId).toBeTruthy();
  });

  it('generates distinct request IDs across isolated sandbox processes', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1777799375224);

    vi.resetModules();
    const firstModule = await import('../tool-proxy.js');
    const firstRequestTool = vi.fn().mockImplementation((req) =>
      Promise.resolve(makeSuccessResponse(req.requestId, '{"ok":true}')),
    );
    const firstHandler = firstModule.createToolProxy(
      'emit-event',
      makeMockClient({ requestTool: firstRequestTool }),
      callbackRoute('turn-a'),
      { retryDelays: [] },
    );
    await firstHandler({ type: 'stress.tools.complete' });

    vi.resetModules();
    const secondModule = await import('../tool-proxy.js');
    const secondRequestTool = vi.fn().mockImplementation((req) =>
      Promise.resolve(makeSuccessResponse(req.requestId, '{"ok":true}')),
    );
    const secondHandler = secondModule.createToolProxy(
      'emit-event',
      makeMockClient({ requestTool: secondRequestTool }),
      callbackRoute('turn-b'),
      { retryDelays: [] },
    );
    await secondHandler({ type: 'stress.tools.complete' });

    const firstRequestId = firstRequestTool.mock.calls[0][0].requestId;
    const secondRequestId = secondRequestTool.mock.calls[0][0].requestId;
    expect(firstRequestId).not.toBe(secondRequestId);
  });

  it('throws orchestrator errors instead of returning tool error JSON', async () => {
    const client = makeMockClient({
      requestTool: vi.fn().mockResolvedValue(
        makeErrorResponse('rpc-1', 'Unknown orchestrator tool: foo'),
      ),
    });

    const handler = createToolProxy('foo', client, callbackRoute(), {
      retryDelays: [],
    });
    await expect(handler({})).rejects.toThrow('Unknown orchestrator tool: foo');
  });

  it('retries on gRPC transport failure', async () => {
    const requestTool = vi.fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(makeSuccessResponse('rpc-3', '{"retry":"ok"}'));

    const client = makeMockClient({ requestTool });

    const handler = createToolProxy('emit-event', client, callbackRoute(), {
      retryDelays: [1, 1, 1], // Short delays for testing
    });
    const result = await handler({ type: 'test' });

    expect(result).toBe('{"retry":"ok"}');
    expect(requestTool).toHaveBeenCalledTimes(3);
  });

  it('throws when all retries are exhausted', async () => {
    const requestTool = vi.fn()
      .mockRejectedValue(new Error('network failure'));

    const client = makeMockClient({ requestTool });

    const handler = createToolProxy('emit-event', client, callbackRoute(), {
      retryDelays: [1, 1], // 2 retries + 1 initial = 3 attempts
    });
    await expect(handler({ type: 'test' })).rejects.toThrow(
      /failed after 3 attempts: network failure/,
    );
    expect(requestTool).toHaveBeenCalledTimes(3);
  });

  it('does not retry on non-retryable ConnectError codes', async () => {
    const requestTool = vi.fn()
      .mockRejectedValue(new ConnectError('invalid args', Code.InvalidArgument));

    const client = makeMockClient({ requestTool });

    const handler = createToolProxy('bad-tool', client, callbackRoute(), {
      retryDelays: [1, 1, 1],
    });
    await expect(handler({})).rejects.toThrow(/failed after/);
    expect(requestTool).toHaveBeenCalledTimes(1);
  });

  it('serializes string input directly', async () => {
    const requestTool = vi.fn().mockResolvedValue(
      makeSuccessResponse('rpc-1', 'ok'),
    );
    const client = makeMockClient({ requestTool });

    const handler = createToolProxy('tool', client, callbackRoute(), {
      retryDelays: [],
    });
    await handler('already-json');

    const callArgs = requestTool.mock.calls[0][0];
    expect(callArgs.argsJson).toBe('already-json');
  });

  it('handles null/undefined input gracefully', async () => {
    const requestTool = vi.fn().mockResolvedValue(
      makeSuccessResponse('rpc-1', 'ok'),
    );
    const client = makeMockClient({ requestTool });

    const handler = createToolProxy('tool', client, callbackRoute(), {
      retryDelays: [],
    });
    await handler(undefined);

    const callArgs = requestTool.mock.calls[0][0];
    expect(callArgs.argsJson).toBe('{}');
  });

  it('serializes bigint tool input as lossless strings', async () => {
    const requestTool = vi.fn().mockResolvedValue(
      makeSuccessResponse('rpc-1', 'ok'),
    );
    const client = makeMockClient({ requestTool });

    const handler = createToolProxy('tool', client, callbackRoute(), {
      retryDelays: [],
    });
    await handler({ count: 9007199254740993n });

    const callArgs = requestTool.mock.calls[0][0];
    expect(callArgs.argsJson).toBe('{"count":"9007199254740993"}');
  });
});

/* -------------------------------------------------------------------------- */
/*  HITL approval flow                                                         */
/* -------------------------------------------------------------------------- */

describe('HITL approval flow through proxy', () => {
  it('proxies request-approval tool and returns approval result', async () => {
    const requestTool = vi.fn().mockResolvedValue(
      makeSuccessResponse('rpc-1', JSON.stringify({
        approved: true,
        reason: 'User approved the action',
      })),
    );
    const client = makeMockClient({ requestTool });

    const handler = createToolProxy('request-approval', client, callbackRoute(), {
      retryDelays: [],
    });

    const result = await handler({ tool: 'delete-file', args: { path: '/tmp/foo' } });
    const parsed = JSON.parse(result);

    expect(parsed.approved).toBe(true);
    expect(parsed.reason).toBe('User approved the action');
  });

  it('proxies rejection result correctly', async () => {
    const requestTool = vi.fn().mockResolvedValue(
      makeSuccessResponse('rpc-1', JSON.stringify({
        approved: false,
        reason: 'User rejected the action',
      })),
    );
    const client = makeMockClient({ requestTool });

    const handler = createToolProxy('request-approval', client, callbackRoute(), {
      retryDelays: [],
    });

    const result = await handler({ tool: 'delete-file', args: { path: '/tmp/foo' } });
    const parsed = JSON.parse(result);

    expect(parsed.approved).toBe(false);
    expect(parsed.reason).toBe('User rejected the action');
  });
});
