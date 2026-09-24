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
import type { NativeToolPolicy } from '@stablehand/contracts';

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
    conversationId: '11111111-1111-4111-8111-111111111111',
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

async function collectPrompt(prompt: AsyncIterable<unknown>): Promise<unknown[]> {
  const messages: unknown[] = [];
  for await (const message of prompt) {
    messages.push(message);
  }
  return messages;
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
          conversationId: '11111111-1111-4111-8111-111111111111',
          workspaceDir: '/tmp/workspace',
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

    it('should map hook system messages to custom AG-UI telemetry events', () => {
      const harness = new ClaudeAgentsHarness();

      const events = mapSdkMessage(harness, {
        type: 'system',
        subtype: 'hook_response',
        hook_event: 'Stop',
        hook_name: 'gate-finalization',
        hook_id: 'hook-1',
        session_id: 'claude-session-1',
        uuid: 'sdk-msg-1',
        outcome: 'success',
        exit_code: 0,
        output: '{"decision":"block","reason":"run finalizer"}',
      }, new Map());

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'custom_agui_event',
        event: {
          type: 'CUSTOM',
          subtype: 'claude_hook',
          source: 'claude-agents',
          lifecycle: 'response',
          hookEvent: 'Stop',
          hookName: 'gate-finalization',
          hookId: 'hook-1',
          claudeSessionId: 'claude-session-1',
          sdkMessageId: 'sdk-msg-1',
          outcome: 'success',
          exitCode: 0,
          output: '{"decision":"block","reason":"run finalizer"}',
        },
      });
    });

    it('maps hook started, progress, and response lifecycle telemetry with truncation', () => {
      const harness = new ClaudeAgentsHarness();
      const longOutput = 'x'.repeat(2_100);

      const events = [
        ...mapSdkMessage(harness, {
          type: 'system',
          subtype: 'hook_started',
          hook_event: 'PreToolUse',
          hook_name: 'guard',
          hook_id: 'hook-start',
        }, new Map()),
        ...mapSdkMessage(harness, {
          type: 'system',
          subtype: 'hook_progress',
          hook_event: 'PreToolUse',
          hook_name: 'guard',
          hook_id: 'hook-progress',
          stdout: longOutput,
        }, new Map()),
        ...mapSdkMessage(harness, {
          type: 'system',
          subtype: 'hook_response',
          hook_event: 'PreToolUse',
          hook_name: 'guard',
          hook_id: 'hook-response',
          outcome: 'success',
          exit_code: 0,
        }, new Map()),
      ];

      expect(events).toHaveLength(3);
      expect(events.map((event) =>
        event.type === 'custom_agui_event' ? event.event.lifecycle : undefined,
      )).toEqual(['started', 'progress', 'response']);
      expect(events[1]).toMatchObject({
        type: 'custom_agui_event',
        event: {
          subtype: 'claude_hook',
          hookName: 'guard',
          hookId: 'hook-progress',
          truncated: true,
        },
      });
      const progress = events[1];
      expect(progress.type === 'custom_agui_event' ? progress.event.stdout : '').toContain('[truncated]');
    });

    it('maps Claude init messages to runtime capability telemetry including /goal support', () => {
      const harness = new ClaudeAgentsHarness();

      const events = mapSdkMessage(harness, {
        type: 'system',
        subtype: 'init',
        apiKeySource: 'environment',
        claude_code_version: '2.1.195',
        cwd: '/workspace',
        tools: ['Read', 'Write'],
        mcp_servers: [{ name: 'stablehand', status: 'connected' }],
        model: 'claude-sonnet-4-6',
        permissionMode: 'bypassPermissions',
        slash_commands: ['clear', 'goal'],
        output_style: 'default',
        skills: ['code-review'],
        plugins: [],
        uuid: 'sdk-init-1',
        session_id: 'claude-session-1',
      }, new Map());

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'custom_agui_event',
        event: {
          type: 'CUSTOM',
          name: 'stablehand.claude.runtime_capabilities',
          subtype: 'claude_runtime_capabilities',
          source: 'claude-agents',
          claudeCodeVersion: '2.1.195',
          claudeSessionId: 'claude-session-1',
          model: 'claude-sonnet-4-6',
          permissionMode: 'bypassPermissions',
          slashCommands: ['clear', 'goal'],
          supportsGoal: true,
          tools: ['Read', 'Write'],
          mcpServers: [{ name: 'stablehand', status: 'connected' }],
        },
      });
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
            costUsd: 0.005,
          },
        },
      ]);
    });
  });

  describe('openSession() and deliverTurn()', () => {
    it('passes an explicit native-tool allow policy and the stablehand MCP server into query()', async () => {
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
        nativeToolPolicy: {
          policy: 'allow',
          names: ['native-read'],
        },
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
        name: 'stablehand',
        tools: [expect.objectContaining({ name: 'ctx-tool' })],
      });
      expect(queryCall?.options.allowedTools).toEqual(['native-read', 'mcp__stablehand__*']);
      expect(queryCall?.options.disallowedTools).toEqual([]);
      expect(queryCall?.options.mcpServers).toEqual({
        stablehand: {
          type: 'sdk',
          name: 'stablehand',
        },
      });
      expect(queryCall?.options.cwd).toBe('/tmp/workspace');
      expect(queryCall?.options.settingSources).toEqual(['project']);
      expect(queryCall?.options.permissionMode).toBe('bypassPermissions');
      expect(queryCall?.options.includeHookEvents).toBe(true);
      expect(queryCall?.options.includePartialMessages).toBe(true);
      expect(queryCall?.options.maxTurns).toBe(4);
    });

    it.each([
      {
        label: 'all',
        nativeToolPolicy: { policy: 'all' } as NativeToolPolicy,
        allowedTools: [],
        disallowedTools: [],
      },
      {
        label: 'deny',
        nativeToolPolicy: { policy: 'deny', names: ['Bash'] } as NativeToolPolicy,
        allowedTools: [],
        disallowedTools: ['Bash'],
      },
      {
        label: 'none',
        nativeToolPolicy: { policy: 'none' } as NativeToolPolicy,
        allowedTools: ['mcp__stablehand__*'],
        disallowedTools: [],
      },
    ])('enforces the $label native-tool policy', async ({
      nativeToolPolicy,
      allowedTools,
      disallowedTools,
    }) => {
      const harness = new ClaudeAgentsHarness();
      Reflect.set(harness, 'loadSdkModule', async () => ({
        query: mockQuery,
        tool: mockSdkTool,
        createSdkMcpServer: mockCreateSdkMcpServer,
      }));
      mockQuery.mockImplementation(() => sdkStream([{
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 1, output_tokens: 1 },
      }]));

      const session = await harness.openSession(makeConfig({ nativeToolPolicy }));
      await collectEvents(session.deliverTurn(
        { messages: [makeMessage('user', 'Hello')], turnId: 'turn-policy' },
        {},
      ));
      const queryCall = mockQuery.mock.calls[0]?.[0];
      await session.close();

      expect(queryCall?.options.allowedTools).toEqual(allowedTools);
      expect(queryCall?.options.disallowedTools).toEqual(disallowedTools);
    });

    it('commits a native /goal result even when Claude only returns terminal result text', async () => {
      const harness = new ClaudeAgentsHarness();
      Reflect.set(harness, 'loadSdkModule', async () => ({
        query: mockQuery,
        tool: mockSdkTool,
        createSdkMcpServer: mockCreateSdkMcpServer,
      }));

      mockQuery.mockImplementation(() => sdkStream([
        {
          type: 'system',
          subtype: 'init',
          apiKeySource: 'environment',
          claude_code_version: '2.1.195',
          cwd: '/tmp/workspace',
          tools: ['Read'],
          mcp_servers: [{ name: 'stablehand', status: 'connected' }],
          model: 'claude-sonnet-4-6',
          permissionMode: 'bypassPermissions',
          slash_commands: ['goal'],
          output_style: 'default',
          skills: [],
          plugins: [],
          uuid: 'sdk-init-goal',
          session_id: 'claude-session-goal',
        },
        {
          type: 'result',
          subtype: 'success',
          result: 'GOAL_OK',
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      ]));

      const session = await harness.openSession(makeConfig());
      const events = await collectEvents(
        session.deliverTurn(
          {
            messages: [
              makeMessage(
                'user',
                '/goal The assistant has replied with exactly the token GOAL_OK in its final answer. Reply with exactly GOAL_OK.',
              ),
            ],
            turnId: 'turn-goal',
          },
          {},
        ),
      );
      await session.close();

      expect(events).toEqual([
        expect.objectContaining({
          type: 'custom_agui_event',
          event: expect.objectContaining({
            subtype: 'claude_runtime_capabilities',
            supportsGoal: true,
            claudeCodeVersion: '2.1.195',
          }),
        }),
        {
          type: 'message_committed',
          role: 'assistant',
          content: 'GOAL_OK',
          turnId: 'turn-goal',
          messageSeq: 1,
        },
        {
          type: 'done',
          result: 'GOAL_OK',
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        },
      ]);
    });

    it('allows the Claude Skill tool when project skills are configured', async () => {
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

      const session = await harness.openSession(makeConfig({
        nativeToolPolicy: { policy: 'allow', names: ['Skill'] },
        harnessConfigJson: JSON.stringify({
          model: 'claude-sonnet-4-6',
          apiKeyRef: 'anthropic',
          setup: {
            symlinks: [{ src: 'skills', dest: '.claude/skills' }],
          },
        }),
      }));

      await collectEvents(
        session.deliverTurn(
          { messages: [makeMessage('user', 'Hello')], turnId: 'turn-1' },
          {},
        ),
      );

      await session.close();

      const queryCall = mockQuery.mock.calls[0]?.[0];
      expect(queryCall?.options.allowedTools).toEqual(['Skill', 'mcp__stablehand__*']);
    });

    it('preserves subagent skills and allows Agent plus Skill tools', async () => {
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

      const session = await harness.openSession(makeConfig({
        nativeToolPolicy: { policy: 'allow', names: ['Agent', 'Skill'] },
        harnessConfigJson: JSON.stringify({
          model: 'claude-sonnet-4-6',
          apiKeyRef: 'anthropic',
          subagents: {
            reviewer: {
              description: 'Reviews code',
              prompt: 'Review the code.',
              skills: ['code-review'],
            },
          },
        }),
      }));

      await collectEvents(
        session.deliverTurn(
          { messages: [makeMessage('user', 'Hello')], turnId: 'turn-1' },
          {},
        ),
      );

      await session.close();

      const queryCall = mockQuery.mock.calls[0]?.[0];
      expect(queryCall?.options.allowedTools).toEqual(['Agent', 'Skill', 'mcp__stablehand__*']);
      expect(queryCall?.options.agents).toEqual({
        reviewer: {
          description: 'Reviews code',
          prompt: 'Review the code.',
          skills: ['code-review'],
        },
      });
    });

    it('logs Claude hook lifecycle messages surfaced by the SDK', async () => {
      const harness = new ClaudeAgentsHarness();
      Reflect.set(harness, 'loadSdkModule', async () => ({
        query: mockQuery,
        tool: mockSdkTool,
        createSdkMcpServer: mockCreateSdkMcpServer,
      }));
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      mockQuery.mockImplementation(() => sdkStream([
        {
          type: 'system',
          subtype: 'hook_started',
          hook_id: 'hook-1',
          hook_name: 'lint-hook',
          hook_event: 'PreToolUse',
          uuid: 'uuid-1',
          session_id: 'session-1',
        },
        {
          type: 'system',
          subtype: 'hook_response',
          hook_id: 'hook-1',
          hook_name: 'lint-hook',
          hook_event: 'PreToolUse',
          output: 'ok\n',
          stdout: 'ok\n',
          stderr: '',
          exit_code: 0,
          outcome: 'success',
          uuid: 'uuid-2',
          session_id: 'session-1',
        },
        {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      ]));

      try {
        const session = await harness.openSession(makeConfig());
        await collectEvents(
          session.deliverTurn(
            { messages: [makeMessage('user', 'Hello')], turnId: 'turn-1' },
            {},
          ),
        );

        await session.close();
        expect(logSpy).toHaveBeenCalledWith(
          '[claude-agents] hook started event=PreToolUse name=lint-hook id=hook-1',
        );
        expect(logSpy).toHaveBeenCalledWith(
          '[claude-agents] hook response event=PreToolUse name=lint-hook id=hook-1 outcome=success exitCode=0 output=ok',
        );
      } finally {
        logSpy.mockRestore();
      }
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
          { messages: [restoredMessage, userMessage], turnId: 'turn-restore' },
          {},
        ),
      );

      await expect(session.exportState()).resolves.toMatchObject({
        stateVersion: '2',
        payload: {
          transcript: [restoredMessage, userMessage],
          sessionId: '11111111-1111-4111-8111-111111111111',
        },
      });

      await session.close();
    });

    it('checkpoint restore without session JSONL replays readable tool-call context before continuing', async () => {
      const harness = new ClaudeAgentsHarness();
      let capturedPrompt: unknown[] = [];
      let capturedQuery: Record<string, unknown> | undefined;
      Reflect.set(harness, 'loadSdkModule', async () => ({
        query: mockQuery,
        tool: mockSdkTool,
        createSdkMcpServer: mockCreateSdkMcpServer,
      }));

      mockQuery.mockImplementation((queryArg: Record<string, unknown>) => {
        capturedQuery = queryArg;
        return (async function* () {
          capturedPrompt = await collectPrompt(queryArg.prompt as AsyncIterable<unknown>);
          yield {
            type: 'result',
            subtype: 'success',
            usage: { input_tokens: 1, output_tokens: 2 },
          };
        })();
      });

      const restoredUser = makeMessage('user', 'Check the weather');
      const restoredAssistant: Message = {
        ...makeMessage('assistant', 'I will use the weather tool.'),
        toolCalls: [
          {
            id: 'toolu_weather',
            name: 'get-weather',
            arguments: { city: 'NYC' },
          },
        ],
      };
      const restoredTool: Message = {
        ...makeMessage('tool', 'Sunny and 72F'),
        toolCallId: 'toolu_weather',
      };
      const nextUser = makeMessage('user', 'Continue from there');
      const session = await harness.openSession(makeConfig(), {
        stateVersion: '2',
        messages: [],
        payload: { transcript: [restoredUser, restoredAssistant, restoredTool] },
      });

      await collectEvents(
        session.deliverTurn(
          { messages: [restoredUser, restoredAssistant, restoredTool, nextUser], turnId: 'turn-checkpoint-restore' },
          {},
        ),
      );

      expect(capturedQuery?.options).toMatchObject({ sessionId: '11111111-1111-4111-8111-111111111111' });
      expect((capturedQuery?.options as Record<string, unknown>).resume).toBeUndefined();
      expect(capturedPrompt).toEqual([
        {
          type: 'user',
          message: { role: 'user', content: 'Check the weather' },
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              '[Previous assistant response]',
              'I will use the weather tool.',
              '[Previous assistant tool calls]',
              '- toolu_weather: get-weather {"city":"NYC"}',
            ].join('\n'),
          },
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: '[Previous tool output (toolu_weather)]\nSunny and 72F',
          },
        },
        {
          type: 'user',
          message: { role: 'user', content: 'Continue from there' },
        },
      ]);

      await session.close();
    });

    it('session JSONL restore resumes the Claude SDK session and sends only the latest user prompt', async () => {
      const harness = new ClaudeAgentsHarness();
      let capturedPrompt: unknown[] = [];
      let capturedQuery: Record<string, unknown> | undefined;
      Reflect.set(harness, 'loadSdkModule', async () => ({
        query: mockQuery,
        tool: mockSdkTool,
        createSdkMcpServer: mockCreateSdkMcpServer,
      }));

      mockQuery.mockImplementation((queryArg: Record<string, unknown>) => {
        capturedQuery = queryArg;
        return (async function* () {
          capturedPrompt = await collectPrompt(queryArg.prompt as AsyncIterable<unknown>);
          yield {
            type: 'result',
            subtype: 'success',
            usage: { input_tokens: 1, output_tokens: 2 },
          };
        })();
      });

      const restoredMessage = makeMessage('assistant', 'Restored reply');
      const userMessage = makeMessage('user', 'Resume with SDK state');
      const session = await harness.openSession(makeConfig(), {
        stateVersion: '2',
        messages: [],
        payload: {
          transcript: [restoredMessage],
          sessionJSONL: '{"type":"assistant"}\n',
        },
      });

      await collectEvents(
        session.deliverTurn(
          { messages: [restoredMessage, userMessage], turnId: 'turn-jsonl-restore' },
          {},
        ),
      );

      expect(capturedQuery?.options).toMatchObject({ resume: '11111111-1111-4111-8111-111111111111' });
      expect((capturedQuery?.options as Record<string, unknown>).sessionId).toBeUndefined();
      expect(capturedPrompt).toEqual([
        {
          type: 'user',
          message: { role: 'user', content: 'Resume with SDK state' },
        },
      ]);

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

      const restoredMessage = makeMessage('assistant', 'Restored reply');
      const userMessage1 = makeMessage('user', 'Resume me');
      const userMessage2 = makeMessage('user', 'Second turn');
      const session = await harness.openSession(makeConfig(), {
        stateVersion: '1',
        messages: [],
        payload: { transcript: [restoredMessage] },
      });

      await collectEvents(
        session.deliverTurn(
          { messages: [restoredMessage, userMessage1], turnId: 'turn-resume' },
          {},
        ),
      );

      const firstQueryCall = mockQuery.mock.calls[0]?.[0];
      expect(firstQueryCall?.options.sessionId).toBe('11111111-1111-4111-8111-111111111111');
      expect(firstQueryCall?.options.resume).toBeUndefined();

      await collectEvents(
        session.deliverTurn(
          { messages: [restoredMessage, userMessage1, userMessage2], turnId: 'turn-second' },
          {},
        ),
      );

      const secondQueryCall = mockQuery.mock.calls[1]?.[0];
      expect(secondQueryCall?.options.resume).toBe('11111111-1111-4111-8111-111111111111');
      expect(secondQueryCall?.options.sessionId).toBeUndefined();

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

    it('commits a multi-step autonomous loop with hooks, text, tools, and final done in order', async () => {
      const harness = new ClaudeAgentsHarness();
      Reflect.set(harness, 'loadSdkModule', async () => ({
        query: mockQuery,
        tool: mockSdkTool,
        createSdkMcpServer: mockCreateSdkMcpServer,
      }));

      mockQuery.mockImplementation(() => sdkStream([
        {
          type: 'system',
          subtype: 'hook_started',
          hook_event: 'PreToolUse',
          hook_name: 'loop-guard',
          hook_id: 'hook-loop',
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Step 1: write state. ' },
              { type: 'tool_use', id: 'toolu_write', name: 'Write', input: { file_path: 'state.txt', content: 'alpha' } },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_write', content: 'wrote state.txt' }],
          },
        },
        {
          type: 'system',
          subtype: 'hook_response',
          hook_event: 'PostToolUse',
          hook_name: 'loop-guard',
          hook_id: 'hook-loop',
          outcome: 'success',
          exit_code: 0,
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Step 2: read state. ' },
              { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'state.txt' } },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'alpha' }],
          },
        },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Loop complete.' }],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 30, output_tokens: 40 },
        },
      ]));

      const session = await harness.openSession(makeConfig());
      const events = await collectEvents(
        session.deliverTurn(
          { messages: [makeMessage('user', 'Run a loop until state is checked')], turnId: 'turn-loop' },
          {},
        ),
      );
      await session.close();

      const eventTypes = events.map((event) => event.type);
      expect(eventTypes).toContain('custom_agui_event');
      expect(eventTypes.indexOf('message_committed')).toBeLessThan(eventTypes.indexOf('done'));

      const committed = events.find((event) => event.type === 'message_committed');
      expect(committed).toMatchObject({
        type: 'message_committed',
        content: 'Step 1: write state. Step 2: read state. Loop complete.',
      });
      expect(committed && 'toolCalls' in committed ? committed.toolCalls : undefined).toEqual([
        expect.objectContaining({
          id: 'toolu_write',
          name: 'Write',
          arguments: { file_path: 'state.txt', content: 'alpha' },
          status: 'complete',
        }),
        expect.objectContaining({
          id: 'toolu_read',
          name: 'Read',
          arguments: { file_path: 'state.txt' },
          status: 'complete',
        }),
      ]);
      expect(events.at(-1)).toEqual({
        type: 'done',
        usage: { inputTokens: 30, outputTokens: 40, totalTokens: 70 },
      });
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
