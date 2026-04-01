import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSessionService } from '../../packages/ctxmill/src/orchestrator/agent-session-service.js';
import type { AgentDefinition, Message } from '../../packages/ctxmill/src/types.js';
import type { AGUIEvent, MessageCommittedEvent } from '../../packages/shared/src/events.js';
import { createTestDb, type TestDb } from '../utils/test-db.js';
import { TestSessionRegistry, createTestSessionManager } from '../utils/test-session-registry.js';

type StreamEvent = AGUIEvent | MessageCommittedEvent;

async function* eventStream(events: readonly StreamEvent[]) {
  for (const event of events) {
    yield event;
  }
}

function makeAgentDef(): AgentDefinition {
  return {
    name: 'test-agent',
    harness: 'langgraph',
    harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
    systemPrompt: 'You are a test agent. {{knowledge}}',
    tools: ['search', 'weather'],
  };
}

function makeMessages(agentId: string): Message[] {
  return [
    {
      id: 'user-msg-1',
      agentId,
      role: 'user',
      content: 'Hello',
      createdAt: new Date('2026-03-21T00:00:00.000Z'),
    },
  ];
}

function makeCommittedEvent(
  overrides: Partial<MessageCommittedEvent> = {},
): MessageCommittedEvent {
  return {
    type: 'MESSAGE_COMMITTED',
    timestamp: 1,
    runId: 'run-1',
    role: 'assistant',
    content: 'Final response',
    turnId: 'run-1',
    messageSeq: 1,
    ...overrides,
  };
}

describe('AgentRunService message persistence integration', () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
  }, 30_000);

  afterEach(async () => {
    await testDb?.close();
  }, 30_000);

  async function executeAndReadMessages(events: StreamEvent[]) {
    const agent = await testDb.repo.createAgent({
      name: 'message-persistence-agent',
      harness: 'langgraph',
      harnessConfig: JSON.stringify({ provider: 'openai', model: 'gpt-5.4-mini' }),
      systemPrompt: 'You are a test agent.',
      tools: ['search', 'weather'],
    });
    const conversation = await testDb.repo.createConversation(agent.id);
    const run = await testDb.repo.createTurn({
      agentId: agent.id,
      conversationId: conversation.id,
      mode: 'interactive',
      taskDescription: 'message persistence test',
    });
    const sandboxSession = await testDb.repo.createSandboxSession({
      conversationId: conversation.id,
      agentId: agent.id,
      harnessName: agent.harness,
    });
    const sessionRegistry = new TestSessionRegistry();

    const service = new AgentSessionService({
      sessionTurnService: {
        executeSessionTurn: vi.fn().mockReturnValue(eventStream(events)),
      } as never,
      sse: {
        broadcast: vi.fn(),
      } as never,
      db: testDb.repo,
      sessionManager: createTestSessionManager(sessionRegistry, { sessionId: sandboxSession.id }) as never,
    });

    await service.executeSession({
      agentDef: makeAgentDef(),
      messages: makeMessages(agent.id),
      agentId: agent.id,
      conversationId: conversation.id,
      sessionId: run.id,
      mode: 'interactive',
      taskDescription: 'message persistence test',
    });

    return testDb.repo.getMessages(conversation.id);
  }

  it('persists messages in OpenAI standard format with interleaved tool calls', async () => {
    const messages = await executeAndReadMessages([
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'm1', content: 'Let me check.' },
      { type: 'TOOL_CALL_START', timestamp: 2, runId: 'run-1', toolCallId: 'tc1', toolName: 'search' },
      { type: 'TOOL_CALL_ARGS', timestamp: 3, runId: 'run-1', toolCallId: 'tc1', args: '{"q":"test"}' },
      { type: 'TOOL_CALL_END', timestamp: 4, runId: 'run-1', toolCallId: 'tc1' },
      { type: 'TOOL_CALL_RESULT', timestamp: 5, runId: 'run-1', toolCallId: 'tc1', result: 'Found 3 results', toolName: 'search' },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 6, runId: 'run-1', messageId: 'm1', content: 'Based on the results:' },
      makeCommittedEvent({ timestamp: 7, content: 'Based on the results:' }),
      { type: 'RUN_FINISHED', timestamp: 8, runId: 'run-1' },
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Let me check.',
      toolCalls: [
        {
          id: 'tc1',
          name: 'search',
          args: '{"q":"test"}',
          status: 'complete',
        },
      ],
    });
    expect(messages[1]).toMatchObject({
      role: 'tool',
      toolCallId: 'tc1',
      content: 'Found 3 results',
    });
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      content: 'Based on the results:',
    });
  });

  it('persists parallel tool calls correctly', async () => {
    const messages = await executeAndReadMessages([
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'm1', content: 'Checking both.' },
      { type: 'TOOL_CALL_START', timestamp: 2, runId: 'run-1', toolCallId: 'tc1', toolName: 'search' },
      { type: 'TOOL_CALL_ARGS', timestamp: 3, runId: 'run-1', toolCallId: 'tc1', args: '{"q":"alpha"}' },
      { type: 'TOOL_CALL_START', timestamp: 4, runId: 'run-1', toolCallId: 'tc2', toolName: 'weather' },
      { type: 'TOOL_CALL_ARGS', timestamp: 5, runId: 'run-1', toolCallId: 'tc2', args: '{"city":"SF"}' },
      { type: 'TOOL_CALL_END', timestamp: 6, runId: 'run-1', toolCallId: 'tc1' },
      { type: 'TOOL_CALL_END', timestamp: 7, runId: 'run-1', toolCallId: 'tc2' },
      { type: 'TOOL_CALL_RESULT', timestamp: 8, runId: 'run-1', toolCallId: 'tc1', result: 'Alpha result', toolName: 'search' },
      { type: 'TOOL_CALL_RESULT', timestamp: 9, runId: 'run-1', toolCallId: 'tc2', result: 'Sunny, 72°F', toolName: 'weather' },
      makeCommittedEvent({ timestamp: 10, content: '' }),
      { type: 'RUN_FINISHED', timestamp: 11, runId: 'run-1' },
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Checking both.',
    });
    expect(messages[0].toolCalls).toEqual([
      {
        id: 'tc1',
        name: 'search',
        args: '{"q":"alpha"}',
        status: 'complete',
      },
      {
        id: 'tc2',
        name: 'weather',
        args: '{"city":"SF"}',
        status: 'complete',
      },
    ]);
    expect(messages[1]).toMatchObject({ role: 'tool', toolCallId: 'tc1', content: 'Alpha result' });
    expect(messages[2]).toMatchObject({ role: 'tool', toolCallId: 'tc2', content: 'Sunny, 72°F' });
  });

  it('simple text response without tools persists as a single assistant message', async () => {
    const messages = await executeAndReadMessages([
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'm1', content: 'Hello world' },
      makeCommittedEvent({ timestamp: 2, content: 'Hello world' }),
      { type: 'RUN_FINISHED', timestamp: 3, runId: 'run-1' },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Hello world',
      toolCallId: null,
      toolCalls: null,
    });
  });
});
