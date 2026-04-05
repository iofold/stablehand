import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockQuery,
  mockCreateSdkMcpServer,
  mockTool,
  mockReadFile,
  mockMkdir,
  mockWriteFile,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockCreateSdkMcpServer: vi.fn((_opts: { name: string }) => ({
    type: 'sdk',
    name: _opts.name,
  })),
  mockTool: vi.fn(),
  mockReadFile: vi.fn(),
  mockMkdir: vi.fn(),
  mockWriteFile: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
  tool: mockTool,
  createSdkMcpServer: mockCreateSdkMcpServer,
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
}));

import { ClaudeAgentsHarness } from '../claude-agents.js';
import type { AgentEvent, HarnessSessionConfig } from '../types.js';
import type { Message } from '../../types.js';

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
    secrets: { anthropic: 'test-key' },
    agentId: 'agent-1',
    conversationId: 'conversation-1',
    workspaceDir: '/tmp/workspace',
    harnessConfigJson: JSON.stringify({ model: 'claude-sonnet-4-6', apiKeyRef: 'anthropic' }),
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

async function* sdkStream(messages: Array<Record<string, unknown>>) {
  for (const message of messages) {
    yield message;
  }
}

describe('ClaudeSession JSONL persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HOME = '/home/test';
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  it('exportState reads persisted session JSONL when present', async () => {
    const harness = new ClaudeAgentsHarness();
    Reflect.set(harness, 'loadSdkModule', async () => ({
      query: mockQuery,
      tool: mockTool,
      createSdkMcpServer: mockCreateSdkMcpServer,
    }));

    mockQuery.mockImplementation(() => sdkStream([
      {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]));
    mockReadFile.mockResolvedValue('{"type":"user"}\n');

    const session = await harness.openSession(makeConfig());
    await collectEvents(session.deliverTurn({ messages: [makeMessage('user', 'Hello')], turnId: 'turn-1' }, {}));

    await expect(session.exportState()).resolves.toMatchObject({
      stateVersion: '2',
      payload: {
        transcript: [expect.objectContaining({ role: 'user', content: 'Hello' })],
        sessionId: 'conversation-1',
        sessionJSONL: '{"type":"user"}\n',
      },
    });
    expect(mockReadFile).toHaveBeenCalledWith(
      '/home/test/.claude/projects/-tmp-workspace/sessions/conversation-1.jsonl',
      'utf-8',
    );

    await session.close();
  });

  it('openSession restore writes session JSONL and resumed turn uses resume', async () => {
    const harness = new ClaudeAgentsHarness();
    Reflect.set(harness, 'loadSdkModule', async () => ({
      query: mockQuery,
      tool: mockTool,
      createSdkMcpServer: mockCreateSdkMcpServer,
    }));

    mockQuery.mockImplementation(() => sdkStream([
      {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    ]));
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);

    const restoredMessage = makeMessage('assistant', 'Restored reply');
    const userMessage = makeMessage('user', 'Resume me');
    const session = await harness.openSession(makeConfig(), {
      stateVersion: '2',
      messages: [],
      payload: {
        transcript: [restoredMessage],
        sessionJSONL: '{"type":"assistant"}\n',
      },
    });

    expect(mockMkdir).toHaveBeenCalledWith(
      '/home/test/.claude/projects/-tmp-workspace/sessions',
      { recursive: true },
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/home/test/.claude/projects/-tmp-workspace/sessions/conversation-1.jsonl',
      '{"type":"assistant"}\n',
      'utf-8',
    );

    await collectEvents(
      session.deliverTurn(
        { messages: [restoredMessage, userMessage], turnId: 'turn-resume' },
        {},
      ),
    );

    const queryCall = mockQuery.mock.calls[0]?.[0];
    expect(queryCall?.options.resume).toBe('conversation-1');
    expect(queryCall?.options.sessionId).toBeUndefined();

    await session.close();
  });
});
