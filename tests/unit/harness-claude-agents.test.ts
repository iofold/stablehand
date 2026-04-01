import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mockQuery = vi.fn();
const mockTool = vi.fn((_name: string, _desc: string, _schema: unknown, handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>) => ({
  name: _name,
  description: _desc,
  inputSchema: _schema,
  handler,
}));
const mockSdkTool = (...args: unknown[]) => {
  const [name, description, inputSchema, handler] = args as [
    string,
    string,
    unknown,
    (args: Record<string, unknown>, extra: unknown) => Promise<unknown>,
  ];
  return mockTool(name, description, inputSchema, handler);
};
const mockCreateSdkMcpServer = vi.fn((_opts: { name: string }) => ({
  type: 'sdk',
  name: _opts.name,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
  tool: mockSdkTool,
  createSdkMcpServer: mockCreateSdkMcpServer,
}));

import { ClaudeAgentsHarness } from '../../packages/sandbox-daemon/src/index.ts';
import type { AgentEvent, AgentHarness, HarnessSessionConfig } from '../../packages/sandbox-daemon/src/index.ts';
import type { ToolDefinition } from '../../packages/sandbox-daemon/src/index.ts';
import type { Message } from '../../packages/sandbox-daemon/src/index.ts';

function makeMessage(
  role: Message['role'],
  content: string,
): Message {
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

function mapSdkMessage(
  harness: ClaudeAgentsHarness,
  message: unknown,
  toolStartTimes: Map<string, number>,
  streamState?: unknown,
): AgentEvent[] {
  const mapped = streamState === undefined
    ? Reflect.apply(harness.mapSDKMessage.bind(harness), harness, [message, toolStartTimes])
    : Reflect.apply(harness.mapSDKMessage.bind(harness), harness, [message, toolStartTimes, streamState]);
  return [...(mapped as Iterable<AgentEvent>)];
}

describe('ClaudeAgentsHarness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should have name "claude-agents"', () => {
    const harness = new ClaudeAgentsHarness();
    expect(harness.name).toBe('claude-agents');
  });

  it('should implement the AgentHarness interface', () => {
    const harness = new ClaudeAgentsHarness();
    const asInterface: AgentHarness = harness;
    expect(asInterface.name).toBe('claude-agents');
    expect(typeof asInterface.openSession).toBe('function');
  });

  it('throws ZodError when legacy modelConfig is passed without harnessConfigJson', async () => {
    const harness = new ClaudeAgentsHarness();
    const legacyConfig = {
      ...makeConfig(),
      modelConfig: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKeyRef: 'anthropic' },
    };
    Reflect.deleteProperty(legacyConfig, 'harnessConfigJson');

    await expect(
      Reflect.apply(harness.openSession.bind(harness), harness, [legacyConfig]),
    ).rejects.toThrowError(z.ZodError);
  });

  it('throws ZodError when harnessConfigJson omits the required model', async () => {
    const harness = new ClaudeAgentsHarness();

    await expect(
      harness.openSession(makeConfig({ harnessConfigJson: JSON.stringify({ apiKeyRef: 'anthropic' }) })),
    ).rejects.toThrowError(z.ZodError);
  });

  describe('convertToolsWithSDK', () => {
    it('should convert ToolDefinition[] to Claude SDK MCP tools', () => {
      const harness = new ClaudeAgentsHarness();
      const toolDefs: ToolDefinition[] = [
        {
          name: 'get-weather',
          description: 'Get the current weather for a city',
          input: z.object({ city: z.string() }),
          handler: async (input) => JSON.stringify(input),
        },
        {
          name: 'send-email',
          description: 'Send an email',
          input: z.object({ to: z.string(), body: z.string() }),
          requiresApproval: true,
          handler: async () => 'sent',
        },
      ];

      const converted = harness.convertToolsWithSDK({ tool: mockSdkTool }, toolDefs, 'run-1');

      expect(converted).toHaveLength(2);
      expect(converted[0].name).toBe('get-weather');
      expect(converted[1].name).toBe('send-email');
      expect(converted[0].description).toBe('Get the current weather for a city');
      expect(converted[0].inputSchema).toBe(toolDefs[0].input);
    });

    it('should wrap handler to return MCP CallToolResult format', async () => {
      const harness = new ClaudeAgentsHarness();
      const handler = vi.fn().mockResolvedValue('result-42');
      const toolDefs: ToolDefinition[] = [
        {
          name: 'my-tool',
          description: 'Test',
          input: z.object({ val: z.string() }),
          handler,
        },
      ];

      const converted = harness.convertToolsWithSDK(
        { tool: mockSdkTool },
        toolDefs,
        'run-1',
        makeConfig({ tools: toolDefs }),
      );
      const result = await converted[0].handler({ val: 'hello' }, {});

      expect(result).toEqual({
        content: [{ type: 'text', text: 'result-42' }],
      });
      expect(handler).toHaveBeenCalledWith(
        { val: 'hello' },
        expect.objectContaining({
          agentId: 'agent-1',
          conversationId: 'conversation-1',
          workspaceDir: '/tmp/workspace',
          knowledge: expect.any(Object),
        }),
      );
    });

    it('should queue approval events and reject when approval is denied', async () => {
      const harness = new ClaudeAgentsHarness();
      const onApprovalNeeded = vi.fn().mockResolvedValue({ action: 'reject' as const });
      const queuedEvents: AgentEvent[] = [];
      const toolDefs: ToolDefinition[] = [
        {
          name: 'dangerous-tool',
          description: 'Needs approval',
          input: z.object({ reason: z.string() }),
          requiresApproval: true,
          handler: async () => 'should-not-run',
        },
      ];

      const converted = harness.convertToolsWithSDK(
        { tool: mockSdkTool },
        toolDefs,
        'run-1',
        makeConfig({ tools: toolDefs }),
        onApprovalNeeded,
        queuedEvents,
      );
      const result = await converted[0].handler({ reason: 'test' }, {});

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Tool call was rejected by the user.' }],
        isError: true,
      });
      expect(queuedEvents).toEqual([
        {
          type: 'approval_needed',
          id: expect.any(String),
          tool: 'dangerous-tool',
          args: { reason: 'test' },
        },
        {
          type: 'approval_resolved',
          id: expect.any(String),
          action: 'reject',
        },
      ]);
    });

    it('should execute handler when approval is granted', async () => {
      const harness = new ClaudeAgentsHarness();
      const onApprovalNeeded = vi.fn().mockResolvedValue({ action: 'approve' as const });
      const handler = vi.fn().mockResolvedValue('approved-result');
      const toolDefs: ToolDefinition[] = [
        {
          name: 'dangerous-tool',
          description: 'Needs approval',
          input: z.object({}),
          requiresApproval: true,
          handler,
        },
      ];

      const converted = harness.convertToolsWithSDK(
        { tool: mockSdkTool },
        toolDefs,
        'run-1',
        makeConfig({ tools: toolDefs }),
        onApprovalNeeded,
      );
      const result = await converted[0].handler({}, {});

      expect(result).toEqual({
        content: [{ type: 'text', text: 'approved-result' }],
      });
      expect(onApprovalNeeded).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledOnce();
    });

    it('should auto-approve when no callback is provided', async () => {
      const harness = new ClaudeAgentsHarness();
      const handler = vi.fn().mockResolvedValue('auto-approved');
      const toolDefs: ToolDefinition[] = [
        {
          name: 'approval-tool',
          description: 'Needs approval',
          input: z.object({}),
          requiresApproval: true,
          handler,
        },
      ];

      const converted = harness.convertToolsWithSDK({ tool: mockSdkTool }, toolDefs, 'run-1');
      const result = await converted[0].handler({}, {});

      expect(result).toEqual({
        content: [{ type: 'text', text: 'auto-approved' }],
      });
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('buildCanUseTool', () => {
    it('should allow tools that do not require approval', async () => {
      const harness = new ClaudeAgentsHarness();
      const canUseTool = harness.buildCanUseTool([
        {
          name: 'safe-tool',
          description: 'Safe',
          input: z.object({}),
          handler: async () => 'ok',
        },
      ], undefined, 'run-1');

      const result = await canUseTool('safe-tool', {}, {
        signal: new AbortController().signal,
        toolUseID: 'tool-1',
      });

      expect(result).toEqual({ behavior: 'allow' });
    });

    it('should deny approval-required tools when callback rejects', async () => {
      const harness = new ClaudeAgentsHarness();
      const onApprovalNeeded = vi.fn().mockResolvedValue({ action: 'reject' as const });
      const canUseTool = harness.buildCanUseTool([
        {
          name: 'danger-tool',
          description: 'Dangerous',
          input: z.object({}),
          requiresApproval: true,
          handler: async () => 'ok',
        },
      ], onApprovalNeeded, 'run-1');

      const result = await canUseTool('danger-tool', { key: 'value' }, {
        signal: new AbortController().signal,
        toolUseID: 'tool-2',
      });

      expect(result).toEqual({
        behavior: 'deny',
        message: 'Tool call was rejected by the user.',
      });
      expect(onApprovalNeeded).toHaveBeenCalledWith({
        id: 'tool-2',
        runId: 'run-1',
        toolName: 'danger-tool',
        args: { key: 'value' },
      });
    });
  });

  describe('mapSDKMessage', () => {
    it('should map assistant text content blocks to text_delta', () => {
      const harness = new ClaudeAgentsHarness();

      const results = mapSdkMessage(harness, {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello world' }],
        },
      }, new Map());

      expect(results).toEqual([{ type: 'text_delta', content: 'Hello world' }]);
    });

    it('should map assistant tool_use blocks to tool_call_start', () => {
      const harness = new ClaudeAgentsHarness();
      const toolStartTimes = new Map<string, number>();

      const results = mapSdkMessage(harness, {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_123', name: 'get-weather', input: { city: 'NYC' } }],
        },
      }, toolStartTimes);

      expect(results).toEqual([
        { type: 'tool_call_start', id: 'toolu_123', name: 'get-weather', args: { city: 'NYC' } },
      ]);
      expect(toolStartTimes.has('toolu_123')).toBe(true);
    });

    it('should map stream_event text deltas and avoid duplicate assistant text after streaming', () => {
      const harness = new ClaudeAgentsHarness();
      const streamState = { sawTextDeltaSinceAssistant: false };

      const streamed = mapSdkMessage(harness, {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'streaming text' },
        },
      }, new Map(), streamState);
      const assistant = mapSdkMessage(harness, {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'streaming text' }],
        },
      }, new Map(), streamState);

      expect(streamed).toEqual([{ type: 'text_delta', content: 'streaming text' }]);
      expect(assistant).toEqual([]);
    });

    it('should defer tool_call_start to assistant message with populated args after streaming', () => {
      const harness = new ClaudeAgentsHarness();
      const toolStartTimes = new Map<string, number>();
      const streamState = harness.createStreamMappingState();

      // Step 1: content_block_start fires (tool_use block, no input yet)
      const streamEvents = mapSdkMessage(harness, {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_defer', name: 'get-weather' },
        },
      }, toolStartTimes, streamState);

      // content_block_start should NOT emit tool_call_start (deferred)
      const toolStarts = streamEvents.filter((e) => e.type === 'tool_call_start');
      expect(toolStarts).toHaveLength(0);

      // Step 2: assistant message arrives with full input
      const assistantEvents = mapSdkMessage(harness, {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_defer', name: 'get-weather', input: { city: 'NYC' } }],
        },
      }, toolStartTimes, streamState);

      // assistant message emits tool_call_start with populated args
      expect(assistantEvents).toEqual([
        { type: 'tool_call_start', id: 'toolu_defer', name: 'get-weather', args: { city: 'NYC' } },
      ]);
    });

    it('should use buffered input_json_delta as fallback when assistant input is missing', () => {
      const harness = new ClaudeAgentsHarness();
      const toolStartTimes = new Map<string, number>();
      const streamState = harness.createStreamMappingState();

      // Step 1: content_block_start
      mapSdkMessage(harness, {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_buf', name: 'search' },
        },
      }, toolStartTimes, streamState);

      // Step 2: input_json_delta events accumulate partial JSON
      mapSdkMessage(harness, {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"q":' },
        },
      }, toolStartTimes, streamState);
      mapSdkMessage(harness, {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"test"}' },
        },
      }, toolStartTimes, streamState);

      // Step 3: assistant message WITHOUT input field
      const events = mapSdkMessage(harness, {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_buf', name: 'search' }],
        },
      }, toolStartTimes, streamState);

      // Should fall back to buffered args from input_json_delta
      expect(events).toEqual([
        { type: 'tool_call_start', id: 'toolu_buf', name: 'search', args: { q: 'test' } },
      ]);
    });

    it('should emit correct args for multiple streamed tool calls in one assistant message', () => {
      const harness = new ClaudeAgentsHarness();
      const toolStartTimes = new Map<string, number>();
      const streamState = harness.createStreamMappingState();

      // Two content_block_start events (streaming)
      const stream1 = mapSdkMessage(harness, {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_m1', name: 'weather' },
        },
      }, toolStartTimes, streamState);

      const stream2 = mapSdkMessage(harness, {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_m2', name: 'search' },
        },
      }, toolStartTimes, streamState);

      // Neither should emit tool_call_start from streaming
      expect(stream1.filter((e) => e.type === 'tool_call_start')).toHaveLength(0);
      expect(stream2.filter((e) => e.type === 'tool_call_start')).toHaveLength(0);

      // Assistant message with both tools and their inputs
      const events = mapSdkMessage(harness, {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_m1', name: 'weather', input: { city: 'NYC' } },
            { type: 'tool_use', id: 'toolu_m2', name: 'search', input: { q: 'hello' } },
          ],
        },
      }, toolStartTimes, streamState);

      // Both should have correct populated args
      expect(events).toEqual([
        { type: 'tool_call_start', id: 'toolu_m1', name: 'weather', args: { city: 'NYC' } },
        { type: 'tool_call_start', id: 'toolu_m2', name: 'search', args: { q: 'hello' } },
      ]);
    });

    it('should default to empty object (not empty string) when no args are available', () => {
      const harness = new ClaudeAgentsHarness();
      const toolStartTimes = new Map<string, number>();

      const events = mapSdkMessage(harness, {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_empty', name: 'no-args-tool' }],
        },
      }, toolStartTimes);

      expect(events).toEqual([
        { type: 'tool_call_start', id: 'toolu_empty', name: 'no-args-tool', args: {} },
      ]);
    });

    it('should map result success messages to done with usage', () => {
      const harness = new ClaudeAgentsHarness();

      const results = mapSdkMessage(harness, {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.005,
      }, new Map());

      expect(results).toEqual([
        {
          type: 'done',
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            cost: 0.005,
          },
        },
      ]);
    });
  });

  describe('openSession() and deliverTurn()', () => {
    it('should pass nativeTools allowlist/blocklist and ctxmill MCP server into query()', async () => {
      const harness = new ClaudeAgentsHarness();
      Reflect.set(harness, 'loadSdkModule', async () => ({
        query: mockQuery,
        tool: mockSdkTool,
        createSdkMcpServer: mockCreateSdkMcpServer,
      }));
      const customTool: ToolDefinition = {
        name: 'ctx-tool',
        description: 'Ctx tool',
        input: z.object({ city: z.string() }),
        handler: async () => 'ok',
      };
      const config = makeConfig({
        tools: [customTool],
        nativeTools: [
          {
          allowlist: ['native-read', 'native-bash'],
          blocklist: ['native-bash'],
          },
        ],
        harnessConfigJson: JSON.stringify({ model: 'claude-sonnet-4-6', apiKeyRef: 'anthropic', maxTurns: 4 }),
      });

      mockQuery.mockImplementation(() => sdkStream([
        {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      ]));

      const session = await harness.openSession(config);
      const events = await collectEvents(
        session.deliverTurn(
          { messages: [makeMessage('user', 'Hello')], turnId: 'turn-1' },
          {},
        ),
      );
      const queryCall = mockQuery.mock.calls[0]?.[0];
      const createServerCall = mockCreateSdkMcpServer.mock.calls[0]?.[0];

      await session.close();

      expect(events).toEqual([
        { type: 'done', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
      ]);
      expect(createServerCall).toEqual({
        name: 'ctxmill',
        tools: [expect.objectContaining({ name: 'ctx-tool' })],
      });
      expect(queryCall?.options.allowedTools).toEqual(['native-read', 'native-bash', 'mcp__ctxmill__*']);
      expect(queryCall?.options.disallowedTools).toEqual(['native-bash']);
      expect(queryCall?.options.mcpServers).toEqual({
        ctxmill: {
          type: 'sdk',
          name: 'ctxmill',
        },
      });
      expect(queryCall?.options.permissionMode).toBe('bypassPermissions');
      expect(queryCall?.options.includePartialMessages).toBe(false);
      expect(queryCall?.options.maxTurns).toBe(4);
    });

    it('openSession with restore populates transcript from payload.transcript', async () => {
      const harness = new ClaudeAgentsHarness();
      Reflect.set(harness, 'loadSdkModule', async () => ({
        query: mockQuery,
        tool: mockSdkTool,
        createSdkMcpServer: mockCreateSdkMcpServer,
      }));

      mockQuery.mockImplementation(() => sdkStream([
        {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ]));

      const restoredMessage = makeMessage('assistant', 'Restored reply');
      const userMessage = makeMessage('user', 'Hello again');
      const session = await harness.openSession(makeConfig(), {
        stateVersion: '1',
        messages: [],
        payload: { transcript: [restoredMessage] },
      });

      await collectEvents(
        session.deliverTurn(
          { messages: [userMessage], turnId: 'turn-restore' },
          {},
        ),
      );

      await expect(session.exportState()).resolves.toEqual({
        stateVersion: '2',
        payload: {
          transcript: [restoredMessage, userMessage],
          sessionId: 'conversation-1',
        },
      });

      await session.close();
    });

    it('deliverTurn after restore uses resume instead of sessionId', async () => {
      const harness = new ClaudeAgentsHarness();
      Reflect.set(harness, 'loadSdkModule', async () => ({
        query: mockQuery,
        tool: mockSdkTool,
        createSdkMcpServer: mockCreateSdkMcpServer,
      }));

      mockQuery.mockImplementation(() => sdkStream([
        {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      ]));

      const session = await harness.openSession(makeConfig(), {
        stateVersion: '1',
        messages: [],
        payload: { transcript: [makeMessage('assistant', 'Restored reply')] },
      });

      await collectEvents(
        session.deliverTurn(
          { messages: [makeMessage('user', 'Resume me')], turnId: 'turn-resume' },
          {},
        ),
      );

      const queryCall = mockQuery.mock.calls[0]?.[0];

      expect(queryCall?.options.resume).toBe('conversation-1');
      expect(queryCall?.options.sessionId).toBeUndefined();

      await session.close();
    });

    it('should yield an error event when the API key is missing', async () => {
      const harness = new ClaudeAgentsHarness();
      await expect(harness.openSession(makeConfig({
        harnessConfigJson: JSON.stringify({ model: 'claude-sonnet-4-6' }),
        secrets: {},
      }))).rejects.toThrow('Missing Anthropic API key for claude-agents harness.');
    });
  });

  describe('message_committed with toolCalls', () => {
    it('should include tool calls in message_committed event', async () => {
      const harness = new ClaudeAgentsHarness();
      Reflect.set(harness, 'loadSdkModule', async () => ({
        query: mockQuery,
        tool: mockSdkTool,
        createSdkMcpServer: mockCreateSdkMcpServer,
      }));

      mockQuery.mockImplementation(() => sdkStream([
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Let me check.' },
              { type: 'tool_use', id: 'toolu_1', name: 'get-weather', input: { city: 'NYC' } },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Sunny, 72F' }],
          },
        },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'The weather is sunny.' }],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      ]));

      const session = await harness.openSession(makeConfig());
      const events = await collectEvents(
        session.deliverTurn(
          { messages: [makeMessage('user', 'Weather?')], turnId: 'turn-1' },
          {},
        ),
      );
      await session.close();

      const committed = events.filter((e) => e.type === 'message_committed');
      expect(committed.length).toBeGreaterThanOrEqual(1);

      const withTools = committed.find(
        (e) => 'toolCalls' in e && Array.isArray(e.toolCalls) && e.toolCalls.length > 0,
      );
      expect(withTools).toBeDefined();
      if (withTools && 'toolCalls' in withTools && Array.isArray(withTools.toolCalls)) {
        expect(withTools.toolCalls).toHaveLength(1);
        expect(withTools.toolCalls[0]).toMatchObject({
          id: 'toolu_1',
          name: 'get-weather',
          status: 'complete',
        });
      }
    });

    it('should include multiple tool calls in message_committed event', async () => {
      const harness = new ClaudeAgentsHarness();
      Reflect.set(harness, 'loadSdkModule', async () => ({
        query: mockQuery,
        tool: mockSdkTool,
        createSdkMcpServer: mockCreateSdkMcpServer,
      }));

      mockQuery.mockImplementation(() => sdkStream([
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'toolu_a', name: 'weather', input: { city: 'NYC' } },
              { type: 'tool_use', id: 'toolu_b', name: 'search', input: { q: 'hello' } },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_a', content: 'Sunny' },
              { type: 'tool_result', tool_use_id: 'toolu_b', content: 'Results' },
            ],
          },
        },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Done.' }],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      ]));

      const session = await harness.openSession(makeConfig());
      const events = await collectEvents(
        session.deliverTurn(
          { messages: [makeMessage('user', 'Do both')], turnId: 'turn-1' },
          {},
        ),
      );
      await session.close();

      const withTools = events.find(
        (e) => e.type === 'message_committed' && 'toolCalls' in e && Array.isArray(e.toolCalls) && e.toolCalls.length > 0,
      );
      expect(withTools).toBeDefined();
      if (withTools && 'toolCalls' in withTools && Array.isArray(withTools.toolCalls)) {
        expect(withTools.toolCalls).toHaveLength(2);
        expect(withTools.toolCalls[0]).toMatchObject({ id: 'toolu_a', name: 'weather' });
        expect(withTools.toolCalls[1]).toMatchObject({ id: 'toolu_b', name: 'search' });
      }
    });

    it('should mark tool call status as error when tool_call_end has error', async () => {
      const harness = new ClaudeAgentsHarness();
      Reflect.set(harness, 'loadSdkModule', async () => ({
        query: mockQuery,
        tool: mockSdkTool,
        createSdkMcpServer: mockCreateSdkMcpServer,
      }));

      mockQuery.mockImplementation(() => sdkStream([
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'toolu_err', name: 'failing-tool', input: { x: 1 } },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_err', content: 'Error occurred', is_error: true }],
          },
        },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'The tool failed.' }],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      ]));

      const session = await harness.openSession(makeConfig());
      const events = await collectEvents(
        session.deliverTurn(
          { messages: [makeMessage('user', 'Run it')], turnId: 'turn-1' },
          {},
        ),
      );
      await session.close();

      const withTools = events.find(
        (e) => e.type === 'message_committed' && 'toolCalls' in e && Array.isArray(e.toolCalls) && e.toolCalls.length > 0,
      );
      expect(withTools).toBeDefined();
      if (withTools && 'toolCalls' in withTools && Array.isArray(withTools.toolCalls)) {
        const errTool = withTools.toolCalls.find((tc) => tc.id === 'toolu_err');
        expect(errTool).toBeDefined();
        if (errTool) {
          expect(errTool).toMatchObject({
            id: 'toolu_err',
            name: 'failing-tool',
            status: 'error',
          });
        }
      }
    });

    it('should emit message_committed for tool-only turns with no text', async () => {
      const harness = new ClaudeAgentsHarness();
      Reflect.set(harness, 'loadSdkModule', async () => ({
        query: mockQuery,
        tool: mockSdkTool,
        createSdkMcpServer: mockCreateSdkMcpServer,
      }));

      mockQuery.mockImplementation(() => sdkStream([
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'toolu_only', name: 'silent-tool', input: {} },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_only', content: 'done' }],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 5, output_tokens: 10 },
        },
      ]));

      const session = await harness.openSession(makeConfig());
      const events = await collectEvents(
        session.deliverTurn(
          { messages: [makeMessage('user', 'Do it')], turnId: 'turn-1' },
          {},
        ),
      );
      await session.close();

      const committed = events.filter((e) => e.type === 'message_committed');
      expect(committed.length).toBeGreaterThanOrEqual(1);

      const toolOnly = committed.find(
        (e) => 'toolCalls' in e && Array.isArray(e.toolCalls),
      );
      expect(toolOnly).toBeDefined();
      if (toolOnly && 'toolCalls' in toolOnly) {
        expect(toolOnly.content).toBe('');
        expect(Array.isArray(toolOnly.toolCalls)).toBe(true);
      }
    });
  });
});
