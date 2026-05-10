import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreateAgentSession = vi.fn();
const mockSetRuntimeApiKey = vi.fn();

vi.mock('@mariozechner/pi-coding-agent', () => ({
  createAgentSession: mockCreateAgentSession,
  SessionManager: {
    create: vi.fn((cwd: string) => ({ type: 'session-manager-file', cwd })),
    continueRecent: vi.fn((cwd: string) => ({ type: 'session-manager-continue', cwd })),
  },
  DefaultResourceLoader: vi.fn(function MockDefaultResourceLoader() {
    return {
      reload: vi.fn(async () => undefined),
    };
  }),
  SettingsManager: { inMemory: vi.fn(() => ({ type: 'settings-manager' })) },
  AuthStorage: { inMemory: vi.fn(() => ({ setRuntimeApiKey: mockSetRuntimeApiKey })) },
  ModelRegistry: vi.fn(function MockModelRegistry() {
    return { type: 'model-registry' };
  }),
  createCodingTools: vi.fn((cwd: string) => [{ name: 'coding-tools', cwd }]),
  createReadTool: vi.fn((cwd: string) => ({ name: 'read', cwd })),
  createBashTool: vi.fn((cwd: string) => ({ name: 'bash', cwd })),
  createEditTool: vi.fn((cwd: string) => ({ name: 'edit', cwd })),
  createWriteTool: vi.fn((cwd: string) => ({ name: 'write', cwd })),
  createGrepTool: vi.fn((cwd: string) => ({ name: 'grep', cwd })),
  createFindTool: vi.fn((cwd: string) => ({ name: 'find', cwd })),
  createLsTool: vi.fn((cwd: string) => ({ name: 'ls', cwd })),
}));

vi.mock('@mariozechner/pi-ai', async () => {
  const { Type } = await import('@sinclair/typebox');
  return {
    Type,
    getModel: vi.fn((provider: string, model: string) => ({
      provider,
      id: model,
      api: provider === 'google' ? 'google-generative-ai' : `${provider}-api`,
    })),
  };
});

import { PIAgentHarness } from '../pi-agent.js';
import type { AgentEvent, HarnessSessionConfig } from '../types.js';
import type { Message } from '../../types.js';

function makeConfig(overrides: Partial<HarnessSessionConfig> = {}): HarnessSessionConfig {
  return {
    systemPrompt: 'Test',
    tools: [],
    secrets: { openai: 'test-key' },
    agentId: 'test-agent',
    conversationId: 'test-conv',
    workspaceDir: '/tmp/workspace',
    harnessConfigJson: JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini', apiKeyRef: 'openai' }),
    ...overrides,
  };
}

function makeMessage(
  role: Message['role'],
  content: string,
  createdAt: string,
  extras: Partial<Message> = {},
): Message {
  return {
    id: `${role}-${content}`,
    agentId: 'agent-1',
    role,
    content,
    createdAt: new Date(createdAt),
    ...extras,
  };
}

async function collectEvents(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('PIAgentHarness transcript syncing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('registers Google runtime key under the model API auth bucket', async () => {
    const dispose = vi.fn();
    mockCreateAgentSession.mockResolvedValue({
      session: {
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(),
        abort: vi.fn(async () => undefined),
        dispose,
        agent: {
          replaceMessages: vi.fn(),
        },
      },
    });

    const harness = new PIAgentHarness();
    const session = await harness.openSession(makeConfig({
      secrets: { GOOGLE_API_KEY: 'test-google-key' },
      harnessConfigJson: JSON.stringify({
        provider: 'google',
        model: 'gemini-2.5-flash',
        apiKeyRef: '$secret:GOOGLE_API_KEY',
      }),
    }));

    expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('google', 'test-google-key');
    expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('google-generative-ai', 'test-google-key');

    await session.close();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('falls back to environment secrets for Google runtime auth', async () => {
    process.env.GOOGLE_API_KEY = 'env-google-key';
    mockCreateAgentSession.mockResolvedValue({
      session: {
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(),
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
        agent: {
          replaceMessages: vi.fn(),
        },
      },
    });

    const harness = new PIAgentHarness();
    const session = await harness.openSession(makeConfig({
      secrets: {},
      harnessConfigJson: JSON.stringify({
        provider: 'google',
        model: 'gemini-2.5-flash',
        apiKeyRef: '$secret:GOOGLE_API_KEY',
      }),
    }));

    expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('google', 'env-google-key');
    expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('google-generative-ai', 'env-google-key');

    await session.close();
  });

  it('uses provider-default Google secrets when apiKeyRef is omitted', async () => {
    mockCreateAgentSession.mockResolvedValue({
      session: {
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(),
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
        agent: {
          replaceMessages: vi.fn(),
        },
      },
    });

    const harness = new PIAgentHarness();
    const session = await harness.openSession(makeConfig({
      secrets: { GOOGLE_API_KEY: 'default-google-key' },
      harnessConfigJson: JSON.stringify({
        provider: 'google',
        model: 'gemini-2.5-flash',
      }),
    }));

    expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('google', 'default-google-key');
    expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('google-generative-ai', 'default-google-key');

    await session.close();
  });

  it('replaces native session history before prompting with the latest user message', async () => {
    const replaceMessages = vi.fn();
    const prompt = vi.fn(async () => {
      listener?.({ type: 'agent_end', messages: [] });
    });
    let listener: ((event: Record<string, unknown>) => void) | undefined;

    mockCreateAgentSession.mockResolvedValue({
      session: {
        subscribe: (next: (event: Record<string, unknown>) => void) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        prompt,
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
        agent: {
          replaceMessages,
        },
      },
    });

    const harness = new PIAgentHarness();
    const session = await harness.openSession(makeConfig());

    const events = await collectEvents(session.deliverTurn({
      turnId: 'turn-1',
      messages: [
        makeMessage('system', 'System context', '2026-04-05T10:00:00.000Z'),
        makeMessage('user', 'Earlier question', '2026-04-05T10:00:01.000Z'),
        makeMessage('assistant', 'Earlier answer', '2026-04-05T10:00:02.000Z'),
        makeMessage('tool', 'Weather tool result', '2026-04-05T10:00:03.000Z', { toolCallId: 'tool-1' }),
        makeMessage('user', 'Latest question', '2026-04-05T10:00:04.000Z'),
      ],
    }, {}));

    expect(replaceMessages).toHaveBeenCalledOnce();
    expect(replaceMessages).toHaveBeenCalledWith([
      {
        role: 'user',
        content: '[Previous system message]\nSystem context',
        timestamp: new Date('2026-04-05T10:00:00.000Z').getTime(),
      },
      {
        role: 'user',
        content: 'Earlier question',
        timestamp: new Date('2026-04-05T10:00:01.000Z').getTime() + 1,
      },
      {
        role: 'user',
        content: '[Previous assistant response]\nEarlier answer',
        timestamp: new Date('2026-04-05T10:00:02.000Z').getTime() + 2,
      },
      {
        role: 'user',
        content: '[Previous tool result (tool-1)]\nWeather tool result',
        timestamp: new Date('2026-04-05T10:00:03.000Z').getTime() + 3,
      },
    ]);
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith('Latest question');
    expect(replaceMessages.mock.invocationCallOrder[0]).toBeLessThan(prompt.mock.invocationCallOrder[0]!);
    expect(events.at(-1)).toEqual({ type: 'done', usage: undefined });

    await session.close();
  });

  it('syncs restored transcript into the native session before prompting', async () => {
    const replaceMessages = vi.fn();
    const prompt = vi.fn(async () => {
      listener?.({ type: 'agent_end', messages: [] });
    });
    let listener: ((event: Record<string, unknown>) => void) | undefined;

    mockCreateAgentSession.mockResolvedValue({
      session: {
        subscribe: (next: (event: Record<string, unknown>) => void) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        prompt,
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
        agent: {
          replaceMessages,
        },
      },
    });

    const harness = new PIAgentHarness();
    const restoredMessages = [
      makeMessage('user', 'Restore user', '2026-04-05T11:00:00.000Z'),
      makeMessage('tool', 'Restored tool output', '2026-04-05T11:00:01.000Z', { toolCallId: 'tool-restore' }),
      makeMessage('assistant', 'Restored assistant reply', '2026-04-05T11:00:02.000Z'),
    ];
    const session = await harness.openSession(makeConfig(), {
      stateVersion: '2',
      messages: [],
      payload: { transcript: restoredMessages },
    });

    await collectEvents(session.deliverTurn({
      turnId: 'turn-restore',
      messages: [
        ...restoredMessages,
        makeMessage('user', 'Continue from restore', '2026-04-05T11:00:03.000Z'),
      ],
    }, {}));

    expect(replaceMessages).toHaveBeenCalledOnce();
    expect(replaceMessages).toHaveBeenCalledWith([
      {
        role: 'user',
        content: 'Restore user',
        timestamp: new Date('2026-04-05T11:00:00.000Z').getTime(),
      },
      {
        role: 'user',
        content: '[Previous tool result (tool-restore)]\nRestored tool output',
        timestamp: new Date('2026-04-05T11:00:01.000Z').getTime() + 1,
      },
      {
        role: 'user',
        content: '[Previous assistant response]\nRestored assistant reply',
        timestamp: new Date('2026-04-05T11:00:02.000Z').getTime() + 2,
      },
    ]);
    expect(prompt).toHaveBeenCalledWith('Continue from restore');

    await session.close();
  });
});
