import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockStreamEvents = vi.fn();
const mockCreateDeepAgent = vi.fn(() => ({
  streamEvents: mockStreamEvents,
}));
const mockLcTool = vi.fn((_fn: unknown, _opts: unknown) => ({}));
const mockChatOpenAI = vi.fn();
const mockLocalShellBackend = vi.fn();

class MockChatOpenAI {
  constructor(...args: unknown[]) {
    mockChatOpenAI(...args);
  }
}

class MockLocalShellBackend {
  constructor(...args: unknown[]) {
    mockLocalShellBackend(...args);
  }
}

const DEEPAGENTS_MODULE_ID = 'file:///path/to/stablehand/node_modules/.pnpm/deepagents@1.8.1_@opentelemetry+api@1.9.0_openai@6.27.0_ws@8.19.0_zod@4.3.6__react-dom@_220e5e351a3af6f29d5ecee1bbd1c2a4/node_modules/deepagents/dist/index.js';
const LANGCHAIN_TOOLS_MODULE_ID = 'file:///path/to/stablehand/node_modules/.pnpm/@langchain+core@1.1.31_@opentelemetry+api@1.9.0_openai@6.27.0_ws@8.19.0_zod@4.3.6_/node_modules/@langchain/core/dist/tools/index.js';
const LANGCHAIN_OPENAI_MODULE_ID = 'file:///path/to/stablehand/node_modules/.pnpm/@langchain+openai@1.2.12_@langchain+core@1.1.31_@opentelemetry+api@1.9.0_openai@6.27.0_ws@8.19.0_zod@4.3.6___ws@8.19.0/node_modules/@langchain/openai/dist/index.js';

import type { AgentEvent, HarnessSessionConfig } from '../../packages/ctxmill/src/harness/types.js';
import type { Message } from '../../packages/ctxmill/src/types.js';

function makeMessage(role: Message['role'], content: string): Message {
  return {
    id: `${role}-${content}`,
    agentId: 'agent-1',
    role,
    content,
    createdAt: new Date(),
  };
}

function makeConfig(overrides: Partial<HarnessSessionConfig> = {}): HarnessSessionConfig {
  return {
    systemPrompt: 'You are a test agent.',
    tools: [],
    secrets: { openai: 'test-key' },
    agentId: 'agent-1',
    conversationId: 'conversation-1',
    workspaceDir: '/tmp/workspace',
    harnessConfigJson: JSON.stringify({
      model: 'gpt-5.4-mini',
      provider: 'openai',
      apiKeyRef: 'openai',
    }),
    ...overrides,
  };
}

async function collectEvents(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function* langGraphStream(events: Array<Record<string, unknown>>) {
  for (const event of events) {
    yield event;
  }
}

function isCommittedWithToolCalls(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: 'message_committed' }> & {
  toolCalls: NonNullable<Message['toolCalls']>;
} {
  return event.type === 'message_committed' && Array.isArray(event.toolCalls);
}

function getCommittedWithToolCalls(
  events: AgentEvent[],
): Extract<AgentEvent, { type: 'message_committed' }> & {
  toolCalls: NonNullable<Message['toolCalls']>;
} {
  const committed = events.find(isCommittedWithToolCalls);
  if (!committed) {
    throw new Error('Expected a message_committed event with toolCalls.');
  }

  return committed;
}

async function openTestSession(config: HarnessSessionConfig = makeConfig()) {
  vi.resetModules();
  const deepagentsMock = () => ({
    __esModule: true,
    createDeepAgent: mockCreateDeepAgent,
    LocalShellBackend: MockLocalShellBackend,
  });
  const langchainToolsMock = () => ({
    __esModule: true,
    tool: mockLcTool,
  });
  const langchainOpenAiMock = () => ({
    __esModule: true,
    ChatOpenAI: MockChatOpenAI,
  });

  vi.doMock('deepagents', deepagentsMock);
  vi.doMock(DEEPAGENTS_MODULE_ID, deepagentsMock);
  vi.doMock('@langchain/core/tools', langchainToolsMock);
  vi.doMock(LANGCHAIN_TOOLS_MODULE_ID, langchainToolsMock);
  vi.doMock('@langchain/openai', langchainOpenAiMock);
  vi.doMock(LANGCHAIN_OPENAI_MODULE_ID, langchainOpenAiMock);

  const { LangGraphHarness } = await import('../../packages/sandbox-daemon/src/harness/langgraph.ts');
  const harness = new LangGraphHarness();
  const session = await harness.openSession(config);

  Reflect.set(session, 'buildModelFromConfig', async () => ({}));

  return { harness, session };
}

async function openRestoredTestSession(
  restore: { stateVersion: string; messages: Message[]; payload: Record<string, unknown> },
  config: HarnessSessionConfig = makeConfig(),
) {
  vi.resetModules();
  const deepagentsMock = () => ({
    __esModule: true,
    createDeepAgent: mockCreateDeepAgent,
    LocalShellBackend: MockLocalShellBackend,
  });
  const langchainToolsMock = () => ({
    __esModule: true,
    tool: mockLcTool,
  });
  const langchainOpenAiMock = () => ({
    __esModule: true,
    ChatOpenAI: MockChatOpenAI,
  });

  vi.doMock('deepagents', deepagentsMock);
  vi.doMock(DEEPAGENTS_MODULE_ID, deepagentsMock);
  vi.doMock('@langchain/core/tools', langchainToolsMock);
  vi.doMock(LANGCHAIN_TOOLS_MODULE_ID, langchainToolsMock);
  vi.doMock('@langchain/openai', langchainOpenAiMock);
  vi.doMock(LANGCHAIN_OPENAI_MODULE_ID, langchainOpenAiMock);

  const { LangGraphHarness } = await import('../../packages/sandbox-daemon/src/harness/langgraph.ts');
  const harness = new LangGraphHarness();
  const session = await harness.openSession(config, restore);

  Reflect.set(session, 'buildModelFromConfig', async () => ({}));

  return { harness, session };
}

describe('LangGraphHarness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateDeepAgent.mockReturnValue({
      streamEvents: mockStreamEvents,
    });
  });

  it('should have name "langgraph"', async () => {
    const { harness } = await openTestSession();
    expect(harness.name).toBe('langgraph');
  });

  it('openSession with restore populates transcript from payload.transcript', async () => {
    mockStreamEvents.mockImplementation(() => langGraphStream([
      {
        event: 'on_chat_model_stream',
        data: { chunk: { content: 'Done.' } },
      },
    ]));

    const restoredMessage = makeMessage('assistant', 'Restored reply');
    const userMessage = makeMessage('user', 'Continue');
    const { session } = await openRestoredTestSession({
      stateVersion: '1',
      messages: [],
      payload: { transcript: [restoredMessage] },
    });

    await collectEvents(session.deliverTurn({
      messages: [userMessage],
      turnId: 'turn-restored',
    }, {}));

    await expect(session.exportState()).resolves.toEqual({
      stateVersion: '1',
      payload: {
        transcript: [
          restoredMessage,
          userMessage,
          expect.objectContaining({ role: 'assistant', content: 'Done.' }),
        ],
      },
    });
  });

  it('openSession with restore falls back to restore.messages when payload has no transcript', async () => {
    mockStreamEvents.mockImplementation(() => langGraphStream([
      {
        event: 'on_chat_model_stream',
        data: { chunk: { content: 'Fallback done.' } },
      },
    ]));

    const restoredMessage = makeMessage('assistant', 'Fallback restored reply');
    const userMessage = makeMessage('user', 'Continue fallback');
    const { session } = await openRestoredTestSession({
      stateVersion: '1',
      messages: [restoredMessage],
      payload: {},
    });

    await collectEvents(session.deliverTurn({
      messages: [userMessage],
      turnId: 'turn-fallback',
    }, {}));

    await expect(session.exportState()).resolves.toEqual({
      stateVersion: '1',
      payload: {
        transcript: [
          restoredMessage,
          userMessage,
          expect.objectContaining({ role: 'assistant', content: 'Fallback done.' }),
        ],
      },
    });
  });

  it('includes a single tool call in message_committed events', async () => {
    mockStreamEvents.mockImplementation(() => langGraphStream([
      {
        event: 'on_chat_model_stream',
        data: {
          chunk: {
            content: '',
            tool_call_chunks: [{ id: 'call_1', name: 'weather', args: '{"city":"NYC"}' }],
          },
        },
      },
      {
        event: 'on_tool_start',
        data: { name: 'weather', input: { city: 'NYC' } },
        run_id: 'run_1',
      },
      {
        event: 'on_tool_end',
        data: { output: 'Sunny' },
        run_id: 'run_1',
      },
      {
        event: 'on_chat_model_stream',
        data: { chunk: { content: 'Done.' } },
      },
    ]));

    const { session } = await openTestSession();
    const events = await collectEvents(session.deliverTurn({
      messages: [makeMessage('user', 'What is the weather?')],
      turnId: 'turn-1',
    }, {}));

    const committed = getCommittedWithToolCalls(events);

    expect(committed.content).toBe('Done.');
    expect(committed.toolCalls).toHaveLength(1);
    expect(committed.toolCalls).toEqual([
      expect.objectContaining({
        id: 'call_1',
        name: 'weather',
        arguments: { city: 'NYC' },
        status: 'complete',
      }),
    ]);
  });

  it('includes multiple tool calls in message_committed events', async () => {
    mockStreamEvents.mockImplementation(() => langGraphStream([
      {
        event: 'on_chat_model_stream',
        data: {
          chunk: {
            content: '',
            tool_call_chunks: [
              { id: 'call_1', name: 'weather', args: '{"city":"NYC"}' },
              { id: 'call_2', name: 'calendar', args: '{"date":"2026-03-26"}' },
            ],
          },
        },
      },
      {
        event: 'on_tool_start',
        data: { name: 'weather', input: { city: 'NYC' } },
        run_id: 'run_1',
      },
      {
        event: 'on_tool_end',
        data: { output: 'Sunny' },
        run_id: 'run_1',
      },
      {
        event: 'on_tool_start',
        data: { name: 'calendar', input: { date: '2026-03-26' } },
        run_id: 'run_2',
      },
      {
        event: 'on_tool_end',
        data: { output: 'Busy' },
        run_id: 'run_2',
      },
      {
        event: 'on_chat_model_stream',
        data: { chunk: { content: 'Done with both.' } },
      },
    ]));

    const { session } = await openTestSession();
    const events = await collectEvents(session.deliverTurn({
      messages: [makeMessage('user', 'Check weather and calendar')],
      turnId: 'turn-2',
    }, {}));

    const committed = getCommittedWithToolCalls(events);

    expect(committed.content).toBe('Done with both.');
    expect(committed.toolCalls).toHaveLength(2);
    expect(committed.toolCalls).toEqual([
      expect.objectContaining({ id: 'call_1', name: 'weather', status: 'complete' }),
      expect.objectContaining({ id: 'call_2', name: 'calendar', status: 'complete' }),
    ]);
  });

  it('marks tool calls as error when on_tool_error is emitted', async () => {
    mockStreamEvents.mockImplementation(() => langGraphStream([
      {
        event: 'on_chat_model_stream',
        data: {
          chunk: {
            content: '',
            tool_call_chunks: [{ id: 'call_1', name: 'weather', args: '{"city":"NYC"}' }],
          },
        },
      },
      {
        event: 'on_tool_start',
        data: { name: 'weather', input: { city: 'NYC' } },
        run_id: 'run_1',
      },
      {
        event: 'on_tool_error',
        data: { error: new Error('boom') },
        run_id: 'run_1',
      },
      {
        event: 'on_chat_model_stream',
        data: { chunk: { content: 'Failed.' } },
      },
    ]));

    const { session } = await openTestSession();
    const events = await collectEvents(session.deliverTurn({
      messages: [makeMessage('user', 'What is the weather?')],
      turnId: 'turn-3',
    }, {}));

    const committed = getCommittedWithToolCalls(events);

    expect(committed.content).toBe('Failed.');
    expect(committed.toolCalls).toHaveLength(1);
    expect(committed.toolCalls).toEqual([
      expect.objectContaining({
        id: 'call_1',
        name: 'weather',
        arguments: { city: 'NYC' },
        status: 'error',
      }),
    ]);
  });

  it('emits message_committed for tool-only turns', async () => {
    mockStreamEvents.mockImplementation(() => langGraphStream([
      {
        event: 'on_chat_model_stream',
        data: {
          chunk: {
            content: '',
            tool_call_chunks: [{ id: 'call_1', name: 'weather', args: '{"city":"NYC"}' }],
          },
        },
      },
      {
        event: 'on_tool_start',
        data: { name: 'weather', input: { city: 'NYC' } },
        run_id: 'run_1',
      },
      {
        event: 'on_tool_end',
        data: { output: 'Sunny' },
        run_id: 'run_1',
      },
    ]));

    const { session } = await openTestSession();
    const events = await collectEvents(session.deliverTurn({
      messages: [makeMessage('user', 'Use the weather tool only')],
      turnId: 'turn-4',
    }, {}));

    const committed = getCommittedWithToolCalls(events);

    expect(committed.content).toBe('');
    expect(committed.toolCalls).toHaveLength(1);
    expect(committed.toolCalls).toEqual([
      expect.objectContaining({
        id: 'call_1',
        name: 'weather',
        arguments: { city: 'NYC' },
        status: 'complete',
      }),
    ]);
  });
});
