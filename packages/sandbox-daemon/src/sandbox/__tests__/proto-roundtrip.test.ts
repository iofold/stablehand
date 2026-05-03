import { create } from '@bufbuild/protobuf';
import {
  CursorSchema,
  DeliverTurnRequestSchema,
  FreshBootstrapSchema,
  MessageSchema,
  PendingRequestSchema,
  RequestToolResponseSchema,
  RestoreBootstrapSchema,
  RunnerStateSchema,
  SessionCheckpointSchema,
  ToolCallSchema,
  ToolLocation,
  ToolMetadataSchema,
  WorkspaceRefSchema,
  type FreshBootstrap,
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
};

function makeToolDefinition(name = 'search'): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    input: {},
    handler: async () => JSON.stringify({ ok: true }),
  };
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

function makeFreshBootstrap(overrides: Partial<FreshBootstrap> = {}): FreshBootstrap {
  return create(FreshBootstrapSchema, {
    agentId: 'agent-rt',
    conversationId: 'conv-rt',
    harnessName: 'openai',
    harnessConfigJson: '{"session":true}',
    systemPrompt: 'Round-trip harness prompt',
    tools: [],
    workspaceDir: '/workspace/session',
    sessionId: 'session-rt',
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
    checkpointVersion: 5,
    sessionId: 'session-rt',
    conversationId: 'conv-rt',
    harnessName: 'openai',
    cursor: {
      nextMessageSeq: 88,
      lastCompletedTurnId: 'turn-87',
    },
    runnerState: {
      status: 'running',
      pendingRequests: [
        {
          type: 'approval',
          id: 'approval-1',
          payloadJson: '{"tool":"delete-file","path":"/tmp/demo"}',
        },
        {
          type: 'tool',
          id: 'tool-1',
          payloadJson: '{"name":"emit-event","args":{"name":"ready"}}',
        },
      ],
    },
    workspaceRef: {
      strategy: 'overlay',
      reference: '/overlay/session-rt',
    },
    harnessState: {
      nested: {
        retries: 2,
        flags: ['warm', 'ready'],
      },
      topLevel: 'ok',
    },
    ...overrides,
  };
}

function makeProtoCheckpoint(
  overrides: Partial<ProtoSessionCheckpoint> = {},
): ProtoSessionCheckpoint {
  return create(SessionCheckpointSchema, {
    checkpointVersion: 9,
    sessionId: 'session-restore',
    conversationId: 'conv-restore',
    harnessName: 'claude',
    cursor: create(CursorSchema, {
      nextMessageSeq: 123n,
      lastCompletedTurnId: 'turn-122',
    }),
    runnerState: create(RunnerStateSchema, {
      status: 'suspended',
      pendingRequests: [
        create(PendingRequestSchema, {
          type: 'approval',
          id: 'ap-9',
          payloadJson: '{"id":"ap-9"}',
        }),
      ],
    }),
    workspaceRef: create(WorkspaceRefSchema, {
      strategy: 'bind',
      reference: '/workspace/restore',
    }),
    harnessState: {
      recovery: 'checkpoint',
      step: 4,
    },
    ...overrides,
  });
}

describe('session bootstrap and restore converters', () => {
  it('preserves fresh bootstrap fields through session config conversion', () => {
    const secrets: ResolvedSecrets = {
      OPENAI_API_KEY: 'sk-openai',
      EXTRA: 'value',
    };
    const tools = [makeToolDefinition('search'), makeToolDefinition('emit-event')];

    const config = protoFreshBootstrapToSessionConfig(
      makeFreshBootstrap(),
      tools,
      secrets,
    );

    expect(config).toMatchObject({
      agentId: 'agent-rt',
      conversationId: 'conv-rt',
      systemPrompt: 'Round-trip harness prompt',
      workspaceDir: '/workspace/session',
      harnessConfigJson: '{"session":true}',
      tools,
      secrets,
    });
  });

  it('preserves deliver-turn message content, tool calls, and tool call ids', () => {
    const deliverTurn = create(DeliverTurnRequestSchema, {
      sessionId: 'session-rt',
      turnId: 'turn-100',
      messages: [
        create(MessageSchema, {
          id: 'msg-user',
          role: 'user',
          content: 'Please summarize this file.',
        }),
        create(MessageSchema, {
          id: 'msg-assistant',
          role: 'assistant',
          content: '',
          toolCalls: [
            create(ToolCallSchema, {
              id: 'tc-1',
              name: 'read_file',
              argumentsJson: '{"path":"/tmp/report.md","encoding":"utf8"}',
            }),
            create(ToolCallSchema, {
              id: 'tc-2',
              name: 'search',
              argumentsJson: '{"query":"quarterly results","limit":5}',
            }),
          ],
        }),
        create(MessageSchema, {
          id: 'msg-tool',
          role: 'tool',
          content: '{"content":"done"}',
          toolCallId: 'tc-1',
        }),
      ],
    });

    const input = protoDeliverTurnToInput(deliverTurn);

    expect(input.turnId).toBe('turn-100');
    expect(input.messages).toHaveLength(3);
    expect(input.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
    expect(input.messages[1].toolCalls).toEqual([
      {
        id: 'tc-1',
        name: 'read_file',
        arguments: { path: '/tmp/report.md', encoding: 'utf8' },
      },
      {
        id: 'tc-2',
        name: 'search',
        arguments: { query: 'quarterly results', limit: 5 },
      },
    ]);
    expect(input.messages[2].toolCallId).toBe('tc-1');
  });

  it('preserves restore checkpoint payloads through restore-point conversion', () => {
    const restore = create(RestoreBootstrapSchema, {
      sessionCheckpoint: makeProtoCheckpoint(),
    });

    const restorePoint = protoRestoreBootstrapToRestorePoint(restore);

    expect(restorePoint).toEqual({
      stateVersion: '9',
      payload: {
        recovery: 'checkpoint',
        step: 4,
      },
      messages: [],
    });
  });
});

describe('session event converters', () => {
  it('encodes every agUiEvent variant with the expected nested payload', () => {
    const cases: Array<{
      event: AgentEvent;
      expectedCase: string | undefined;
      assert: (sessionEvent: ReturnType<typeof agentEventToSessionEvent>) => void;
    }> = [
      {
        event: { type: 'text_delta', content: 'delta text' },
        expectedCase: 'textDelta',
        assert: (sessionEvent) => {
          if (sessionEvent.payload.case !== 'agUiEvent') {
            throw new Error('Expected agUiEvent payload');
          }
          if (sessionEvent.payload.value.event.case !== 'textDelta') {
            throw new Error('Expected textDelta payload');
          }
          expect(sessionEvent.payload.value.event.value.content).toBe('delta text');
        },
      },
      {
        event: {
          type: 'tool_call_start',
          id: 'tc-1',
          name: 'search',
          args: '{"query":"ctxmill"}',
        },
        expectedCase: 'toolCallStart',
        assert: (sessionEvent) => {
          if (sessionEvent.payload.case !== 'agUiEvent') {
            throw new Error('Expected agUiEvent payload');
          }
          if (sessionEvent.payload.value.event.case !== 'toolCallStart') {
            throw new Error('Expected toolCallStart payload');
          }
          expect(sessionEvent.payload.value.event.value).toMatchObject({
            id: 'tc-1',
            name: 'search',
            argsJson: '{"query":"ctxmill"}',
          });
        },
      },
      {
        event: {
          type: 'tool_call_end',
          id: 'tc-1',
          result: 'ok',
          durationMs: 250,
        },
        expectedCase: 'toolCallEnd',
        assert: (sessionEvent) => {
          if (sessionEvent.payload.case !== 'agUiEvent') {
            throw new Error('Expected agUiEvent payload');
          }
          if (sessionEvent.payload.value.event.case !== 'toolCallEnd') {
            throw new Error('Expected toolCallEnd payload');
          }
          expect(sessionEvent.payload.value.event.value.durationMs).toBe(250n);
        },
      },
      {
        event: {
          type: 'approval_needed',
          id: 'ap-1',
          tool: 'delete-file',
          args: { path: '/tmp/demo', recursive: true },
        },
        expectedCase: 'approvalNeeded',
        assert: (sessionEvent) => {
          if (sessionEvent.payload.case !== 'agUiEvent') {
            throw new Error('Expected agUiEvent payload');
          }
          if (sessionEvent.payload.value.event.case !== 'approvalNeeded') {
            throw new Error('Expected approvalNeeded payload');
          }
          expect(sessionEvent.payload.value.event.value.argsJson).toBe(
            '{"path":"/tmp/demo","recursive":true}',
          );
        },
      },
      {
        event: { type: 'approval_resolved', id: 'ap-1', action: 'approve' },
        expectedCase: 'approvalResolved',
        assert: (sessionEvent) => {
          if (sessionEvent.payload.case !== 'agUiEvent') {
            throw new Error('Expected agUiEvent payload');
          }
          if (sessionEvent.payload.value.event.case !== 'approvalResolved') {
            throw new Error('Expected approvalResolved payload');
          }
          expect(sessionEvent.payload.value.event.value.action).toBe('approve');
        },
      },
      {
        event: { type: 'error', error: 'boom' },
        expectedCase: 'error',
        assert: (sessionEvent) => {
          if (sessionEvent.payload.case !== 'agUiEvent') {
            throw new Error('Expected agUiEvent payload');
          }
          if (sessionEvent.payload.value.event.case !== 'error') {
            throw new Error('Expected error payload');
          }
          expect(sessionEvent.payload.value.event.value).toMatchObject({
            message: 'boom',
            category: 'runtime',
          });
        },
      },
      {
        event: {
          type: 'done',
          result: 'final',
          usage: {
            inputTokens: 500,
            outputTokens: 250,
            totalTokens: 750,
            cost: 0.0045,
          },
        },
        expectedCase: 'done',
        assert: (sessionEvent) => {
          if (sessionEvent.payload.case !== 'agUiEvent') {
            throw new Error('Expected agUiEvent payload');
          }
          if (sessionEvent.payload.value.event.case !== 'done') {
            throw new Error('Expected done payload');
          }
          expect(sessionEvent.payload.value.event.value.usage).toMatchObject({
            inputTokens: 500n,
            outputTokens: 250n,
            totalTokens: 750n,
            cost: 0.0045,
          });
        },
      },
      {
        event: {
          type: 'message_committed',
          role: 'assistant',
          content: 'stored elsewhere',
          turnId: 'turn-inner',
          messageSeq: 55,
        },
        expectedCase: undefined,
        assert: (sessionEvent) => {
          if (sessionEvent.payload.case !== 'agUiEvent') {
            throw new Error('Expected agUiEvent payload');
          }
          expect(sessionEvent.payload.value.event.case).toBeUndefined();
        },
      },
    ];

    cases.forEach((entry, _index) => {
      const sessionEvent = agentEventToSessionEvent(entry.event);

      expect(sessionEvent.payload.case).toBe('agUiEvent');
      if (sessionEvent.payload.case !== 'agUiEvent') {
        throw new Error('Expected agUiEvent payload');
      }
      expect(sessionEvent.payload.value.event.case).toBe(entry.expectedCase);
      entry.assert(sessionEvent);
    });
  });

  it('preserves message-committed content, tool calls, and bigint sequence numbers', () => {
    const sessionEvent = messageToCommittedEvent(
      {
        type: 'message_committed',
        role: 'assistant',
        content: 'Committed assistant response',
        toolCallId: 'tc-2',
        turnId: 'inner-turn',
        messageSeq: 87,
        toolCalls: [
          {
            id: 'tc-1',
            name: 'search',
            arguments: { query: 'q1 revenue' },
          },
          {
            id: 'tc-2',
            name: 'emit-event',
            arguments: { name: 'report.ready' },
          },
        ],
      },
      'outer-turn',
      Number.MAX_SAFE_INTEGER,
    );

    expect(sessionEvent.payload.case).toBe('messageCommitted');
    if (sessionEvent.payload.case !== 'messageCommitted') {
      throw new Error('Expected messageCommitted payload');
    }

    expect(sessionEvent.payload.value).toMatchObject({
      role: 'assistant',
      content: 'Committed assistant response',
      toolCallId: 'tc-2',
      turnId: 'outer-turn',
      messageSeq: BigInt(Number.MAX_SAFE_INTEGER),
    });
    expect(sessionEvent.payload.value.toolCalls).toEqual([
      {
        $typeName: 'ctxmill.sandbox.v1.ToolCall',
        id: 'tc-1',
        name: 'search',
        argumentsJson: '{"query":"q1 revenue"}',
      },
      {
        $typeName: 'ctxmill.sandbox.v1.ToolCall',
        id: 'tc-2',
        name: 'emit-event',
        argumentsJson: '{"name":"report.ready"}',
      },
    ]);
  });
});

describe('session checkpoint round-trips', () => {
  it('round-trips complex internal checkpoint state through proto conversion', () => {
    const internalCheckpoint = makeSessionCheckpoint({
      cursor: {
        nextMessageSeq: Number.MAX_SAFE_INTEGER,
        lastCompletedTurnId: 'turn-max',
      },
    });

    const protoCheckpoint = sessionCheckpointToProto(internalCheckpoint);
    const restored = protoSessionCheckpointToInternal(protoCheckpoint);

    expect(protoCheckpoint.cursor?.nextMessageSeq).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    expect(restored).toEqual(internalCheckpoint);
  });

  it('restores defaults for missing cursor, runner state, workspace ref, and harness state', () => {
    const restored = protoSessionCheckpointToInternal(
      create(SessionCheckpointSchema, {
        checkpointVersion: 1,
        sessionId: 'session-empty',
        conversationId: 'conv-empty',
        harnessName: 'openai',
      }),
    );

    expect(restored).toEqual({
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

describe('tool metadata conversions', () => {
  it('round-trips nested schemas into working validation rules', () => {
    const [tool] = protoToToolDefs([
      makeProtoToolMetadata('create-chart', 'Create chart', {
        type: 'object',
        properties: {
          chartType: { type: 'string', enum: ['bar', 'line'] },
          title: { type: 'string', pattern: '^[A-Z].+' },
          data: {
            type: 'object',
            properties: {
              labels: {
                type: 'array',
                items: { type: 'string' },
                minItems: 1,
              },
              values: {
                type: 'array',
                items: { type: 'number' },
                minItems: 1,
                maxItems: 3,
              },
            },
            required: ['labels', 'values'],
          },
        },
        required: ['chartType', 'title', 'data'],
      }),
    ]);

    const schema = getZodInput(tool);

    expect(schema.safeParse({
      chartType: 'bar',
      title: 'Revenue',
      data: {
        labels: ['Q1'],
        values: [100],
      },
    }).success).toBe(true);
    expect(schema.safeParse({
      chartType: 'pie',
      title: 'Revenue',
      data: {
        labels: ['Q1'],
        values: [100],
      },
    }).success).toBe(false);
    expect(schema.safeParse({
      chartType: 'line',
      title: 'revenue',
      data: {
        labels: ['Q1'],
        values: [100],
      },
    }).success).toBe(false);
    expect(schema.safeParse({
      chartType: 'line',
      title: 'Revenue',
      data: {
        labels: [],
        values: [100, 200, 300, 400],
      },
    }).success).toBe(false);
  });

  it('distinguishes sandbox fallbacks from wired orchestrator proxies', async () => {
    const requestTool = vi.fn<OrchestratorServiceClient['requestTool']>().mockResolvedValue(
      create(RequestToolResponseSchema, {
        requestId: 'rpc-1',
        result: '{"ok":true}',
      }),
    );
    const registerArtifact = vi.fn<OrchestratorServiceClient['registerArtifact']>();
    const resolveArtifact = vi.fn<OrchestratorServiceClient['resolveArtifact']>();
    const client: OrchestratorServiceClient = { requestTool, registerArtifact, resolveArtifact };

    const definitions = protoToToolDefs(
      [
        makeProtoToolMetadata(
          'read-file',
          'Read file',
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
      ],
      {
        orchestratorClient: client,
        sessionId: 'run-rt',
        agentId: 'agent-rt',
      },
    );

    await expect(definitions[0].handler({ path: '/tmp/demo' }, TOOL_CONTEXT)).rejects.toThrow(
      'handled by the harness SDK',
    );
    await expect(definitions[1].handler({ name: 'report.ready' }, TOOL_CONTEXT)).resolves.toBe(
      '{"ok":true}',
    );
    expect(requestTool).toHaveBeenCalledTimes(1);
    expect(requestTool.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'run-rt',
      agentId: 'agent-rt',
      toolName: 'emit-event',
      argsJson: '{"name":"report.ready"}',
    });
  });

  it('fails fast on malformed schema json', () => {
    const tools = [
      create(ToolMetadataSchema, {
        name: 'broken',
        description: 'bad json',
        inputSchemaJson: '{broken',
        location: ToolLocation.SANDBOX,
      }),
    ];

    expect(() => protoToToolDefs(tools)).toThrow(
      /Failed to parse JSON for tool broken input schema/,
    );
  });
});
