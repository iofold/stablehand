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

import { ClaudeAgentsHarness } from '../../packages/ctxmill/src/harness/claude-agents.js';
import type { AgentEvent, AgentHarness, HarnessSessionConfig } from '../../packages/ctxmill/src/harness/types.js';
import type { ToolDefinition } from '../../packages/ctxmill/src/tool/types.js';
import type { Message } from '../../packages/ctxmill/src/types.js';

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
      expect(queryCall?.options.includePartialMessages).toBe(true);
      expect(queryCall?.options.maxTurns).toBe(4);
    });

    it('should yield an error event when the API key is missing', async () => {
      const harness = new ClaudeAgentsHarness();
      await expect(harness.openSession(makeConfig({
        harnessConfigJson: JSON.stringify({ model: 'claude-sonnet-4-6' }),
        secrets: {},
      }))).rejects.toThrow('Missing Anthropic API key for claude-agents harness.');
    });
  });
});
