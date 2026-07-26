import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SystemMessage } from '@langchain/core/messages';
import type { AgentEvent, HarnessSessionConfig } from '../types.js';
import type { Message } from '../../types.js';
import type { ToolDefinition } from '../../tool/types.js';
import type { NativeToolPolicy } from '@ctxmill/contracts';
import {
  assertAbortContract,
  assertApprovalFlowContract,
  assertPlainTextTurnContract,
  assertRestorePromptShape,
  assertToolErrorContract,
  assertToolRoundTripContract,
} from './contract/assert-agent-event-contract.js';

const mockStreamEvents = vi.fn();
const mockCreateDeepAgent = vi.fn((_config?: Record<string, unknown>) => ({
  streamEvents: mockStreamEvents,
}));
const mockLangSmith = vi.hoisted(() => {
  class FakeClient {
    awaitPendingTraceBatches = vi.fn(async () => undefined);
  }

  class FakeRunTree {
    static runs: FakeRunTree[] = [];

    readonly children: FakeRunTree[] = [];
    readonly postRun = vi.fn(async () => undefined);
    readonly end = vi.fn(async (_outputs?: Record<string, unknown>) => undefined);
    readonly patchRun = vi.fn(async () => undefined);

    constructor(readonly config: Record<string, unknown>) {
      FakeRunTree.runs.push(this);
    }

    createChild(config: Record<string, unknown>): FakeRunTree {
      const child = new FakeRunTree(config);
      this.children.push(child);
      return child;
    }
  }

  return { FakeClient, FakeRunTree };
});

vi.mock('langsmith', () => ({
  Client: mockLangSmith.FakeClient,
  RunTree: mockLangSmith.FakeRunTree,
}));

const mockLocalShellBackendOptions: Array<Record<string, unknown>> = [];

class MockLocalShellBackend {
  constructor(options: Record<string, unknown>) {
    mockLocalShellBackendOptions.push(options);
  }
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

type LangChainToolWrapper = {
  invoke: (args: Record<string, unknown>) => Promise<unknown>;
};

type BuildLangChainTools = (
  ctx: {
    agentId: string;
    conversationId: string;
    turnId?: string;
    workspaceDir: string;
  },
  turnId: string,
  toolDefs: ToolDefinition[],
  onApprovalNeeded: (request: {
    id: string;
    turnId: string;
    toolName: string;
    args: Record<string, unknown>;
  }) => Promise<{ action: 'approve' | 'reject' }>,
  queuedEvents?: AgentEvent[],
) => LangChainToolWrapper[];

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
    mockLocalShellBackendOptions.length = 0;
    mockLangSmith.FakeRunTree.runs = [];
    delete process.env.LANGSMITH_TRACING;
    delete process.env.LANGSMITH_PROJECT;
    mockCreateDeepAgent.mockReturnValue({
      streamEvents: mockStreamEvents,
    });
  });

  it.each([
    {
      label: 'allow',
      nativeToolPolicy: { policy: 'allow', names: ['read_file'] } as NativeToolPolicy,
      readFileBlocked: false,
      executeBlocked: true,
    },
    {
      label: 'deny',
      nativeToolPolicy: { policy: 'deny', names: ['execute'] } as NativeToolPolicy,
      readFileBlocked: false,
      executeBlocked: true,
    },
    {
      label: 'none',
      nativeToolPolicy: { policy: 'none' } as NativeToolPolicy,
      readFileBlocked: true,
      executeBlocked: true,
    },
  ])('enforces the $label native-tool policy without blocking ctxmill tools', async ({
    nativeToolPolicy,
    readFileBlocked,
    executeBlocked,
  }) => {
    mockStreamEvents.mockImplementation(() => langGraphStream([{
      event: 'on_chat_model_stream',
      data: { chunk: { content: 'Done.' } },
    }]));
    const customTool: ToolDefinition = {
      name: 'ctxmill_search',
      description: 'Search ctxmill data',
      input: z.object({ query: z.string() }),
      handler: async () => 'result',
    };
    const messages = [makeMessage('user', 'Use tools')];
    const session = await openRestoredTestSession({
      stateVersion: '1',
      messages,
      payload: { transcript: messages },
    }, makeConfig({ nativeToolPolicy, tools: [customTool] }));

    try {
      await collectEvents(session.deliverTurn({ messages, turnId: 'turn-policy' }, {}));
      const params = mockCreateDeepAgent.mock.calls[0]?.[0] as {
        middleware?: Array<{
          name?: string;
          beforeToolCall?: (call: { name: string }) => { blocked: boolean };
        }>;
      } | undefined;
      const middleware = params?.middleware?.find((candidate) =>
        candidate.name === 'ctxmill-native-tool-policy',
      );

      expect(middleware?.beforeToolCall?.({ name: 'read_file' })).toEqual(expect.objectContaining({
        blocked: readFileBlocked,
      }));
      expect(middleware?.beforeToolCall?.({ name: 'execute' })).toEqual(expect.objectContaining({
        blocked: executeBlocked,
      }));
      expect(middleware?.beforeToolCall?.({ name: 'ctxmill_search' })).toEqual({ blocked: false });
    } finally {
      await session.close();
    }
  });

  it.each([
    ['an omitted policy', undefined],
    ['the all policy', { policy: 'all' } as NativeToolPolicy],
  ])('does not install native-tool policy middleware for %s', async (_label, nativeToolPolicy) => {
    mockStreamEvents.mockImplementation(() => langGraphStream([{
      event: 'on_chat_model_stream',
      data: { chunk: { content: 'Done.' } },
    }]));
    const messages = [makeMessage('user', 'Use tools')];
    const session = await openRestoredTestSession({
      stateVersion: '1',
      messages,
      payload: { transcript: messages },
    }, makeConfig({ nativeToolPolicy }));

    try {
      await collectEvents(session.deliverTurn({ messages, turnId: 'turn-policy-all' }, {}));
      const params = mockCreateDeepAgent.mock.calls[0]?.[0] as {
        middleware?: Array<{ name?: string }>;
      } | undefined;
      expect(params?.middleware).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'ctxmill-native-tool-policy' }),
      ]));
    } finally {
      await session.close();
    }
  });

  it('collapses text-only system prompt fragments before each model call', async () => {
    mockStreamEvents.mockImplementation(() => langGraphStream([{
      event: 'on_chat_model_stream',
      data: { chunk: { content: 'Done.' } },
    }]));
    const messages = [makeMessage('user', 'Use tools')];
    const session = await openRestoredTestSession({
      stateVersion: '1',
      messages,
      payload: { transcript: messages },
    });

    try {
      await collectEvents(session.deliverTurn({ messages, turnId: 'turn-system-message' }, {}));
      const params = mockCreateDeepAgent.mock.calls[0]?.[0] as {
        middleware?: Array<{
          name?: string;
          wrapModelCall?: (
            request: Record<string, unknown>,
            handler: (request: Record<string, unknown>) => Promise<unknown>,
          ) => Promise<unknown>;
        }>;
      } | undefined;
      const middleware = params?.middleware?.find((candidate) =>
        candidate.name === 'ctxmill-system-message-compatibility',
      );
      const handler = vi.fn(async (request: Record<string, unknown>) => request);

      await middleware?.wrapModelCall?.({
        systemPrompt: 'First\nSecond',
        systemMessage: new SystemMessage({
          content: [
            { type: 'text', text: 'First' },
            { type: 'text', text: 'Second' },
          ],
        }),
      }, handler);

      const forwarded = handler.mock.calls[0]?.[0] as {
        systemMessage?: SystemMessage;
      } | undefined;
      expect(forwarded?.systemMessage?.content).toBe('First\nSecond');
    } finally {
      await session.close();
    }
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
    }, expect.objectContaining({ version: 'v2' }));
    const streamInput = mockStreamEvents.mock.calls[0]?.[0] as {
      messages?: Array<{ content: string }>;
    } | undefined;
    assertRestorePromptShape(streamInput?.messages?.map((message) => message.content) ?? [], [
      'System context',
      'Use the tool',
      'Calling the tool now',
      'Tool output: success',
      'Continue from that result',
    ]);
  });

  it('passes each turn secret to model resolution and the shell backend without mutating process.env', async () => {
    const tokenKey = 'PILOT_TURN_OWNERSHIP_TOKEN';
    const previousToken = process.env[tokenKey];
    process.env[tokenKey] = 'stable-token';
    mockStreamEvents.mockImplementation(() => langGraphStream([
      {
        event: 'on_chat_model_stream',
        data: { chunk: { content: 'Done.' } },
      },
    ]));

    const messages = [makeMessage('user', 'Turn A')];
    const session = await openRestoredTestSession({
      stateVersion: '1',
      messages,
      payload: { transcript: messages },
    });
    const buildModelFromConfig = vi.fn(async () => createMockChatModel());
    Reflect.set(session, 'buildModelFromConfig', buildModelFromConfig);

    try {
      await collectEvents(session.deliverTurn(
        { messages, turnId: 'turn-secret-a' },
        { turnSecrets: { [tokenKey]: 'turn-token-a' } },
      ));
      expect(process.env[tokenKey]).toBe('stable-token');

      const secondMessages = [makeMessage('user', 'Turn B')];
      await collectEvents(session.deliverTurn(
        { messages: secondMessages, turnId: 'turn-secret-b' },
        { turnSecrets: { [tokenKey]: 'turn-token-b' } },
      ));
      expect(process.env[tokenKey]).toBe('stable-token');

      expect(buildModelFromConfig).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ [tokenKey]: 'turn-token-a' }),
        'turn-secret-a',
      );
      expect(buildModelFromConfig).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ [tokenKey]: 'turn-token-b' }),
        'turn-secret-b',
      );
      const firstEnv = mockLocalShellBackendOptions[0]?.env as Record<string, string> | undefined;
      const secondEnv = mockLocalShellBackendOptions[1]?.env as Record<string, string> | undefined;
      expect(firstEnv?.[tokenKey]).toBe('turn-token-a');
      expect(secondEnv?.[tokenKey]).toBe('turn-token-b');
    } finally {
      await session.close();
      if (previousToken === undefined) {
        delete process.env[tokenKey];
      } else {
        process.env[tokenKey] = previousToken;
      }
    }
  });

  it('satisfies the shared plain-text turn contract', async () => {
    mockStreamEvents.mockImplementation(() => langGraphStream([
      {
        event: 'on_chat_model_stream',
        data: { chunk: { content: 'LangGraph contract reply' } },
      },
    ]));

    const turnId = 'turn-langgraph-contract';
    const messages = [makeMessage('user', 'Hello')];
    const session = await openRestoredTestSession({
      stateVersion: '1',
      messages,
      payload: { transcript: messages },
    });

    try {
      const events = await collectEvents(session.deliverTurn({ messages, turnId }, {}));
      const exportedState = await session.exportState();

      assertPlainTextTurnContract({
        events: events as AgentEvent[],
        turnId,
        exportedState,
        expectedContent: 'LangGraph contract reply',
        requireDoneUsage: false,
      });
    } finally {
      await session.close();
    }
  });

  it('satisfies the shared tool round-trip contract', async () => {
    mockStreamEvents.mockImplementation(() => langGraphStream([
      {
        event: 'on_chat_model_stream',
        data: {
          chunk: {
            content: 'LangGraph used search.',
            tool_call_chunks: [{ id: 'tool-langgraph-search', name: 'search' }],
          },
        },
      },
      {
        event: 'on_tool_start',
        name: 'search',
        run_id: 'run-langgraph-search',
        data: { input: { query: 'ctxmill' } },
      },
      {
        event: 'on_tool_end',
        run_id: 'run-langgraph-search',
        data: { output: 'langgraph search result' },
      },
    ]));

    const turnId = 'turn-langgraph-tool-contract';
    const messages = [makeMessage('user', 'Search')];
    const session = await openRestoredTestSession({
      stateVersion: '1',
      messages,
      payload: { transcript: messages },
    });

    try {
      const events = await collectEvents(session.deliverTurn({ messages, turnId }, {}));
      const exportedState = await session.exportState();

      assertToolRoundTripContract({
        events: events as AgentEvent[],
        turnId,
        exportedState,
        expectedContent: 'LangGraph used search.',
        requireDoneUsage: false,
        expectedTool: {
          id: 'tool-langgraph-search',
          name: 'search',
          args: { query: 'ctxmill' },
          result: 'langgraph search result',
        },
      });
    } finally {
      await session.close();
    }
  });

  it('traces LangGraph normalized AgentEvents through the shared decorator', async () => {
    process.env.LANGSMITH_TRACING = 'true';
    process.env.LANGSMITH_PROJECT = 'ctxmill-test';
    mockStreamEvents.mockImplementation(() => langGraphStream([
      {
        event: 'on_chat_model_stream',
        data: { chunk: { content: 'LangGraph traced reply' } },
      },
    ]));

    const turnId = 'turn-langgraph-traced';
    const messages = [makeMessage('user', 'Trace this')];
    const session = await openRestoredTestSession({
      stateVersion: '1',
      messages,
      payload: { transcript: messages },
    });

    try {
      await collectEvents(session.deliverTurn({ messages, turnId }, {}));
    } finally {
      await session.close();
    }

    const root = mockLangSmith.FakeRunTree.runs[0];
    expect(root.config).toEqual(expect.objectContaining({
      name: 'langgraph-agent-agent-1',
      run_type: 'chain',
      project_name: 'ctxmill-test',
    }));
    const turn = root.children[0];
    expect(turn.config).toEqual(expect.objectContaining({
      name: 'langgraph-turn',
      inputs: { turnId },
    }));
    const llm = turn.children.find((child) => child.config.run_type === 'llm');
    expect(llm?.end).toHaveBeenCalledWith(expect.objectContaining({
      generations: [{ text: 'LangGraph traced reply' }],
    }));
    expect(root.end).toHaveBeenCalledWith({ status: 'completed' });
  });

  it('satisfies the shared tool-error contract', async () => {
    mockStreamEvents.mockImplementation(() => langGraphStream([
      {
        event: 'on_chat_model_stream',
        data: {
          chunk: {
            tool_call_chunks: [{ id: 'tool-langgraph-error', name: 'search' }],
          },
        },
      },
      {
        event: 'on_tool_start',
        name: 'search',
        run_id: 'run-langgraph-error',
        data: { input: { query: 'bad' } },
      },
      {
        event: 'on_tool_error',
        run_id: 'run-langgraph-error',
        data: { error: new Error('langgraph search failed') },
      },
    ]));

    const turnId = 'turn-langgraph-tool-error-contract';
    const messages = [makeMessage('user', 'Search badly')];
    const session = await openRestoredTestSession({
      stateVersion: '1',
      messages,
      payload: { transcript: messages },
    });

    try {
      const events = await collectEvents(session.deliverTurn({ messages, turnId }, {}));
      const exportedState = await session.exportState();

      assertToolErrorContract({
        events: events as AgentEvent[],
        turnId,
        exportedState,
        requireDoneUsage: false,
        expectedTool: {
          id: 'tool-langgraph-error',
          name: 'search',
          args: { query: 'bad' },
          error: 'langgraph search failed',
        },
      });
    } finally {
      await session.close();
    }
  });

  it('satisfies the shared approval approve contract', async () => {
    const approvalTool: ToolDefinition = {
      name: 'guarded_search',
      description: 'Searches with approval',
      input: z.object({ query: z.string() }),
      requiresApproval: true,
      handler: vi.fn(async () => 'approved result'),
    };
    const approvalEvents: AgentEvent[] = [];
    const turnId = 'turn-langgraph-approval-approved';
    const session = await openRestoredTestSession({
      stateVersion: '1',
      messages: [],
      payload: { transcript: [] },
    });
    try {
      const buildTools = Reflect.get(session, 'buildLangChainTools') as BuildLangChainTools;
      const tools = buildTools.call(
        session,
        {
          agentId: 'agent-1',
          conversationId: 'conversation-1',
          workspaceDir: '/tmp/workspace',
        },
        turnId,
        [approvalTool],
        vi.fn(async () => ({ action: 'approve' as const })),
        approvalEvents,
      );
      const tool = tools[0];
      if (!tool) {
        throw new Error('Expected wrapped tool');
      }

      await expect(tool.invoke({ query: 'allowed' })).resolves.toBe('approved result');
      assertApprovalFlowContract(approvalEvents, {
        tool: 'guarded_search',
        action: 'approve',
        args: { query: 'allowed' },
      });
    } finally {
      await session.close();
    }
  });

  it('satisfies the shared approval reject contract', async () => {
    const approvalTool: ToolDefinition = {
      name: 'guarded_search',
      description: 'Searches with approval',
      input: z.object({ query: z.string() }),
      requiresApproval: true,
      handler: vi.fn(async () => 'approved result'),
    };
    const approvalEvents: AgentEvent[] = [];
    const turnId = 'turn-langgraph-approval-rejected';
    const session = await openRestoredTestSession({
      stateVersion: '1',
      messages: [],
      payload: { transcript: [] },
    });
    try {
      const buildTools = Reflect.get(session, 'buildLangChainTools') as BuildLangChainTools;
      const tools = buildTools.call(
        session,
        {
          agentId: 'agent-1',
          conversationId: 'conversation-1',
          workspaceDir: '/tmp/workspace',
        },
        turnId,
        [approvalTool],
        vi.fn(async () => ({ action: 'reject' as const })),
        approvalEvents,
      );
      const tool = tools[0];
      if (!tool) {
        throw new Error('Expected wrapped tool');
      }

      await expect(tool.invoke({ query: 'blocked' })).resolves.toBe('Tool call was rejected by the user.');
      assertApprovalFlowContract(approvalEvents, {
        tool: 'guarded_search',
        action: 'reject',
        args: { query: 'blocked' },
      });
    } finally {
      await session.close();
    }
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

  it('returns cleanly (no error event) when context.signal is aborted while streamEvents hangs', async () => {
    // Simulate a blocked LLM call that never yields
    mockStreamEvents.mockImplementation(async function* () {
      await new Promise<never>(() => {});
      yield undefined as never;
    });

    const messages = [makeMessage('user', 'Hello')];
    const session = await openRestoredTestSession({
      stateVersion: '1',
      messages,
      payload: { transcript: messages },
    });

    const ac = new AbortController();
    // Abort after a short delay to simulate killSession firing mid-stream
    setTimeout(() => ac.abort(), 20);

    const events = await collectEvents(
      session.deliverTurn({ messages, turnId: 'turn-abort' }, { signal: ac.signal }),
    );

    // AbortError should be swallowed — no error event, no hang
    expect(events.every((e) => (e as Record<string, unknown>).type !== 'error')).toBe(true);
    assertAbortContract(events as AgentEvent[]);
  });
});
