import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSessionConfig } from '../types.js';
import type { Message } from '../../types.js';

const mockStreamEvents = vi.fn();
const mockCreateDeepAgent = vi.fn(() => ({
  streamEvents: mockStreamEvents,
}));

class MockLocalShellBackend {
  constructor(..._args: unknown[]) {}
}

function makeMessage(role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return {
    id: `${role}-${content}`,
    agentId: 'agent-1',
    role,
    content,
    createdAt: new Date(),
    ...extra,
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

async function collectEvents(stream: AsyncGenerator<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
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

async function openRestoredTestSession(
  restore: { stateVersion: string; messages: Message[]; payload: Record<string, unknown> },
  config: HarnessSessionConfig = makeConfig(),
) {
  vi.resetModules();
  const { LangGraphHarness } = await import('../langgraph.js');
  const harness = new LangGraphHarness();
  const session = await harness.openSession(config, restore);

  Reflect.set(session, 'buildModelFromConfig', async () => createMockChatModel());
  Reflect.set(session, 'loadDeepAgentsModule', async () => ({
    createDeepAgent: mockCreateDeepAgent,
    LocalShellBackend: MockLocalShellBackend,
  }));

  return session;
}

describe('LangGraphHarness message history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateDeepAgent.mockReturnValue({
      streamEvents: mockStreamEvents,
    });
  });

  it('passes restored tool and system messages through to streamEvents', async () => {
    mockStreamEvents.mockImplementation(() => langGraphStream([
      {
        event: 'on_chat_model_stream',
        data: { chunk: { content: 'Done.' } },
      },
    ]));

    const restoredMessages = [
      makeMessage('system', 'System context'),
      makeMessage('user', 'Use the tool'),
      makeMessage('assistant', 'Calling the tool now'),
      makeMessage('tool', 'Tool output: success', { toolCallId: 'call_1' }),
      makeMessage('user', 'Continue from that result'),
    ];

    const session = await openRestoredTestSession({
      stateVersion: '1',
      messages: restoredMessages,
      payload: { transcript: restoredMessages },
    });

    await collectEvents(session.deliverTurn({
      messages: restoredMessages,
      turnId: 'turn-restored-tool-history',
    }, {}));

    expect(mockCreateDeepAgent).toHaveBeenCalledWith(expect.not.objectContaining({
      systemPrompt: expect.anything(),
    }));

    expect(mockStreamEvents).toHaveBeenCalledWith({
      messages: [
        { role: 'system', content: 'System context' },
        { role: 'user', content: 'Use the tool' },
        { role: 'assistant', content: 'Calling the tool now' },
        { role: 'tool', content: 'Tool output: success', tool_call_id: 'call_1' },
        { role: 'user', content: 'Continue from that result' },
      ],
    }, { version: 'v2' });
  });

  it('still passes config systemPrompt when transcript has no system message', async () => {
    mockStreamEvents.mockImplementation(() => langGraphStream([]));

    const messages = [makeMessage('user', 'Hello')];
    const session = await openRestoredTestSession({
      stateVersion: '1',
      messages,
      payload: { transcript: messages },
    });

    await collectEvents(session.deliverTurn({ messages, turnId: 'turn-no-system' }, {}));

    expect(mockCreateDeepAgent).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: 'You are a test agent.',
    }));
  });
});
