import { create } from '@bufbuild/protobuf';
import {
  CursorSchema,
  DeliverTurnRequestSchema,
  FreshBootstrapSchema,
  MessageSchema,
  PendingRequestSchema,
  RestoreBootstrapSchema,
  RunnerStateSchema,
  SessionCheckpointSchema,
  ToolCallSchema,
  ToolLocation,
  ToolMetadataSchema,
  WorkspaceRefSchema,
  type AgentEvent as ProtoAgentEvent,
  type DeliverTurnRequest,
  type FreshBootstrap,
  type RestoreBootstrap,
  type SessionCheckpoint as ProtoSessionCheckpoint,
  type ToolMetadata as ProtoToolMetadata,
} from '@ctxmill/proto/sandbox/v1';
import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent, ResolvedSecrets } from '../../harness/types.js';
import type { ToolContext, ToolDefinition } from '../../tool/types.js';
import type { OrchestratorServiceClient } from '../tool-proxy.js';
import {
  agentEventToSessionEvent,
  messageToCommittedEvent,
  protoDeliverTurnToInput,
  protoFreshBootstrapToSessionConfig,
  protoRestoreBootstrapToRestorePoint,
  protoSessionCheckpointToInternal,
  protoToToolDefs,
  sessionCheckpointToProto,
  type SessionCheckpoint as InternalSessionCheckpoint,
} from '../proto-convert.js';

interface ZodLike {
  safeParse(input: unknown): { success: boolean };
}

const TOOL_CONTEXT: ToolContext = {
  agentId: 'agent-ctx',
  conversationId: 'conv-ctx',
  workspaceDir: '/workspace',
  knowledge: {
    query: async () => ({ items: [] }),
  },
};

function makeToolDefinition(name = 'search'): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    input: {},
    handler: async () => JSON.stringify({ ok: true }),
  };
}

function makeFreshBootstrap(overrides: Partial<FreshBootstrap> = {}): FreshBootstrap {
  return create(FreshBootstrapSchema, {
    agentId: 'agent-123',
    conversationId: 'conv-456',
    harnessName: 'openai',
    harnessConfigJson: '{"mode":"json"}',
    systemPrompt: 'You are a focused sandbox harness.',
    tools: [],
    workspaceDir: '/tmp/workspace',
    ...overrides,
  });
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

function makeSessionCheckpoint(
  overrides: Partial<InternalSessionCheckpoint> = {},
): InternalSessionCheckpoint {
  return {
    checkpointVersion: 2,
    sessionId: 'session-123',
    conversationId: 'conv-456',
    harnessName: 'openai',
    cursor: {
      nextMessageSeq: 17,
      lastCompletedTurnId: 'turn-16',
    },
    runnerState: {
      status: 'waiting_for_input',
      pendingRequests: [
        {
          type: 'approval',
          id: 'req-1',
          payloadJson: '{"tool":"delete-file"}',
        },
        {
          type: 'tool',
          id: 'req-2',
          payloadJson: '{"tool":"emit-event"}',
        },
      ],
    },
    workspaceRef: {
      strategy: 'fuse',
      reference: '/overlay/session-123',
    },
    harnessState: {
      nested: {
        ok: true,
        count: 3,
      },
      labels: ['alpha', 'beta'],
    },
    ...overrides,
  };
}

function makeProtoSessionCheckpoint(
  overrides: Partial<ProtoSessionCheckpoint> = {},
): ProtoSessionCheckpoint {
  return create(SessionCheckpointSchema, {
    checkpointVersion: 3,
    sessionId: 'session-999',
    conversationId: 'conv-999',
    harnessName: 'claude',
    cursor: create(CursorSchema, {
      nextMessageSeq: 22n,
      lastCompletedTurnId: 'turn-21',
    }),
    runnerState: create(RunnerStateSchema, {
      status: 'paused',
      pendingRequests: [
        create(PendingRequestSchema, {
          type: 'approval',
          id: 'pending-1',
          payloadJson: '{"id":"ap-1"}',
        }),
      ],
    }),
    workspaceRef: create(WorkspaceRefSchema, {
      strategy: 'bind',
      reference: '/worktrees/conv-999',
    }),
    harnessState: {
      snapshot: 'ready',
      tokens: 42,
    },
    ...overrides,
  });
}

function getZodInput(definition: ToolDefinition): ZodLike {
  const candidate = definition.input;

  if (
    typeof candidate !== 'object'
    || candidate === null
    || !('safeParse' in candidate)
    || typeof candidate.safeParse !== 'function'
  ) {
    throw new Error('Expected ToolDefinition.input to expose safeParse()');
  }

  return candidate as ZodLike;
}

function getAgUiPayload(
  sessionEvent: ReturnType<typeof agentEventToSessionEvent>,
): ProtoAgentEvent {
  if (sessionEvent.payload.case !== 'agUiEvent') {
    throw new Error('Expected agUiEvent payload');
  }

  return sessionEvent.payload.value;
}

describe('protoFreshBootstrapToSessionConfig', () => {
  it('converts full bootstrap payloads to a harness session config', () => {
    const tools = [makeToolDefinition('search'), makeToolDefinition('emit-event')];
    const secrets: ResolvedSecrets = {
      MODEL_KEY: 'sk-model',
      EXTRA_SECRET: 'value',
    };

    const config = protoFreshBootstrapToSessionConfig(
      makeFreshBootstrap(),
      tools,
      secrets,
    );

    expect(config.agentId).toBe('agent-123');
    expect(config.conversationId).toBe('conv-456');
    expect(config.systemPrompt).toBe('You are a focused sandbox harness.');
    expect(config.tools).toBe(tools);
    expect(config.secrets).toBe(secrets);
    expect(config.workspaceDir).toBe('/tmp/workspace');
    expect(config.harnessConfigJson).toBe('{"mode":"json"}');
  });

  it('preserves harnessConfigJson and applies workspace fallback when omitted', () => {
    const config = protoFreshBootstrapToSessionConfig(
      makeFreshBootstrap({
        workspaceDir: '',
        harnessConfigJson: '',
      }),
      [],
      {},
    );

    expect(config.workspaceDir).toBe('/workspace');
    expect(config.harnessConfigJson).toBe('');
  });
});

describe('protoRestoreBootstrapToRestorePoint', () => {
  it('extracts checkpoint version and harness state payload', () => {
    const restore: RestoreBootstrap = create(RestoreBootstrapSchema, {
      sessionCheckpoint: makeProtoSessionCheckpoint({
        checkpointVersion: 7,
        harnessState: {
          cursor: 'abc',
          nested: { ok: true },
        },
      }),
    });

    const restorePoint = protoRestoreBootstrapToRestorePoint(restore);

    expect(restorePoint.stateVersion).toBe('7');
    expect(restorePoint.payload).toEqual({
      cursor: 'abc',
      nested: { ok: true },
    });
    expect(restorePoint.messages).toEqual([]);
  });

  it('falls back to version 1 and empty payload without a checkpoint', () => {
    const restore = create(RestoreBootstrapSchema, {});

    expect(() => protoRestoreBootstrapToRestorePoint(restore)).toThrow(
      'Restore bootstrap is missing session checkpoint',
    );
  });
});

describe('protoDeliverTurnToInput', () => {
  it('maps proto messages, tool calls, and tool call ids into harness turn input', () => {
    const request: DeliverTurnRequest = create(DeliverTurnRequestSchema, {
      sessionId: 'session-123',
      turnId: 'turn-7',
      messages: [
        create(MessageSchema, {
          id: 'msg-1',
          role: 'assistant',
          content: '',
          toolCalls: [
            create(ToolCallSchema, {
              id: 'tc-1',
              name: 'search',
              argumentsJson: '{"query":"ctxmill","filters":["tests"]}',
            }),
            create(ToolCallSchema, {
              id: 'tc-2',
              name: 'read_file',
              argumentsJson: '{"path":"/tmp/data.json"}',
            }),
          ],
        }),
        create(MessageSchema, {
          id: 'msg-2',
          role: 'tool',
          content: '{"ok":true}',
          toolCallId: 'tc-1',
        }),
      ],
    });

    const input = protoDeliverTurnToInput(request);

    expect(input.turnId).toBe('turn-7');
    expect(input.messages).toHaveLength(2);
    expect(input.messages[0]).toMatchObject({
      id: 'msg-1',
      agentId: '',
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'tc-1',
          name: 'search',
          arguments: { query: 'ctxmill', filters: ['tests'] },
        },
        {
          id: 'tc-2',
          name: 'read_file',
          arguments: { path: '/tmp/data.json' },
        },
      ],
    });
    expect(input.messages[1]).toMatchObject({
      id: 'msg-2',
      role: 'tool',
      content: '{"ok":true}',
      toolCallId: 'tc-1',
    });
    expect(input.messages[0].createdAt).toBeInstanceOf(Date);
  });

  it('throws a descriptive error when tool call arguments are malformed JSON', () => {
    const request = create(DeliverTurnRequestSchema, {
      sessionId: 'session-123',
      turnId: 'turn-bad',
      messages: [
        create(MessageSchema, {
          id: 'msg-bad',
          role: 'assistant',
          content: '',
          toolCalls: [
            create(ToolCallSchema, {
              id: 'tc-bad',
              name: 'broken',
              argumentsJson: '{nope',
            }),
          ],
        }),
      ],
    });

    expect(() => protoDeliverTurnToInput(request)).toThrow(
      /Failed to parse JSON for tool call broken arguments/,
    );
  });
});

describe('agentEventToSessionEvent and messageToCommittedEvent', () => {
  it('wraps standard agent events in the agUiEvent payload case', () => {
    const events: Array<{
      event: AgentEvent;
      expectedCase: string | undefined;
      assert: (payload: ProtoAgentEvent) => void;
    }> = [
      {
        event: { type: 'text_delta', content: 'Hello\nworld' },
        expectedCase: 'textDelta',
        assert: (payload) => {
          if (payload.event.case !== 'textDelta') {
            throw new Error('Expected textDelta payload');
          }
          expect(payload.event.value.content).toBe('Hello\nworld');
        },
      },
      {
        event: {
          type: 'tool_call_start',
          id: 'tc-1',
          name: 'search',
          args: { query: 'ctxmill', limit: 3 },
        },
        expectedCase: 'toolCallStart',
        assert: (payload) => {
          if (payload.event.case !== 'toolCallStart') {
            throw new Error('Expected toolCallStart payload');
          }
          expect(payload.event.value).toMatchObject({
            id: 'tc-1',
            name: 'search',
            argsJson: '{"query":"ctxmill","limit":3}',
          });
        },
      },
      {
        event: {
          type: 'tool_call_end',
          id: 'tc-1',
          result: 'found 2',
          error: 'timeout warning',
          durationMs: 1500,
        },
        expectedCase: 'toolCallEnd',
        assert: (payload) => {
          if (payload.event.case !== 'toolCallEnd') {
            throw new Error('Expected toolCallEnd payload');
          }
          expect(payload.event.value.id).toBe('tc-1');
          expect(payload.event.value.result).toBe('found 2');
          expect(payload.event.value.error).toBe('timeout warning');
          expect(payload.event.value.durationMs).toBe(1500n);
        },
      },
      {
        event: {
          type: 'approval_needed',
          id: 'approval-1',
          tool: 'delete-file',
          args: '{"path":"/tmp/demo"}',
        },
        expectedCase: 'approvalNeeded',
        assert: (payload) => {
          if (payload.event.case !== 'approvalNeeded') {
            throw new Error('Expected approvalNeeded payload');
          }
          expect(payload.event.value).toMatchObject({
            id: 'approval-1',
            toolName: 'delete-file',
            argsJson: '{"path":"/tmp/demo"}',
          });
        },
      },
      {
        event: { type: 'approval_resolved', id: 'approval-1', action: 'reject' },
        expectedCase: 'approvalResolved',
        assert: (payload) => {
          if (payload.event.case !== 'approvalResolved') {
            throw new Error('Expected approvalResolved payload');
          }
          expect(payload.event.value).toMatchObject({
            id: 'approval-1',
            action: 'reject',
          });
        },
      },
      {
        event: { type: 'error', error: 'runtime exploded' },
        expectedCase: 'error',
        assert: (payload) => {
          if (payload.event.case !== 'error') {
            throw new Error('Expected error payload');
          }
          expect(payload.event.value).toMatchObject({
            message: 'runtime exploded',
            category: 'runtime',
          });
        },
      },
      {
        event: {
          type: 'done',
          result: 'complete',
          usage: {
            inputTokens: 100,
            outputTokens: 55,
            totalTokens: 155,
          },
        },
        expectedCase: 'done',
        assert: (payload) => {
          if (payload.event.case !== 'done') {
            throw new Error('Expected done payload');
          }
          expect(payload.event.value.result).toBe('complete');
          expect(payload.event.value.interrupted).toBe(false);
          expect(payload.event.value.usage).toMatchObject({
            inputTokens: 100n,
            outputTokens: 55n,
            totalTokens: 155n,
          });
        },
      },
      {
        event: {
          type: 'message_committed',
          role: 'assistant',
          content: 'Stored separately',
          turnId: 'turn-ignored',
          messageSeq: 9,
        },
        expectedCase: undefined,
        assert: (payload) => {
          expect(payload.event.case).toBeUndefined();
        },
      },
    ];

    for (const entry of events) {
      const converted = agentEventToSessionEvent(entry.event, 99, 'turn-outer');
      const payload = getAgUiPayload(converted);
      expect(payload.event.case).toBe(entry.expectedCase);
      entry.assert(payload);
    }
  });

  it('emits messageCommitted payloads with serialized tool calls and explicit turn sequencing', () => {
    const event: Extract<AgentEvent, { type: 'message_committed' }> = {
      type: 'message_committed',
      role: 'assistant',
      content: 'Answer ready',
      toolCallId: 'tc-2',
      turnId: 'turn-inner',
      messageSeq: 41,
      toolCalls: [
        {
          id: 'tc-1',
          name: 'search',
          arguments: { query: 'ctxmill' },
        },
        {
          id: 'tc-2',
          name: 'raw',
          arguments: { already: 'encoded' },
        },
      ],
    };

    const converted = messageToCommittedEvent(event, 'turn-42', 42);

    expect(converted.payload.case).toBe('messageCommitted');
    if (converted.payload.case !== 'messageCommitted') {
      throw new Error('Expected messageCommitted payload');
    }

    expect(converted.payload.value).toMatchObject({
      role: 'assistant',
      content: 'Answer ready',
      toolCallId: 'tc-2',
      turnId: 'turn-42',
      messageSeq: 42n,
    });
    expect(converted.payload.value.toolCalls).toEqual([
      {
        $typeName: 'ctxmill.sandbox.v1.ToolCall',
        id: 'tc-1',
        name: 'search',
        argumentsJson: '{"query":"ctxmill"}',
      },
      {
        $typeName: 'ctxmill.sandbox.v1.ToolCall',
        id: 'tc-2',
        name: 'raw',
        argumentsJson: '{"already":"encoded"}',
      },
    ]);
  });
});

describe('sessionCheckpointToProto and protoSessionCheckpointToInternal', () => {
  it('round-trips complete checkpoint state including bigint cursor sequencing', () => {
    const checkpoint = makeSessionCheckpoint({
      cursor: {
        nextMessageSeq: Number.MAX_SAFE_INTEGER,
        lastCompletedTurnId: 'turn-max',
      },
    });

    const protoCheckpoint = sessionCheckpointToProto(checkpoint);
    const roundTrip = protoSessionCheckpointToInternal(protoCheckpoint);

    expect(protoCheckpoint.cursor?.nextMessageSeq).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    expect(roundTrip).toEqual(checkpoint);
  });

  it('fills internal defaults when proto checkpoint omits optional nested messages', () => {
    const checkpoint = protoSessionCheckpointToInternal(
      create(SessionCheckpointSchema, {
        checkpointVersion: 1,
        sessionId: 'session-empty',
        conversationId: 'conv-empty',
        harnessName: 'openai',
      }),
    );

    expect(checkpoint).toEqual({
      checkpointVersion: 1,
      sessionId: 'session-empty',
      conversationId: 'conv-empty',
      harnessName: 'openai',
      cursor: {
        nextMessageSeq: 0,
        lastCompletedTurnId: undefined,
      },
      runnerState: {
        status: 'idle',
        pendingRequests: [],
      },
      workspaceRef: {
        strategy: 'none',
        reference: '',
      },
      harnessState: {},
    });
  });
});

describe('protoToToolDefs', () => {
  it('reconstructs zod schemas for sandbox tools with nested enums, patterns, and array constraints', () => {
    const tools = protoToToolDefs([
      makeProtoToolMetadata(
        'create-chart',
        'Create a chart',
        {
          type: 'object',
          properties: {
            title: { type: 'string', pattern: '^[A-Z].+' },
            type: { type: 'string', enum: ['bar', 'line'] },
            points: {
              type: 'array',
              items: { type: 'number' },
              minItems: 1,
              maxItems: 3,
            },
          },
          required: ['title', 'type', 'points'],
        },
      ),
    ]);

    const schema = getZodInput(tools[0]);

    expect(schema.safeParse({
      title: 'Revenue',
      type: 'bar',
      points: [1, 2, 3],
    }).success).toBe(true);
    expect(schema.safeParse({
      title: 'revenue',
      type: 'bar',
      points: [1],
    }).success).toBe(false);
    expect(schema.safeParse({
      title: 'Revenue',
      type: 'pie',
      points: [1],
    }).success).toBe(false);
    expect(schema.safeParse({
      title: 'Revenue',
      type: 'line',
      points: [],
    }).success).toBe(false);
  });

  it('uses fallback handlers for sandbox and disconnected orchestrator tools', async () => {
    const definitions = protoToToolDefs([
      makeProtoToolMetadata(
        'read-file',
        'Read a file',
        {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        ToolLocation.SANDBOX,
      ),
      makeProtoToolMetadata(
        'emit-event',
        'Emit event',
        {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        ToolLocation.ORCHESTRATOR,
      ),
    ]);

    await expect(definitions[0].handler({ path: '/tmp/file' }, TOOL_CONTEXT)).resolves.toContain(
      'handled by the harness SDK',
    );
    await expect(definitions[1].handler({ name: 'session.ready' }, TOOL_CONTEXT)).resolves.toContain(
      'not yet connected',
    );
  });

  it('wires a real orchestrator proxy when client and routing metadata are provided', async () => {
    const requestTool = vi.fn<OrchestratorServiceClient['requestTool']>().mockResolvedValue({
      $typeName: 'ctxmill.sandbox.v1.RequestToolResponse',
      requestId: 'req-1',
      result: '{"delivered":true}',
      error: undefined,
    });
    const client: OrchestratorServiceClient = { requestTool };

    const [definition] = protoToToolDefs(
      [
        makeProtoToolMetadata(
          'emit-event',
          'Emit event',
          {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
          ToolLocation.ORCHESTRATOR,
        ),
      ],
      {
        orchestratorClient: client,
        runId: 'run-123',
        agentId: 'agent-123',
      },
    );

    await expect(definition.handler({ name: 'turn.completed' }, TOOL_CONTEXT)).resolves.toBe(
      '{"delivered":true}',
    );
    expect(requestTool).toHaveBeenCalledTimes(1);

    const [request] = requestTool.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      runId: 'run-123',
      agentId: 'agent-123',
      toolName: 'emit-event',
      argsJson: '{"name":"turn.completed"}',
    });
    expect(request.requestId).toMatch(/^rpc-/);
  });

  it('throws a descriptive error for malformed JSON schemas', () => {
    const tools = [
      create(ToolMetadataSchema, {
        name: 'broken',
        description: 'broken schema',
        inputSchemaJson: '{not valid json',
        location: ToolLocation.SANDBOX,
      }),
    ];

    expect(() => protoToToolDefs(tools)).toThrow(
      /Failed to parse JSON for tool broken input schema/,
    );
  });
});
