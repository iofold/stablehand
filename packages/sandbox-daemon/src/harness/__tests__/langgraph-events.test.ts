import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockStreamEvents = vi.fn();
const mockCreateDeepAgent = vi.fn(() => ({
  streamEvents: mockStreamEvents,
}));
const mockLcTool = vi.fn((_fn: unknown, _opts: unknown) => ({}));
const mockChatOpenAI = vi.fn();
const mockChatGoogleGenerativeAI = vi.fn();
const mockLocalShellBackend = vi.fn();

class MockChatOpenAI {
  constructor(...args: unknown[]) {
    mockChatOpenAI(...args);
  }
}

class MockChatGoogleGenerativeAI {
  constructor(...args: unknown[]) {
    mockChatGoogleGenerativeAI(...args);
  }
}

class MockLocalShellBackend {
  constructor(...args: unknown[]) {
    mockLocalShellBackend(...args);
  }
}

vi.mock('deepagents', () => ({
  __esModule: true,
  createDeepAgent: mockCreateDeepAgent,
  LocalShellBackend: MockLocalShellBackend,
}));

vi.mock('@langchain/core/tools', () => ({
  __esModule: true,
  tool: mockLcTool,
}));

vi.mock('@langchain/openai', () => ({
  __esModule: true,
  ChatOpenAI: MockChatOpenAI,
}));

vi.mock('@langchain/google-genai', () => ({
  __esModule: true,
  ChatGoogleGenerativeAI: MockChatGoogleGenerativeAI,
}));

import type { AgentEvent, HarnessSessionConfig } from '@ctxmill/sandbox-daemon';
import type { Message } from '@ctxmill/sandbox-daemon';

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

function createMockChatModel() {
  return {
    getName: () => 'mock-model',
    _llmType: () => 'mock',
    bindTools: vi.fn(function bindTools(this: object) {
      return this;
    }),
    invoke: vi.fn(async () => ({ content: '' })),
    stream: vi.fn(async function* () {
      yield { content: '' };
    }),
  };
}

function createMockDeepAgentsModule() {
  return {
    createDeepAgent: mockCreateDeepAgent,
    LocalShellBackend: MockLocalShellBackend,
  };
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
  const { LangGraphHarness } = await import('../langgraph.js');
  const harness = new LangGraphHarness();
  const session = await harness.openSession(config);

  Reflect.set(session, 'buildModelFromConfig', async () => createMockChatModel());
  Reflect.set(session, 'loadDeepAgentsModule', async () => createMockDeepAgentsModule());

  return { harness, session };
}

async function openRestoredTestSession(
  restore: { stateVersion: string; messages: Message[]; payload: Record<string, unknown> },
  config: HarnessSessionConfig = makeConfig(),
) {
  vi.resetModules();
  const { LangGraphHarness } = await import('../langgraph.js');
  const harness = new LangGraphHarness();
  const session = await harness.openSession(config, restore);

  Reflect.set(session, 'buildModelFromConfig', async () => createMockChatModel());
  Reflect.set(session, 'loadDeepAgentsModule', async () => createMockDeepAgentsModule());

  return { harness, session };
}

describe('LangGraphHarness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    mockCreateDeepAgent.mockReturnValue({
      streamEvents: mockStreamEvents,
    });
  });

  it('should have name "langgraph"', async () => {
    const { harness } = await openTestSession();
    expect(harness.name).toBe('langgraph');
  });

  it('resolves Google model auth from GEMINI_API_KEY', async () => {
    process.env.GEMINI_API_KEY = 'gemini-env-key';
    vi.resetModules();
    const { LangGraphHarness } = await import('../langgraph.js');
    const harness = new LangGraphHarness();
    const session = await harness.openSession(makeConfig({
      secrets: {},
      harnessConfigJson: JSON.stringify({
        model: 'gemini-2.5-flash',
        provider: 'google',
      }),
    }));

    const buildModelForConfig = Reflect.get(session, 'buildModelForConfig') as (config: {
      provider: 'google';
      model: string;
    }, secrets: Record<string, string>) => Promise<unknown>;
    await buildModelForConfig.call(session, {
      provider: 'google',
      model: 'gemini-2.5-flash',
    }, {});

    expect(mockChatGoogleGenerativeAI).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'gemini-env-key',
      model: 'gemini-2.5-flash',
    }));
  });

  it('uses native Google gateway transport with opaque turn correlation', async () => {
    vi.resetModules();
    const { LangGraphHarness } = await import('../langgraph.js');
    const session = await new LangGraphHarness().openSession(makeConfig({
      secrets: {
        CTXMILL_MODEL_GATEWAY_ENABLED: 'true',
        CTXMILL_MODEL_GATEWAY_URL: 'http://litellm:4000',
        CTXMILL_MODEL_GATEWAY_RUNTIME_KEY: 'runtime-key',
        CTXMILL_MODEL_GATEWAY_REVISION: 'dev1-1',
      },
      harnessConfigJson: JSON.stringify({
        model: 'gemini-2.5-flash',
        provider: 'google',
      }),
    }));

    const buildModelForConfig = Reflect.get(session, 'buildModelForConfig') as (config: {
      provider: 'google';
      model: string;
    }, secrets: Record<string, string>, turnId: string) => Promise<unknown>;
    await buildModelForConfig.call(session, {
      provider: 'google',
      model: 'gemini-2.5-flash',
    }, {
      CTXMILL_MODEL_GATEWAY_ENABLED: 'true',
      CTXMILL_MODEL_GATEWAY_URL: 'http://litellm:4000',
      CTXMILL_MODEL_GATEWAY_RUNTIME_KEY: 'runtime-key',
      CTXMILL_MODEL_GATEWAY_REVISION: 'dev1-1',
    }, 'sensitive-google-turn');

    expect(mockChatGoogleGenerativeAI).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'runtime-key',
      baseUrl: 'http://litellm:4000',
      customHeaders: {
        'x-litellm-trace-id': expect.stringMatching(/^ct_[a-f0-9]{32}$/),
        'x-litellm-spend-logs-metadata': expect.any(String),
      },
      model: 'gemini-2.5-flash',
    }));
    expect(JSON.stringify(mockChatGoogleGenerativeAI.mock.calls.at(-1))).not.toContain(
      'sensitive-google-turn',
    );
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
      messages: [restoredMessage, userMessage],
      turnId: 'turn-restored',
    }, {}));

    await expect(session.exportState()).resolves.toEqual({
      stateVersion: '2',
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
      messages: [restoredMessage, userMessage],
      turnId: 'turn-fallback',
    }, {}));

    await expect(session.exportState()).resolves.toEqual({
      stateVersion: '2',
      payload: {
        transcript: [
          restoredMessage,
          userMessage,
          expect.objectContaining({ role: 'assistant', content: 'Fallback done.' }),
        ],
      },
    });
  });

  it('replays assistant tool_calls before matching tool result messages', async () => {
    const observedMessages: unknown[] = [];
    mockStreamEvents.mockImplementation((input) => {
      observedMessages.push(input.messages);
      return langGraphStream([
        {
          event: 'on_chat_model_stream',
          data: { chunk: { content: 'Continued.' } },
        },
      ]);
    });

    const userMessage = makeMessage('user', 'Emit an event');
    const assistantMessage: Message = {
      ...makeMessage('assistant', ''),
      id: 'assistant-with-tool-call',
      toolCalls: [
        {
          id: 'call_1',
          name: 'emit-event',
          arguments: { type: 'audit', payload: { ok: true } },
        },
      ],
    };
    const toolMessage: Message = {
      ...makeMessage('tool', 'emitted'),
      id: 'tool-result',
      toolCallId: 'call_1',
    };
    const nextUserMessage = makeMessage('user', 'Continue');

    const { session } = await openRestoredTestSession({
      stateVersion: '1',
      messages: [userMessage, assistantMessage, toolMessage],
      payload: {},
    });

    await collectEvents(session.deliverTurn({
      messages: [userMessage, assistantMessage, toolMessage, nextUserMessage],
      turnId: 'turn-replay-tools',
    }, {}));

    expect(observedMessages[0]).toEqual([
      { role: 'user', content: 'Emit an event' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'emit-event',
              arguments: '{"type":"audit","payload":{"ok":true}}',
            },
          },
        ],
      },
      { role: 'tool', content: 'emitted', tool_call_id: 'call_1' },
      { role: 'user', content: 'Continue' },
    ]);
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

  it('sums terminal usage once per LangChain model run', async () => {
    const firstEnd = {
      event: 'on_chat_model_end',
      run_id: 'model-call-1',
      data: {
        output: {
          usage_metadata: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
          },
        },
      },
    };
    mockStreamEvents.mockImplementation(() => langGraphStream([
      {
        event: 'on_chat_model_stream',
        run_id: 'model-call-1',
        data: { chunk: { content: '' } },
      },
      firstEnd,
      firstEnd,
      {
        event: 'on_chat_model_stream',
        run_id: 'model-call-2',
        data: { chunk: { content: 'Done.' } },
      },
      {
        event: 'on_chat_model_end',
        run_id: 'model-call-2',
        data: {
          output: {
            usage_metadata: {
              input_tokens: 20,
              output_tokens: 7,
              total_tokens: 27,
            },
          },
        },
      },
    ]));

    const { session } = await openTestSession();
    const events = await collectEvents(session.deliverTurn({
      messages: [makeMessage('user', 'Use a tool, then answer')],
      turnId: 'turn-usage',
    }, {}));
    const done = events.find(
      (event): event is Extract<AgentEvent, { type: 'done' }> => event.type === 'done',
    );

    expect(done?.usage).toEqual({
      inputTokens: 30,
      outputTokens: 12,
      totalTokens: 42,
    });
  });
});
