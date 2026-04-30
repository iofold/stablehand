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


describe('ClaudeAgentsHarness stream mapping fallbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces malformed streamed tool arguments as degraded args instead of an empty object', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const harness = new ClaudeAgentsHarness();
    const toolStartTimes = new Map<string, number>();
    const streamState = harness.createStreamMappingState();

    expect([...harness.mapSDKMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'tool-call-1',
          name: 'search',
        },
      },
    } as never, toolStartTimes, streamState)]).toEqual([]);

    expect([...harness.mapSDKMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"query":',
        },
      },
    } as never, toolStartTimes, streamState)]).toEqual([]);

    const events = [...harness.mapSDKMessage({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tool-call-1',
          name: 'search',
        }],
      },
    } as never, toolStartTimes, streamState)];

    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool_call_start',
        id: 'tool-call-1',
        name: 'search',
        args: expect.objectContaining({
          __ctxmillDegraded: true,
          __ctxmillError: expect.stringContaining('Failed to parse streamed Claude tool arguments'),
          __ctxmillRawArgsPreview: '{"query":',
        }),
      }),
    ]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('surfacing degraded args'),
      expect.any(SyntaxError),
    );
    errorSpy.mockRestore();
  });
});

describe('buildClaudeEnv secret redaction (mr-9486.57)', () => {
  const SECRET_KEYS = [
    'OPENAI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'GEMINI_API_KEY',
    'COHERE_API_KEY',
    'MISTRAL_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'LANGSMITH_API_KEY',
    'LANGSMITH_ENDPOINT',
    'LANGSMITH_WORKSPACE_ID',
    'LANGFUSE_SECRET_KEY',
    'LANGFUSE_PUBLIC_KEY',
    'LANGFUSE_HOST',
    'OTEL_EXPORTER_OTLP_HEADERS',
    'S3_SECRET_KEY',
    'S3_ACCESS_KEY',
    'MINIO_ROOT_USER',
    'MINIO_ROOT_PASSWORD',
    'MINIO_ACCESS_KEY',
    'MINIO_SECRET_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SESSION_TOKEN',
    'DATABASE_URL',
    'REDIS_URL',
    'POSTGRES_PASSWORD',
    'WORKOS_API_KEY',
    'JWT_SECRET',
    'SESSION_SECRET',
    'NOVU_API_KEY',
    'STRIPE_SECRET_KEY',
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not forward known secret env keys into the env passed to sdk.query()', async () => {
    // Inject synthetic secret values into process.env so buildClaudeEnv() can pick them up.
    const FAKE_SECRET_VALUES: Record<string, string> = {};
    for (const key of SECRET_KEYS) {
      FAKE_SECRET_VALUES[key] = `fake-secret-value-for-${key}`;
      process.env[key] = FAKE_SECRET_VALUES[key];
    }

    try {
      const harness = new ClaudeAgentsHarness();
      Reflect.set(harness, 'loadSdkModule', async () => ({
        query: mockQuery,
        tool: mockTool,
        createSdkMcpServer: mockCreateSdkMcpServer,
      }));

      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      });

      const session = await harness.openSession(makeConfig());
      const events: unknown[] = [];
      for await (const event of session.deliverTurn(
        { messages: [makeMessage('user', 'Hello')], turnId: 'turn-secret-test' },
        {},
      )) {
        events.push(event);
      }

      const queryCall = mockQuery.mock.calls[0]?.[0] as { options?: { env?: Record<string, string> } } | undefined;
      const capturedEnv = queryCall?.options?.env ?? {};

      // None of the blocked secret keys should appear in the env passed to the SDK.
      for (const key of SECRET_KEYS) {
        expect(capturedEnv, `env must not contain secret key ${key}`).not.toHaveProperty(key);
      }

      // ANTHROPIC_API_KEY is required for the SDK to authenticate — it must still be present.
      expect(capturedEnv).toHaveProperty('ANTHROPIC_API_KEY', 'test-key');

      await session.close();
    } finally {
      // Restore process.env so we don't leak state into other tests.
      for (const key of SECRET_KEYS) {
        delete process.env[key];
      }
    }
  });

  it('does not carry fake secret values in the env (verifies value-level exclusion)', async () => {
    const FAKE_OPENAI_KEY = 'sk-openai-FAKEFAKEFAKE123';
    const FAKE_LANGSMITH_KEY = 'ls-FAKEFAKEFAKE456';
    process.env.OPENAI_API_KEY = FAKE_OPENAI_KEY;
    process.env.LANGSMITH_API_KEY = FAKE_LANGSMITH_KEY;

    try {
      const harness = new ClaudeAgentsHarness();
      Reflect.set(harness, 'loadSdkModule', async () => ({
        query: mockQuery,
        tool: mockTool,
        createSdkMcpServer: mockCreateSdkMcpServer,
      }));

      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      });

      const session = await harness.openSession(makeConfig());
      for await (const _ of session.deliverTurn(
        { messages: [makeMessage('user', 'Hello')], turnId: 'turn-value-test' },
        {},
      )) { /* drain */ }

      const queryCall = mockQuery.mock.calls[0]?.[0] as { options?: { env?: Record<string, string> } } | undefined;
      const capturedEnv = queryCall?.options?.env ?? {};
      const capturedEnvValues = Object.values(capturedEnv);

      // The fake secret values must not appear anywhere in the env passed to the SDK.
      expect(capturedEnvValues).not.toContain(FAKE_OPENAI_KEY);
      expect(capturedEnvValues).not.toContain(FAKE_LANGSMITH_KEY);

      await session.close();
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.LANGSMITH_API_KEY;
    }
  });
});
