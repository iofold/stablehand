import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageShape,
} from '../../packages/proto/node_modules/@bufbuild/protobuf/dist/esm/index.js';
import { describe, expect, it } from 'vitest';

import {
  AgentEventSchema,
  CursorSchema,
  DeliverTurnRequestSchema,
  FreshBootstrapSchema,
  KillSessionRequestSchema,
  KillSessionResponseSchema,
  MessageCommittedSchema,
  MessageSchema,
  OpenSessionRequestSchema,
  OpenSessionResponseSchema,
  PendingRequestSchema,
  RestoreBootstrapSchema,
  RunnerStateSchema,
  SessionCheckpointSchema,
  SessionEventSchema,
  SuspendSessionRequestSchema,
  SuspendSessionResponseSchema,
  ToolCallSchema,
  ToolLocation,
  ToolMetadataSchema,
  TurnCompletedSchema,
  TurnFailedSchema,
  WorkspaceRefSchema,
} from '../../packages/proto/gen/ctxmill/sandbox/v1/sandbox_pb.js';

function expectRoundTrip<Desc extends DescMessage>(schema: Desc, value: MessageShape<Desc>): MessageShape<Desc> {
  const bytes = toBinary(schema, value);
  const decoded = fromBinary(schema, bytes);
  expect(decoded).toStrictEqual(value);
  return decoded;
}

describe('proto v2 sandbox roundtrip', () => {
  it('round-trips FreshBootstrap', () => {
    const message = create(FreshBootstrapSchema, {
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      harnessName: 'openai',
      harnessConfigJson: '{"maxTurns":4}',
      systemPrompt: 'You are helpful.',
      tools: [
        create(ToolMetadataSchema, {
          name: 'search',
          description: 'Search docs',
          inputSchemaJson: '{"type":"object"}',
          location: ToolLocation.ORCHESTRATOR,
        }),
      ],
      workspaceDir: '/tmp/workspace',
    });

    expectRoundTrip(FreshBootstrapSchema, message);
  });

  it('round-trips RestoreBootstrap', () => {
    const message = create(RestoreBootstrapSchema, {
      sessionCheckpoint: create(SessionCheckpointSchema, {
        checkpointVersion: 2,
        sessionId: 'session-1',
        conversationId: 'conversation-1',
        harnessName: 'claude',
        cursor: { nextMessageSeq: 5n, lastCompletedTurnId: 'turn-4' },
        runnerState: {
          status: 'WAITING_INPUT',
          pendingRequests: [
            { type: 'tool_call', id: 'req-1', payloadJson: '{"name":"search"}' },
          ],
        },
        workspaceRef: { strategy: 'tar', reference: 's3://bucket/archive.tar' },
        harnessState: { phase: 'paused', nested: { attempt: 2 } },
      }),
      tools: [
        create(ToolMetadataSchema, {
          name: 'search',
          description: 'Search docs',
          inputSchemaJson: '{"type":"object"}',
          location: ToolLocation.ORCHESTRATOR,
          programmatic: true,
        }),
      ],
      agentId: 'agent-restore',
      harnessConfigJson: '{"model":"claude-sonnet-4-6"}',
      systemPrompt: 'Restore prompt',
    });

    const decoded = expectRoundTrip(RestoreBootstrapSchema, message);
    expect(decoded.tools).toHaveLength(1);
    expect(decoded.tools[0]?.name).toBe('search');
    expect(decoded.tools[0]?.programmatic).toBe(true);
    expect(decoded.agentId).toBe('agent-restore');
    expect(decoded.harnessConfigJson).toBe('{"model":"claude-sonnet-4-6"}');
    expect(decoded.systemPrompt).toBe('Restore prompt');
  });

  it('round-trips OpenSessionRequest with fresh bootstrap', () => {
    const message = create(OpenSessionRequestSchema, {
      bootstrap: {
        case: 'fresh',
        value: create(FreshBootstrapSchema, {
          agentId: 'agent-2',
          conversationId: 'conversation-2',
          harnessName: 'claude',
          harnessConfigJson: '{}',
          systemPrompt: 'Act carefully.',
          tools: [],
          workspaceDir: '/workspace',
        }),
      },
    });

    const decoded = expectRoundTrip(OpenSessionRequestSchema, message);
    expect(decoded.bootstrap.case).toBe('fresh');
  });

  it('round-trips FreshBootstrap without model_config field', () => {
    const message = create(FreshBootstrapSchema, {
      agentId: 'agent-3',
      conversationId: 'conversation-3',
      harnessName: 'langgraph',
      harnessConfigJson: '{"provider":"openai","model":"gpt-5.4-mini"}',
      systemPrompt: 'No model config field.',
      tools: [],
      workspaceDir: '/workspace',
    });

    const decoded = expectRoundTrip(FreshBootstrapSchema, message);
    expect(decoded.harnessConfigJson).toBe('{"provider":"openai","model":"gpt-5.4-mini"}');
  });

  it('round-trips OpenSessionRequest with restore bootstrap', () => {
    const message = create(OpenSessionRequestSchema, {
      bootstrap: {
        case: 'restore',
        value: create(RestoreBootstrapSchema, {
          sessionCheckpoint: {
            checkpointVersion: 2,
            sessionId: 'session-restore',
            conversationId: 'conversation-restore',
            harnessName: 'openai',
            cursor: { nextMessageSeq: 9n },
            runnerState: { status: 'IDLE', pendingRequests: [] },
            workspaceRef: { strategy: 'git', reference: 'abc123' },
            harnessState: { restored: true },
          },
          tools: [
            create(ToolMetadataSchema, {
              name: 'emit-event',
              description: 'Emit event',
              inputSchemaJson: '{"type":"object"}',
              location: ToolLocation.ORCHESTRATOR,
            }),
          ],
          agentId: 'agent-open-restore',
          harnessConfigJson: '{"model":"gpt-5.4-mini"}',
          systemPrompt: 'Recovered system prompt',
        }),
      },
    });

    const decoded = expectRoundTrip(OpenSessionRequestSchema, message);
    expect(decoded.bootstrap.case).toBe('restore');
    if (decoded.bootstrap.case !== 'restore') {
      throw new Error('Expected restore bootstrap');
    }
    expect(decoded.bootstrap.value.tools[0]?.name).toBe('emit-event');
    expect(decoded.bootstrap.value.agentId).toBe('agent-open-restore');
    expect(decoded.bootstrap.value.harnessConfigJson).toBe('{"model":"gpt-5.4-mini"}');
    expect(decoded.bootstrap.value.systemPrompt).toBe('Recovered system prompt');
  });

  it('round-trips OpenSessionResponse', () => {
    expectRoundTrip(OpenSessionResponseSchema, create(OpenSessionResponseSchema, {
      sessionId: 'session-3',
      status: 'OPEN',
    }));
  });

  it('round-trips DeliverTurnRequest', () => {
    const message = create(DeliverTurnRequestSchema, {
      sessionId: 'session-4',
      turnId: 'turn-1',
      messages: [
        create(MessageSchema, {
          id: 'msg-1',
          role: 'user',
          content: 'hello',
          toolCalls: [],
        }),
      ],
    });

    expectRoundTrip(DeliverTurnRequestSchema, message);
  });

  it('round-trips MessageCommitted with empty tool calls', () => {
    expectRoundTrip(MessageCommittedSchema, create(MessageCommittedSchema, {
      role: 'assistant',
      content: 'done',
      toolCalls: [],
      turnId: 'turn-2',
      messageSeq: 1n,
    }));
  });

  it('round-trips MessageCommitted with multiple tool calls', () => {
    const message = create(MessageCommittedSchema, {
      role: 'assistant',
      content: 'I used tools.',
      toolCalls: [
        create(ToolCallSchema, {
          id: 'call-1',
          name: 'search',
          argumentsJson: '{"query":"ctxmill"}',
        }),
        create(ToolCallSchema, {
          id: 'call-2',
          name: 'fetch',
          argumentsJson: '{"url":"https://example.com"}',
        }),
      ],
      toolCallId: 'call-2',
      turnId: 'turn-3',
      messageSeq: 2n,
    });

    expectRoundTrip(MessageCommittedSchema, message);
  });

  it('round-trips TurnCompleted', () => {
    expectRoundTrip(TurnCompletedSchema, create(TurnCompletedSchema, {
      turnId: 'turn-4',
    }));
  });

  it('round-trips TurnFailed', () => {
    expectRoundTrip(TurnFailedSchema, create(TurnFailedSchema, {
      turnId: 'turn-5',
      errorMessage: 'tool crashed',
    }));
  });

  it('round-trips SuspendSessionRequest', () => {
    expectRoundTrip(SuspendSessionRequestSchema, create(SuspendSessionRequestSchema, {
      sessionId: 'session-5',
      reason: 'waiting for approval',
    }));
  });

  it('round-trips Cursor', () => {
    expectRoundTrip(CursorSchema, create(CursorSchema, {
      nextMessageSeq: 12n,
      lastCompletedTurnId: 'turn-6',
    }));
  });

  it('round-trips PendingRequest', () => {
    expectRoundTrip(PendingRequestSchema, create(PendingRequestSchema, {
      type: 'approval',
      id: 'approval-1',
      payloadJson: '{"tool":"delete_file"}',
    }));
  });

  it('round-trips RunnerState with empty pending requests', () => {
    expectRoundTrip(RunnerStateSchema, create(RunnerStateSchema, {
      status: 'IDLE',
      pendingRequests: [],
    }));
  });

  it('round-trips RunnerState with multiple pending requests', () => {
    expectRoundTrip(RunnerStateSchema, create(RunnerStateSchema, {
      status: 'WAITING_INPUT',
      pendingRequests: [
        { type: 'tool_call', id: 'tool-1', payloadJson: '{"name":"search"}' },
        { type: 'approval', id: 'approval-2', payloadJson: '{"action":"resume"}' },
      ],
    }));
  });

  it('round-trips WorkspaceRef', () => {
    expectRoundTrip(WorkspaceRefSchema, create(WorkspaceRefSchema, {
      strategy: 'none',
      reference: '',
    }));
  });

  it('round-trips SessionCheckpoint', () => {
    const message = create(SessionCheckpointSchema, {
      checkpointVersion: 2,
      sessionId: 'session-6',
      conversationId: 'conversation-6',
      harnessName: 'pi-agent',
      cursor: create(CursorSchema, {
        nextMessageSeq: 20n,
        lastCompletedTurnId: 'turn-7',
      }),
      runnerState: create(RunnerStateSchema, {
        status: 'WAITING_INPUT',
        pendingRequests: [
          create(PendingRequestSchema, {
            type: 'tool_call',
            id: 'pending-1',
            payloadJson: '{"name":"lookup"}',
          }),
          create(PendingRequestSchema, {
            type: 'approval',
            id: 'pending-2',
            payloadJson: '{"approved":false}',
          }),
        ],
      }),
      workspaceRef: create(WorkspaceRefSchema, {
        strategy: 'git',
        reference: 'deadbeef',
      }),
      harnessState: {
        status: 'paused',
        counters: { turns: 3, retries: 1 },
        queue: ['one', 'two'],
      },
    });

    expectRoundTrip(SessionCheckpointSchema, message);
  });

  it('round-trips SuspendSessionResponse', () => {
    expectRoundTrip(SuspendSessionResponseSchema, create(SuspendSessionResponseSchema, {
      sessionCheckpoint: {
        checkpointVersion: 2,
        sessionId: 'session-7',
        conversationId: 'conversation-7',
        harnessName: 'pi',
        cursor: { nextMessageSeq: 1n },
        runnerState: { status: 'IDLE', pendingRequests: [] },
        workspaceRef: { strategy: 'tar', reference: 'archive-7' },
        harnessState: { ok: true },
      },
    }));
  });

  it('round-trips KillSessionRequest', () => {
    expectRoundTrip(KillSessionRequestSchema, create(KillSessionRequestSchema, {
      sessionId: 'session-8',
      reason: 'shutdown',
    }));
  });

  it('round-trips KillSessionResponse', () => {
    expectRoundTrip(KillSessionResponseSchema, create(KillSessionResponseSchema, {
      finalStatus: 'KILLED',
    }));
  });

  it('round-trips SessionEvent with ag_ui_event payload', () => {
    const message = create(SessionEventSchema, {
      payload: {
        case: 'agUiEvent',
        value: create(AgentEventSchema, {
          event: {
            case: 'textDelta',
            value: { content: 'streaming' },
          },
        }),
      },
    });

    const decoded = expectRoundTrip(SessionEventSchema, message);
    expect(decoded.payload.case).toBe('agUiEvent');
  });

  it('round-trips SessionEvent with message_committed payload', () => {
    const message = create(SessionEventSchema, {
      payload: {
        case: 'messageCommitted',
        value: create(MessageCommittedSchema, {
          role: 'assistant',
          content: 'committed',
          toolCalls: [],
          turnId: 'turn-9',
          messageSeq: 9n,
        }),
      },
    });

    const decoded = expectRoundTrip(SessionEventSchema, message);
    expect(decoded.payload.case).toBe('messageCommitted');
  });

  it('round-trips SessionEvent with turn_completed payload', () => {
    const message = create(SessionEventSchema, {
      payload: {
        case: 'turnCompleted',
        value: create(TurnCompletedSchema, { turnId: 'turn-10' }),
      },
    });

    const decoded = expectRoundTrip(SessionEventSchema, message);
    expect(decoded.payload.case).toBe('turnCompleted');
  });

  it('round-trips SessionEvent with turn_failed payload', () => {
    const message = create(SessionEventSchema, {
      payload: {
        case: 'turnFailed',
        value: create(TurnFailedSchema, {
          turnId: 'turn-11',
          errorMessage: 'boom',
        }),
      },
    });

    const decoded = expectRoundTrip(SessionEventSchema, message);
    expect(decoded.payload.case).toBe('turnFailed');
  });
});
