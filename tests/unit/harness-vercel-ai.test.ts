import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { VercelAIHarness, buildModel, convertMessages } from '../../packages/ctxmill/src/harness/vercel-ai.js';
import type { VercelAIDeps } from '../../packages/ctxmill/src/harness/vercel-ai.js';
import type { HarnessRunConfig, AgentEvent } from '../../packages/ctxmill/src/harness/types.js';
import type { ToolDefinition } from '../../packages/ctxmill/src/tool/types.js';

function makeConfig(overrides: Partial<HarnessRunConfig> = {}): HarnessRunConfig {
  return {
    modelConfig: {
      provider: 'openai',
      model: 'gpt-4o',
    },
    systemPrompt: 'You are a test agent.',
    messages: [
      { id: '1', agentId: 'a1', role: 'user', content: 'Hello', createdAt: new Date() },
    ],
    tools: [],
    secrets: {},
    agentId: 'test-agent',
    runId: 'run-1',
    conversationId: 'conv-1',
    workspaceDir: '/tmp/test',
    ...overrides,
  };
}

/** Helper to create an async iterable from an array of stream parts. */
async function* makeStream(parts: Array<Record<string, unknown>>) {
  for (const part of parts) {
    yield part;
  }
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function makeMockDeps(): { deps: VercelAIDeps; streamTextMock: ReturnType<typeof vi.fn>; buildModelMock: ReturnType<typeof vi.fn>; stepCountIsMock: ReturnType<typeof vi.fn> } {
  const streamTextMock = vi.fn();
  const buildModelMock = vi.fn(() => ({ modelId: 'test-model' }));
  const stepCountIsMock = vi.fn((n: number) => ({ type: 'stepCount', count: n }));
  return {
    deps: {
      streamText: streamTextMock as any,
      buildModel: buildModelMock as any,
      stepCountIs: stepCountIsMock as any,
    },
    streamTextMock,
    buildModelMock,
    stepCountIsMock,
  };
}

describe('VercelAIHarness', () => {
  let harness: VercelAIHarness;
  let streamTextMock: ReturnType<typeof vi.fn>;
  let buildModelMock: ReturnType<typeof vi.fn>;
  let stepCountIsMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    const m = makeMockDeps();
    harness = new VercelAIHarness(m.deps);
    streamTextMock = m.streamTextMock;
    buildModelMock = m.buildModelMock;
    stepCountIsMock = m.stepCountIsMock;
  });

  it('has the correct name', () => {
    expect(harness.name).toBe('vercel-ai');
  });

  it('implements the AgentHarness interface', () => {
    expect(typeof harness.run).toBe('function');
    expect(harness.name).toBe('vercel-ai');
  });

  it('yields text_delta events from streamed text', async () => {
    const streamParts = [
      { type: 'text-delta', delta: 'Hello' },
      { type: 'text-delta', delta: ' world' },
      { type: 'finish', totalUsage: { inputTokens: 10, outputTokens: 5 } },
    ];
    streamTextMock.mockReturnValue({ fullStream: makeStream(streamParts) });

    const events = await collectEvents(harness.run(makeConfig()));

    expect(events).toEqual([
      { type: 'text_delta', content: 'Hello' },
      { type: 'text_delta', content: ' world' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    ]);
  });

  it('yields tool_call_start and tool_call_end events', async () => {
    const streamParts = [
      { type: 'tool-call', toolCallId: 'tc-1', toolName: 'search', input: { query: 'test' } },
      { type: 'tool-result', toolCallId: 'tc-1', output: 'found it' },
      { type: 'finish', totalUsage: { inputTokens: 5, outputTokens: 3 } },
    ];
    streamTextMock.mockReturnValue({ fullStream: makeStream(streamParts) });

    const events = await collectEvents(harness.run(makeConfig()));

    expect(events[0]).toEqual({
      type: 'tool_call_start',
      id: 'tc-1',
      name: 'search',
      args: { query: 'test' },
    });
    expect(events[1]).toMatchObject({
      type: 'tool_call_end',
      id: 'tc-1',
      result: 'found it',
    });
    expect((events[1] as any).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('yields error events from stream errors', async () => {
    const streamParts = [
      { type: 'error', error: 'Something went wrong' },
      { type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 0 } },
    ];
    streamTextMock.mockReturnValue({ fullStream: makeStream(streamParts) });

    const events = await collectEvents(harness.run(makeConfig()));

    expect(events[0]).toEqual({ type: 'error', error: 'Something went wrong' });
  });

  it('catches thrown errors and yields an error event', async () => {
    streamTextMock.mockImplementation(() => {
      throw new Error('Connection failed');
    });

    const events = await collectEvents(harness.run(makeConfig()));

    expect(events).toEqual([{ type: 'error', error: 'Error: Connection failed' }]);
  });

  it('catches buildModel errors and yields an error event', async () => {
    buildModelMock.mockImplementation(() => {
      throw new Error('VercelAIHarness: unsupported provider "unsupported". Supported: openai, anthropic, google');
    });

    const events = await collectEvents(harness.run(makeConfig()));

    expect(events).toEqual([
      {
        type: 'error',
        error: 'Error: VercelAIHarness: unsupported provider "unsupported". Supported: openai, anthropic, google',
      },
    ]);
  });

  it('converts tool definitions with inputSchema and execute', async () => {
    const toolDef: ToolDefinition = {
      name: 'greet',
      description: 'Greets a user',
      input: z.object({ name: z.string() }),
      handler: vi.fn(async (input: { name: string }) => `Hello, ${input.name}!`),
    };

    const streamParts = [
      { type: 'finish', totalUsage: { inputTokens: 0, outputTokens: 0 } },
    ];
    streamTextMock.mockReturnValue({ fullStream: makeStream(streamParts) });

    await collectEvents(harness.run(makeConfig({ tools: [toolDef] })));

    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          greet: expect.objectContaining({
            description: 'Greets a user',
            inputSchema: toolDef.input,
          }),
        }),
      }),
    );
  });

  it('tool execute function calls the handler', async () => {
    const handler = vi.fn(async (input: { name: string }) => `Hello, ${input.name}!`);
    const toolDef: ToolDefinition = {
      name: 'greet',
      description: 'Greets a user',
      input: z.object({ name: z.string() }),
      handler,
    };

    const streamParts = [
      { type: 'finish', totalUsage: { inputTokens: 0, outputTokens: 0 } },
    ];
    streamTextMock.mockReturnValue({ fullStream: makeStream(streamParts) });

    await collectEvents(harness.run(makeConfig({ tools: [toolDef] })));

    const callArgs = streamTextMock.mock.calls[0]?.[0] as any;
    const greetTool = callArgs.tools.greet;

    const result = await greetTool.execute({ name: 'Alice' });
    expect(result).toBe('Hello, Alice!');
    expect(handler).toHaveBeenCalledWith(
      { name: 'Alice' },
      expect.objectContaining({ agentId: 'test-agent' }),
    );
  });

  it('handles HITL approval rejection for tools requiring approval', async () => {
    const toolDef: ToolDefinition = {
      name: 'dangerous',
      description: 'Does something risky',
      input: z.object({ target: z.string() }),
      requiresApproval: true,
      handler: vi.fn(async () => 'executed'),
    };

    const onApprovalNeeded = vi.fn(async () => ({ action: 'reject' as const }));

    const streamParts = [
      { type: 'finish', totalUsage: { inputTokens: 0, outputTokens: 0 } },
    ];
    streamTextMock.mockReturnValue({ fullStream: makeStream(streamParts) });

    await collectEvents(harness.run(makeConfig({ tools: [toolDef], onApprovalNeeded })));

    const callArgs = streamTextMock.mock.calls[0]?.[0] as any;
    const dangerousTool = callArgs.tools.dangerous;

    await expect(dangerousTool.execute({ target: 'test' })).rejects.toThrow(
      'Tool call was rejected by the user.',
    );
    expect(onApprovalNeeded).toHaveBeenCalled();
  });

  it('handles HITL approval acceptance for tools requiring approval', async () => {
    const handler = vi.fn(async () => 'executed');
    const toolDef: ToolDefinition = {
      name: 'dangerous',
      description: 'Does something risky',
      input: z.object({ target: z.string() }),
      requiresApproval: true,
      handler,
    };

    const onApprovalNeeded = vi.fn(async () => ({ action: 'approve' as const }));

    const streamParts = [
      { type: 'finish', totalUsage: { inputTokens: 0, outputTokens: 0 } },
    ];
    streamTextMock.mockReturnValue({ fullStream: makeStream(streamParts) });

    await collectEvents(harness.run(makeConfig({ tools: [toolDef], onApprovalNeeded })));

    const callArgs = streamTextMock.mock.calls[0]?.[0] as any;
    const dangerousTool = callArgs.tools.dangerous;

    const result = await dangerousTool.execute({ target: 'test' });
    expect(result).toBe('executed');
    expect(onApprovalNeeded).toHaveBeenCalled();
    expect(handler).toHaveBeenCalled();
  });

  it('skips HITL when tool does not require approval', async () => {
    const handler = vi.fn(async () => 'executed');
    const toolDef: ToolDefinition = {
      name: 'safe',
      description: 'A safe operation',
      input: z.object({}),
      handler,
    };

    const onApprovalNeeded = vi.fn(async () => ({ action: 'approve' as const }));

    const streamParts = [
      { type: 'finish', totalUsage: { inputTokens: 0, outputTokens: 0 } },
    ];
    streamTextMock.mockReturnValue({ fullStream: makeStream(streamParts) });

    await collectEvents(harness.run(makeConfig({ tools: [toolDef], onApprovalNeeded })));

    const callArgs = streamTextMock.mock.calls[0]?.[0] as any;
    const safeTool = callArgs.tools.safe;

    const result = await safeTool.execute({});
    expect(result).toBe('executed');
    expect(onApprovalNeeded).not.toHaveBeenCalled();
  });

  it('serializes non-string tool results as JSON', async () => {
    const streamParts = [
      { type: 'tool-call', toolCallId: 'tc-2', toolName: 'fetch', input: {} },
      { type: 'tool-result', toolCallId: 'tc-2', output: { data: [1, 2, 3] } },
      { type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1 } },
    ];
    streamTextMock.mockReturnValue({ fullStream: makeStream(streamParts) });

    const events = await collectEvents(harness.run(makeConfig()));

    const toolEnd = events.find((e) => e.type === 'tool_call_end');
    expect(toolEnd).toMatchObject({
      result: '{"data":[1,2,3]}',
    });
  });

  it('passes model options through (temperature, maxOutputTokens, topP)', async () => {
    const streamParts = [
      { type: 'finish', totalUsage: { inputTokens: 0, outputTokens: 0 } },
    ];
    streamTextMock.mockReturnValue({ fullStream: makeStream(streamParts) });

    await collectEvents(
      harness.run(
        makeConfig({
          modelConfig: {
            provider: 'openai',
            model: 'gpt-4o',
            temperature: 0.7,
            maxTokens: 1000,
            topP: 0.9,
          },
        }),
      ),
    );

    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.7,
        maxOutputTokens: 1000,
        topP: 0.9,
      }),
    );
  });

  it('filters out tool messages from the conversation', async () => {
    const streamParts = [
      { type: 'finish', totalUsage: { inputTokens: 0, outputTokens: 0 } },
    ];
    streamTextMock.mockReturnValue({ fullStream: makeStream(streamParts) });

    await collectEvents(
      harness.run(
        makeConfig({
          messages: [
            { id: '1', agentId: 'a1', role: 'user', content: 'Hello', createdAt: new Date() },
            { id: '2', agentId: 'a1', role: 'tool', content: '{"result":"ok"}', createdAt: new Date() },
            { id: '3', agentId: 'a1', role: 'assistant', content: 'Hi', createdAt: new Date() },
          ],
        }),
      ),
    );

    const callArgs = streamTextMock.mock.calls[0]?.[0] as any;
    const messages = callArgs.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
  });

  it('uses stopWhen with stepCountIs(10)', async () => {
    const streamParts = [
      { type: 'finish', totalUsage: { inputTokens: 0, outputTokens: 0 } },
    ];
    streamTextMock.mockReturnValue({ fullStream: makeStream(streamParts) });

    await collectEvents(harness.run(makeConfig()));

    expect(stepCountIsMock).toHaveBeenCalledWith(10);
    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stopWhen: { type: 'stepCount', count: 10 },
      }),
    );
  });

  it('yields done without usage when finish has no usage data', async () => {
    const streamParts = [
      { type: 'text-delta', delta: 'Hi' },
      { type: 'finish' },
    ];
    streamTextMock.mockReturnValue({ fullStream: makeStream(streamParts) });

    const events = await collectEvents(harness.run(makeConfig()));

    expect(events).toEqual([
      { type: 'text_delta', content: 'Hi' },
      { type: 'done', usage: undefined },
    ]);
  });
});

describe('convertMessages', () => {
  it('filters out tool-role messages and preserves user/assistant/system', () => {
    const messages = [
      { id: '1', agentId: 'a1', role: 'user' as const, content: 'Hi', createdAt: new Date() },
      { id: '2', agentId: 'a1', role: 'system' as const, content: 'You are helpful', createdAt: new Date() },
      { id: '3', agentId: 'a1', role: 'tool' as const, content: '{}', createdAt: new Date() },
      { id: '4', agentId: 'a1', role: 'assistant' as const, content: 'Hello!', createdAt: new Date() },
    ];

    const result = convertMessages(messages);

    expect(result).toHaveLength(3);
    expect(result.map((m: any) => m.role)).toEqual(['user', 'system', 'assistant']);
  });
});

describe('buildModel', () => {
  it('throws on unsupported provider', () => {
    const config = makeConfig({ modelConfig: { provider: 'unsupported', model: 'foo' } });
    expect(() => buildModel(config)).toThrow(
      'VercelAIHarness: unsupported provider "unsupported"',
    );
  });
});
