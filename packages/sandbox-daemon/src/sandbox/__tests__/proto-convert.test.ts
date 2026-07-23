import { create } from '@bufbuild/protobuf';
import {
  CursorSchema,
  DeliverTurnRequestSchema,
  FreshBootstrapSchema,
  MessageSchema,
  NativeToolPolicy,
  NativeToolPolicyConfigSchema,
  PendingRequestSchema,
  RestoreBootstrapSchema,
  RunnerStateSchema,
  SessionCheckpointSchema,
  ToolCallSchema,
  ToolLocation,
  ToolMetadataSchema,
  TurnDeliveryCapabilitySchema,
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
import type { SessionCheckpoint as InternalSessionCheckpoint } from '../checkpoint.js';
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

function makeFreshBootstrap(overrides: Partial<FreshBootstrap> = {}): FreshBootstrap {
  return create(FreshBootstrapSchema, {
    agentId: 'agent-123',
    conversationId: 'conv-456',
    harnessName: 'openai',
    harnessConfigJson: '{"mode":"json"}',
    systemPrompt: 'You are a focused sandbox harness.',
    tools: [],
    workspaceDir: '/tmp/workspace',
    sessionId: 'session-123',
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
      status: 'WAITING_INPUT',
      pendingRequests: [
        {
          type: 'approval',
          id: 'req-1',
          payload: { tool: 'delete-file' },
        },
        {
          type: 'tool_call',
          id: 'req-2',
          payload: { tool: 'emit-event' },
        },
      ],
    },
    workspaceRef: {
      strategy: 'tar',
      reference: '/overlay/session-123',
    },
    harnessState: {
      stateVersion: '1',
      payload: {
        nested: {
          ok: true,
          count: 3,
        },
        labels: ['alpha', 'beta'],
      },
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

function getAgentEventPayload(
  sessionEvent: ReturnType<typeof agentEventToSessionEvent>,
): ProtoAgentEvent {
  if (sessionEvent.payload.case !== 'agentEvent') {
    throw new Error('Expected agentEvent payload');
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

  it.each([
    ['all', NativeToolPolicy.ALL, [], { policy: 'all' }],
    ['allow', NativeToolPolicy.ALLOW, ['Read', 'Glob'], { policy: 'allow', names: ['Read', 'Glob'] }],
    ['deny', NativeToolPolicy.DENY, ['Bash'], { policy: 'deny', names: ['Bash'] }],
    ['none', NativeToolPolicy.NONE, [], { policy: 'none' }],
  ])('preserves the canonical %s native-tool policy', (_label, policy, names, expected) => {
    const config = protoFreshBootstrapToSessionConfig(
      makeFreshBootstrap({
        nativeToolPolicy: create(NativeToolPolicyConfigSchema, {
          policy,
          names,
        }),
      }),
      [],
      {},
    );

    expect(config.nativeToolPolicy).toEqual(expected);
  });

  it('rejects an unspecified native-tool policy instead of guessing', () => {
    expect(() => protoFreshBootstrapToSessionConfig(
      makeFreshBootstrap({
        nativeToolPolicy: create(NativeToolPolicyConfigSchema, {
          policy: NativeToolPolicy.UNSPECIFIED,
        }),
      }),
      [],
      {},
    )).toThrow('Native tool policy is unspecified');
  });

  it('rejects an unknown native-tool policy enum instead of dropping the policy', () => {
    expect(() => protoFreshBootstrapToSessionConfig(
      makeFreshBootstrap({
        nativeToolPolicy: create(NativeToolPolicyConfigSchema, {
          policy: 99 as NativeToolPolicy,
        }),
      }),
      [],
      {},
    )).toThrow('Unknown native tool policy value: 99');
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
      turnSecrets: {
        PILOT_TURN_OWNERSHIP_TOKEN: 'must-remain-outside-harness-input',
      },
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
    expect(input).not.toHaveProperty('turnSecrets');
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
  it('encodes every agentEvent variant with the expected nested payload', () => {
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
          args: '{"query":"ctxmill"}',
        },
        expectedCase: 'toolCallStart',
        assert: (payload) => {
          if (payload.event.case !== 'toolCallStart') {
            throw new Error('Expected toolCallStart payload');
          }
          expect(payload.event.value).toMatchObject({
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
          args: { path: '/tmp/demo', recursive: true },
        },
        expectedCase: 'approvalNeeded',
        assert: (payload) => {
          if (payload.event.case !== 'approvalNeeded') {
            throw new Error('Expected approvalNeeded payload');
          }
          expect(payload.event.value).toMatchObject({
            id: 'approval-1',
            toolName: 'delete-file',
            argsJson: '{"path":"/tmp/demo","recursive":true}',
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
        event: {
          type: 'custom_agui_event',
          event: {
            type: 'CUSTOM',
            timestamp: 1,
            runId: '',
            subtype: 'claude_hook',
            lifecycle: 'response',
            hookEvent: 'Stop',
            outcome: 'success',
            output: '{"decision":"block"}',
          },
        },
        expectedCase: 'custom',
        assert: (payload) => {
          if (payload.event.case !== 'custom') {
            throw new Error('Expected custom payload');
          }
          expect(payload.event.value.subtype).toBe('claude_hook');
          expect(JSON.parse(payload.event.value.payloadJson)).toMatchObject({
            subtype: 'claude_hook',
            lifecycle: 'response',
            hookEvent: 'Stop',
            outcome: 'success',
            output: '{"decision":"block"}',
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
            costUsd: 0.0045,
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
            costUsd: 0.0045,
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
      const converted = agentEventToSessionEvent(entry.event);
      const payload = getAgentEventPayload(converted);
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

  it('serializes bigint event arguments and harness state as strings', () => {
    const toolEvent = agentEventToSessionEvent({
      type: 'tool_call_start',
      id: 'tc-bigint',
      name: 'search',
      args: {
        sequence: 9007199254740993n,
      },
    });
    const approvalEvent = agentEventToSessionEvent({
      type: 'approval_needed',
      id: 'approval-bigint',
      tool: 'delete-file',
      args: {
        limit: 9007199254740995n,
      },
    });
    const checkpoint = sessionCheckpointToProto(
      makeSessionCheckpoint({
        harnessState: {
          stateVersion: '1',
          payload: {
            checkpointSeq: 9007199254740997n,
            nested: {
              values: [1n, 2n],
            },
          },
        },
      }),
    );

    const toolPayload = getAgentEventPayload(toolEvent);
    const approvalPayload = getAgentEventPayload(approvalEvent);

    expect(toolPayload.event.case).toBe('toolCallStart');
    if (toolPayload.event.case !== 'toolCallStart') {
      throw new Error('Expected toolCallStart payload');
    }
    expect(toolPayload.event.value.argsJson).toBe('{"sequence":"9007199254740993"}');

    expect(approvalPayload.event.case).toBe('approvalNeeded');
    if (approvalPayload.event.case !== 'approvalNeeded') {
      throw new Error('Expected approvalNeeded payload');
    }
    expect(approvalPayload.event.value.argsJson).toBe('{"limit":"9007199254740995"}');

    expect(checkpoint.harnessState).toEqual({
      stateVersion: '1',
      payload: {
        checkpointSeq: '9007199254740997',
        nested: {
          values: ['1', '2'],
        },
      },
    });
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
        checkpointVersion: 2,
        sessionId: 'session-empty',
        conversationId: 'conv-empty',
        harnessName: 'openai',
      }),
    );

    expect(checkpoint).toEqual({
      checkpointVersion: 2,
      sessionId: 'session-empty',
      conversationId: 'conv-empty',
      harnessName: 'openai',
      cursor: {
        nextMessageSeq: 0,
        lastCompletedTurnId: undefined,
      },
      runnerState: {
        status: 'IDLE',
        pendingRequests: undefined,
      },
      workspaceRef: {
        strategy: 'none',
        reference: '',
      },
      harnessState: {
        stateVersion: '1',
        payload: {},
      },
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

  it('fails fast for disconnected orchestrator tools and direct sandbox handlers', async () => {
    const sandboxDefinitions = protoToToolDefs([
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
    ]);

    await expect(sandboxDefinitions[0].handler({ path: '/tmp/file' }, TOOL_CONTEXT)).rejects.toThrow(
      'handled by the harness SDK',
    );

    expect(() => protoToToolDefs([
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
    ])).toThrow(/proxy for "emit-event" is not connected/i);
  });

  it('wires a real orchestrator proxy when client and routing metadata are provided', async () => {
    const requestTool = vi.fn<OrchestratorServiceClient['requestTool']>().mockResolvedValue({
      $typeName: 'ctxmill.sandbox.v1.RequestToolResponse',
      requestId: 'req-1',
      result: '{"delivered":true}',
      error: undefined,
    });
    const registerArtifact = vi.fn<OrchestratorServiceClient['registerArtifact']>();
    const resolveArtifact = vi.fn<OrchestratorServiceClient['resolveArtifact']>();
    const client: OrchestratorServiceClient = { requestTool, registerArtifact, resolveArtifact };
    const leaseExpiresAtMs = Date.now() + 60_000;
    const deliveryContext = {
      identity: {
        turnId: 'run-123',
        sandboxSessionId: 'sandbox-session-123',
        agentId: 'agent-123',
        ownerId: 'owner-123',
        fenceToken: 1,
        restoreFenceToken: 0,
        containerId: 'container-123',
      },
      capability: create(TurnDeliveryCapabilitySchema, {
        ownerId: 'owner-123',
        fenceToken: 1n,
        leaseExpiresAtMs: BigInt(leaseExpiresAtMs),
        restoreFenceToken: 0n,
        containerId: 'container-123',
        agentId: 'agent-123',
        signature: 'ctxmill-open-turn-delivery-capability-v1',
      }),
      leaseExpiresAtMs,
      abortController: new AbortController(),
    };

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
        callbackRoute: {
          sandboxSessionId: 'sandbox-session-123',
          agentId: 'agent-123',
          resolveDeliveryContext: () => deliveryContext,
        },
      },
    );

    await expect(definition.handler({ name: 'turn.completed' }, TOOL_CONTEXT)).resolves.toBe(
      '{"delivered":true}',
    );
    expect(requestTool).toHaveBeenCalledTimes(1);

    const [request] = requestTool.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      turnId: 'run-123',
      sandboxSessionId: 'sandbox-session-123',
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
