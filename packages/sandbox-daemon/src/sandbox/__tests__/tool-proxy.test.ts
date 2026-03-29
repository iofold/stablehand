// @ts-nocheck — test file with mock data, zod v4 type widening
/**
 * Tests for the sandbox tool proxy — verifies that orchestrator-location
 * tools are correctly proxied via gRPC with retries and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { ConnectError, Code } from '@connectrpc/connect';
import {
  RequestToolResponseSchema,
  ToolMetadataSchema,
  ToolLocation,
  type ToolMetadata as ProtoToolMetadata,
} from '@ctxmill/proto/sandbox/v1';

import {
  createToolProxy,
  createOrchestratorToolProxies,
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
    ...impl,
  };
}

function makeProtoToolMetadata(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  location: ToolLocation = ToolLocation.SANDBOX,
): ProtoToolMetadata {
  return create(ToolMetadataSchema, {
    name,
    description,
    inputSchemaJson: JSON.stringify(inputSchema),
    location,
  });
}

/* -------------------------------------------------------------------------- */
/*  createToolProxy                                                            */
/* -------------------------------------------------------------------------- */

describe('createToolProxy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a RequestTool RPC and returns the result', async () => {
    const client = makeMockClient({
      requestTool: vi.fn().mockResolvedValue(
        makeSuccessResponse('rpc-1', '{"found":3}'),
      ),
    });

    const handler = createToolProxy('search', client, 'run-1', 'agent-1', {
      retryDelays: [],
    });
    const result = await handler({ query: 'hello' });

    expect(result).toBe('{"found":3}');
    expect(client.requestTool).toHaveBeenCalledTimes(1);

    const callArgs = (client.requestTool as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.runId).toBe('run-1');
    expect(callArgs.agentId).toBe('agent-1');
    expect(callArgs.toolName).toBe('search');
    expect(JSON.parse(callArgs.argsJson)).toEqual({ query: 'hello' });
    expect(callArgs.requestId).toBeTruthy();
  });

  it('returns orchestrator error as tool error JSON', async () => {
    const client = makeMockClient({
      requestTool: vi.fn().mockResolvedValue(
        makeErrorResponse('rpc-1', 'Unknown orchestrator tool: foo'),
      ),
    });

    const handler = createToolProxy('foo', client, 'run-1', 'agent-1', {
      retryDelays: [],
    });
    const result = await handler({});
    const parsed = JSON.parse(result);

    expect(parsed.error).toBe('Unknown orchestrator tool: foo');
  });

  it('retries on gRPC transport failure', async () => {
    const requestTool = vi.fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(makeSuccessResponse('rpc-3', '{"retry":"ok"}'));

    const client = makeMockClient({ requestTool });

    const handler = createToolProxy('emit-event', client, 'run-1', 'agent-1', {
      retryDelays: [1, 1, 1], // Short delays for testing
    });
    const result = await handler({ event_type: 'test' });

    expect(result).toBe('{"retry":"ok"}');
    expect(requestTool).toHaveBeenCalledTimes(3);
  });

  it('returns error when all retries are exhausted', async () => {
    const requestTool = vi.fn()
      .mockRejectedValue(new Error('network failure'));

    const client = makeMockClient({ requestTool });

    const handler = createToolProxy('emit-event', client, 'run-1', 'agent-1', {
      retryDelays: [1, 1], // 2 retries + 1 initial = 3 attempts
    });
    const result = await handler({ event_type: 'test' });
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain('failed after 3 attempts');
    expect(parsed.error).toContain('network failure');
    expect(requestTool).toHaveBeenCalledTimes(3);
  });

  it('does not retry on non-retryable ConnectError codes', async () => {
    const requestTool = vi.fn()
      .mockRejectedValue(new ConnectError('invalid args', Code.InvalidArgument));

    const client = makeMockClient({ requestTool });

    const handler = createToolProxy('bad-tool', client, 'run-1', 'agent-1', {
      retryDelays: [1, 1, 1],
    });
    const result = await handler({});
    const parsed = JSON.parse(result);

    // Should fail after only 1 attempt (no retries for InvalidArgument)
    expect(parsed.error).toContain('failed after');
    expect(requestTool).toHaveBeenCalledTimes(1);
  });

  it('serializes string input directly', async () => {
    const requestTool = vi.fn().mockResolvedValue(
      makeSuccessResponse('rpc-1', 'ok'),
    );
    const client = makeMockClient({ requestTool });

    const handler = createToolProxy('tool', client, 'run-1', 'agent-1', {
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

    const handler = createToolProxy('tool', client, 'run-1', 'agent-1', {
      retryDelays: [],
    });
    await handler(undefined);

    const callArgs = requestTool.mock.calls[0][0];
    expect(callArgs.argsJson).toBe('{}');
  });
});

/* -------------------------------------------------------------------------- */
/*  createOrchestratorToolProxies                                              */
/* -------------------------------------------------------------------------- */

describe('createOrchestratorToolProxies', () => {
  it('creates proxy handlers only for ORCHESTRATOR location tools', () => {
    const tools = [
      makeProtoToolMetadata(
        'emit-event',
        'Emit a custom event',
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        ToolLocation.ORCHESTRATOR,
      ),
      makeProtoToolMetadata(
        'request-approval',
        'Request user approval',
        { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
        ToolLocation.ORCHESTRATOR,
      ),
      makeProtoToolMetadata(
        'read-file',
        'Read a file from the workspace',
        { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        ToolLocation.SANDBOX,
      ),
    ];

    const client = makeMockClient();
    const defs = createOrchestratorToolProxies(tools, client, 'run-1', 'agent-1');

    // Only the 2 ORCHESTRATOR tools should be returned
    expect(defs).toHaveLength(2);
    expect(defs[0].name).toBe('emit-event');
    expect(defs[1].name).toBe('request-approval');
  });

  it('sandbox tools are not included in results', () => {
    const tools = [
      makeProtoToolMetadata(
        'read-file',
        'Read a file',
        { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        ToolLocation.SANDBOX,
      ),
      makeProtoToolMetadata(
        'write-file',
        'Write a file',
        { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        ToolLocation.SANDBOX,
      ),
    ];

    const client = makeMockClient();
    const defs = createOrchestratorToolProxies(tools, client, 'run-1', 'agent-1');

    expect(defs).toHaveLength(0);
  });

  it('creates correct Zod schema and handler for each tool', async () => {
    const requestTool = vi.fn().mockResolvedValue(
      makeSuccessResponse('rpc-1', '{"emitted":true}'),
    );
    const client = makeMockClient({ requestTool });

    const tools = [
      makeProtoToolMetadata(
        'emit-event',
        'Emit a custom event',
        {
          type: 'object',
          properties: {
            event_type: { type: 'string' },
            payload: { type: 'object' },
          },
          required: ['event_type'],
        },
        ToolLocation.ORCHESTRATOR,
      ),
    ];

    const defs = createOrchestratorToolProxies(tools, client, 'run-1', 'agent-1', {
      retryDelays: [],
    });

    expect(defs).toHaveLength(1);

    // Verify Zod schema works
    const parsed = defs[0].input.safeParse({ event_type: 'test' });
    expect(parsed.success).toBe(true);

    // Verify handler proxies through
    const result = await defs[0].handler({ event_type: 'test' }, {} as any);
    expect(result).toBe('{"emitted":true}');
    expect(requestTool).toHaveBeenCalledTimes(1);
  });

  it('returns empty array for empty tool list', () => {
    const client = makeMockClient();
    const defs = createOrchestratorToolProxies([], client, 'run-1', 'agent-1');
    expect(defs).toEqual([]);
  });

  it('filters out UNSPECIFIED location tools', () => {
    const tools = [
      makeProtoToolMetadata(
        'unknown-tool',
        'Unknown location',
        { type: 'object', properties: {} },
        ToolLocation.UNSPECIFIED,
      ),
    ];

    const client = makeMockClient();
    const defs = createOrchestratorToolProxies(tools, client, 'run-1', 'agent-1');

    expect(defs).toHaveLength(0);
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

    const handler = createToolProxy('request-approval', client, 'run-1', 'agent-1', {
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

    const handler = createToolProxy('request-approval', client, 'run-1', 'agent-1', {
      retryDelays: [],
    });

    const result = await handler({ tool: 'delete-file', args: { path: '/tmp/foo' } });
    const parsed = JSON.parse(result);

    expect(parsed.approved).toBe(false);
    expect(parsed.reason).toBe('User rejected the action');
  });
});
