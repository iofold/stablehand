import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BaseChatModel, type BindToolsInput } from '@langchain/core/language_models/chat_models';
import { AIMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { AgentEvent, HarnessSessionConfig } from '../types.js';
import type { Message } from '../../types.js';
import type { ToolDefinition } from '../../tool/types.js';
import type { NativeToolPolicy } from '@stablehand/contracts';
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
const mockFilesystemBackendOptions: Array<Record<string, unknown>> = [];

class MockLocalShellBackend {
  constructor(options: Record<string, unknown>) {
    mockLocalShellBackendOptions.push(options);
  }
}

class MockFilesystemBackend {
  constructor(options: Record<string, unknown>) {
    mockFilesystemBackendOptions.push(options);
  }
}

const MOCK_GENERAL_PURPOSE_SUBAGENT = {
  name: 'general-purpose',
  description: 'General-purpose agent',
  systemPrompt: 'You are a general-purpose agent.',
};

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

const POLICY_PROBE_TOOLS = [
  'ls',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'execute',
  'task',
  'write_todos',
  'stablehand_search',
];

type PolicyMiddleware = {
  name?: string;
  wrapModelCall: (
    request: { tools?: unknown[] },
    handler: (request: { tools?: unknown[] }) => Promise<unknown>,
  ) => Promise<unknown>;
  wrapToolCall: (
    request: { toolCall: { id?: string; name: string } },
    handler: (request: unknown) => Promise<unknown>,
  ) => Promise<unknown>;
};

function findPolicyMiddleware(middleware: Array<{ name?: string }> | undefined): PolicyMiddleware {
  const found = middleware?.find((candidate) => candidate.name === 'stablehand-native-tool-policy');
  if (!found) {
    throw new Error('Expected the stablehand-native-tool-policy middleware');
  }
  return found as PolicyMiddleware;
}

function makeSearchTool(): ToolDefinition {
  return {
    name: 'stablehand_search',
    description: 'Search stablehand data',
    input: z.object({ query: z.string() }),
    handler: async () => 'result',
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
    FilesystemBackend: MockFilesystemBackend,
    GENERAL_PURPOSE_SUBAGENT: MOCK_GENERAL_PURPOSE_SUBAGENT,
  }));

  return session;
}

describe('LangGraphHarness message history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalShellBackendOptions.length = 0;
    mockFilesystemBackendOptions.length = 0;
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
      visibleTools: ['read_file', 'stablehand_search'],
    },
    {
      label: 'deny',
      nativeToolPolicy: { policy: 'deny', names: ['execute'] } as NativeToolPolicy,
      visibleTools: POLICY_PROBE_TOOLS.filter((name) => name !== 'execute'),
    },
    {
      label: 'none',
      nativeToolPolicy: { policy: 'none' } as NativeToolPolicy,
      visibleTools: ['stablehand_search'],
    },
  ])('enforces the $label native-tool policy without blocking stablehand tools', async ({
    nativeToolPolicy,
    visibleTools,
  }) => {
    mockStreamEvents.mockImplementation(() => langGraphStream([{
      event: 'on_chat_model_stream',
      data: { chunk: { content: 'Done.' } },
    }]));
    const messages = [makeMessage('user', 'Use tools')];
    const session = await openRestoredTestSession({
      stateVersion: '1',
      messages,
      payload: { transcript: messages },
    }, makeConfig({ nativeToolPolicy, tools: [makeSearchTool()] }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await collectEvents(session.deliverTurn({ messages, turnId: 'turn-policy' }, {}));
      const params = mockCreateDeepAgent.mock.calls[0]?.[0] as {
        middleware?: PolicyMiddleware[];
      } | undefined;
      const middleware = findPolicyMiddleware(params?.middleware);
      // Runs before every other Stablehand middleware.
      expect(params?.middleware?.[0]).toBe(middleware);

      // The model is only offered allowed native tools plus Stablehand tools.
      const modelHandler = vi.fn(async (request: { tools?: unknown[] }) => request);
      await middleware.wrapModelCall({
        tools: [...POLICY_PROBE_TOOLS.map((name) => ({ name })), { type: 'web_search_preview' }],
      }, modelHandler);
      const offered = modelHandler.mock.calls[0]?.[0].tools ?? [];
      expect(offered.map((tool) => (tool as { name?: string }).name ?? 'unnamed')).toEqual([
        ...visibleTools,
        'unnamed',
      ]);

      // A call to a denied native tool never runs and comes back as an error.
      for (const toolName of POLICY_PROBE_TOOLS) {
        const toolHandler = vi.fn(async () => 'ran');
        const result = await middleware.wrapToolCall(
          { toolCall: { id: `call-${toolName}`, name: toolName } },
          toolHandler,
        );
        if (visibleTools.includes(toolName)) {
          expect(toolHandler, toolName).toHaveBeenCalledOnce();
          expect(result).toBe('ran');
        } else {
          expect(toolHandler, toolName).not.toHaveBeenCalled();
          expect(ToolMessage.isInstance(result), toolName).toBe(true);
          const message = result as ToolMessage;
          expect(message.status).toBe('error');
          expect(message.tool_call_id).toBe(`call-${toolName}`);
          expect(message.content).toContain(`denied by nativeToolPolicy '${nativeToolPolicy.policy}'`);
        }
      }
    } finally {
      warn.mockRestore();
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
        subagents?: unknown;
      } | undefined;
      expect(params?.middleware).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'stablehand-native-tool-policy' }),
      ]));
      // deepagents keeps building its own general-purpose subagent.
      expect(params?.subagents).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it.each([
    { label: 'no', nativeToolPolicy: undefined, backend: 'shell' },
    { label: 'the all', nativeToolPolicy: { policy: 'all' } as NativeToolPolicy, backend: 'shell' },
    {
      label: 'an allow-with-execute',
      nativeToolPolicy: { policy: 'allow', names: ['read_file', 'execute'] } as NativeToolPolicy,
      backend: 'shell',
    },
    {
      label: 'a deny-execute',
      nativeToolPolicy: { policy: 'deny', names: ['execute'] } as NativeToolPolicy,
      backend: 'filesystem',
    },
    {
      label: 'a file-tools-only allow',
      nativeToolPolicy: { policy: 'allow', names: ['read_file', 'grep'] } as NativeToolPolicy,
      backend: 'filesystem',
    },
    {
      label: 'an allow-without-file-or-shell',
      nativeToolPolicy: { policy: 'allow', names: ['write_todos'] } as NativeToolPolicy,
      backend: 'none',
    },
    { label: 'the none', nativeToolPolicy: { policy: 'none' } as NativeToolPolicy, backend: 'none' },
  ])('gives $label policy a $backend backend', async ({ nativeToolPolicy, backend }) => {
    mockStreamEvents.mockImplementation(() => langGraphStream([]));
    const messages = [makeMessage('user', 'Hello')];
    const session = await openRestoredTestSession({
      stateVersion: '1',
      messages,
      payload: { transcript: messages },
    }, makeConfig({ nativeToolPolicy }));

    try {
      await collectEvents(session.deliverTurn({ messages, turnId: 'turn-backend' }, {}));
      const params = mockCreateDeepAgent.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      if (backend === 'shell') {
        expect(params?.backend).toBeInstanceOf(MockLocalShellBackend);
        expect(mockFilesystemBackendOptions).toEqual([]);
      } else if (backend === 'filesystem') {
        expect(params?.backend).toBeInstanceOf(MockFilesystemBackend);
        expect(mockFilesystemBackendOptions).toEqual([{ rootDir: '/tmp/workspace' }]);
        expect(mockLocalShellBackendOptions).toEqual([]);
      } else {
        // No backend: deepagents falls back to its in-memory StateBackend.
        expect(params).not.toHaveProperty('backend');
        expect(mockLocalShellBackendOptions).toEqual([]);
        expect(mockFilesystemBackendOptions).toEqual([]);
      }
    } finally {
      await session.close();
    }
  });

  it('applies the native-tool policy to configured subagents and the general-purpose subagent', async () => {
    mockStreamEvents.mockImplementation(() => langGraphStream([]));
    const messages = [makeMessage('user', 'Delegate')];
    const session = await openRestoredTestSession({
      stateVersion: '1',
      messages,
      payload: { transcript: messages },
    }, makeConfig({
      nativeToolPolicy: { policy: 'deny', names: ['write_file'] },
      tools: [makeSearchTool()],
      harnessConfigJson: JSON.stringify({
        model: 'gpt-5.4-mini',
        provider: 'openai',
        apiKeyRef: 'openai',
        subagents: [{ name: 'researcher', description: 'Researches', systemPrompt: 'Research.' }],
      }),
    }));

    try {
      await collectEvents(session.deliverTurn({ messages, turnId: 'turn-subagents' }, {}));
      const params = mockCreateDeepAgent.mock.calls[0]?.[0] as {
        middleware?: PolicyMiddleware[];
        subagents?: Array<{ name: string; tools?: Array<{ name: string }>; middleware?: unknown[] }>;
      } | undefined;
      const policyMiddleware = findPolicyMiddleware(params?.middleware);

      expect(params?.subagents?.map((subagent) => subagent.name)).toEqual(['general-purpose', 'researcher']);
      const generalPurpose = params?.subagents?.[0];
      expect(generalPurpose).toEqual(expect.objectContaining(MOCK_GENERAL_PURPOSE_SUBAGENT));
      expect(generalPurpose?.tools?.map((tool) => tool.name)).toEqual(['stablehand_search']);
      expect(generalPurpose?.middleware).toEqual([policyMiddleware]);
      expect(params?.subagents?.[1]?.middleware?.[0]).toBe(policyMiddleware);
    } finally {
      await session.close();
    }
  });

  it('warns when configured subagents are unreachable because task is not allowed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const session = await openRestoredTestSession({
        stateVersion: '1',
        messages: [],
        payload: { transcript: [] },
      }, makeConfig({
        nativeToolPolicy: { policy: 'allow', names: ['read_file'] },
        harnessConfigJson: JSON.stringify({
          model: 'gpt-5.4-mini',
          provider: 'openai',
          apiKeyRef: 'openai',
          subagents: [{ name: 'researcher', description: 'Researches', systemPrompt: 'Research.' }],
        }),
      }));
      await session.close();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Add "task" to nativeToolPolicy.names'));
    } finally {
      warn.mockRestore();
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
        candidate.name === 'stablehand-system-message-compatibility',
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
        data: { input: { query: 'stablehand' } },
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
          args: { query: 'stablehand' },
          result: 'langgraph search result',
        },
      });
    } finally {
      await session.close();
    }
  });

  it('traces LangGraph normalized AgentEvents through the shared decorator', async () => {
    process.env.LANGSMITH_TRACING = 'true';
    process.env.LANGSMITH_PROJECT = 'stablehand-test';
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
      project_name: 'stablehand-test',
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

/**
 * Plays back a fixed list of assistant messages and records the tools bound
 * for each model call, so a test can see exactly what the model was offered.
 * Shared by the parent agent and its subagents (deepagents gives subagents
 * the parent's model instance).
 */
class ScriptedChatModel extends BaseChatModel {
  readonly offeredTools: string[][] = [];
  readonly receivedMessages: BaseMessage[][] = [];
  private boundToolNames: string[] = [];
  private step = 0;

  constructor(private readonly script: Array<() => AIMessage>) {
    super({});
  }

  _llmType(): string {
    return 'scripted';
  }

  override bindTools(tools: BindToolsInput[]): this {
    this.boundToolNames = tools.map((tool) => {
      const name = (tool as { name?: unknown }).name;
      return typeof name === 'string' ? name : 'unnamed';
    });
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.offeredTools.push(this.boundToolNames);
    this.receivedMessages.push(messages);
    const next = this.script[Math.min(this.step, this.script.length - 1)];
    this.step += 1;
    const message = next();
    return {
      generations: [{ text: typeof message.content === 'string' ? message.content : '', message }],
    };
  }
}

function toolCallMessage(id: string, name: string, args: Record<string, unknown>): () => AIMessage {
  return () => new AIMessage({ content: '', tool_calls: [{ id, name, args, type: 'tool_call' }] });
}

function textMessage(text: string): () => AIMessage {
  return () => new AIMessage({ content: text });
}

function toolResults(model: ScriptedChatModel): ToolMessage[] {
  return model.receivedMessages.flat().filter((message): message is ToolMessage => ToolMessage.isInstance(message));
}

describe('LangGraphHarness native-tool policy against real deepagents', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), 'langgraph-policy-'));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  async function runTurn(nativeToolPolicy: NativeToolPolicy, model: ScriptedChatModel): Promise<AgentEvent[]> {
    vi.resetModules();
    const { LangGraphHarness } = await import('../langgraph.js');
    const harness = new LangGraphHarness();
    const session = await harness.openSession(makeConfig({
      nativeToolPolicy,
      tools: [makeSearchTool()],
      workspaceDir,
    }));
    // Only the chat model is faked; deepagents, its middleware, backends and
    // the general-purpose subagent are the real installed packages.
    Reflect.set(session, 'buildModelFromConfig', async () => model);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const messages = [makeMessage('user', 'Go')];
      return await collectEvents(session.deliverTurn({ messages, turnId: 'turn-real-policy' }, {})) as AgentEvent[];
    } finally {
      warn.mockRestore();
      await session.close();
    }
  }

  it('never offers a denied file tool and refuses a call to it without writing', async () => {
    const target = path.join(workspaceDir, 'denied.txt');
    const model = new ScriptedChatModel([
      toolCallMessage('call-write', 'write_file', { file_path: target, content: 'should not exist' }),
      textMessage('done'),
    ]);

    const events = await runTurn({ policy: 'deny', names: ['write_file'] }, model);

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(model.offeredTools[0]).toEqual(expect.arrayContaining(['read_file', 'edit_file', 'stablehand_search']));
    expect(model.offeredTools[0]).not.toContain('write_file');
    expect(existsSync(target)).toBe(false);
    expect(toolResults(model)).toEqual([expect.objectContaining({
      tool_call_id: 'call-write',
      status: 'error',
      content: expect.stringContaining("denied by nativeToolPolicy 'deny'"),
    })]);
  });

  it('gives the none policy no native tools and refuses a shell call without running it', async () => {
    const marker = path.join(workspaceDir, 'marker');
    const model = new ScriptedChatModel([
      toolCallMessage('call-exec', 'execute', { command: `touch ${marker}` }),
      textMessage('done'),
    ]);

    await runTurn({ policy: 'none' }, model);

    expect(model.offeredTools[0]).toEqual(['stablehand_search']);
    expect(existsSync(marker)).toBe(false);
    expect(toolResults(model)).toEqual([expect.objectContaining({
      tool_call_id: 'call-exec',
      status: 'error',
      content: expect.stringContaining("denied by nativeToolPolicy 'none'"),
    })]);
  });

  it('keeps execute out of reach when it is denied, including through the general-purpose subagent', async () => {
    const marker = path.join(workspaceDir, 'marker');
    const model = new ScriptedChatModel([
      // Parent delegates to deepagents' general-purpose subagent...
      toolCallMessage('call-task', 'task', { description: 'Run the command', subagent_type: 'general-purpose' }),
      // ...which tries the denied shell tool and a denied file tool.
      () => new AIMessage({
        content: '',
        tool_calls: [
          { id: 'call-sub-exec', name: 'execute', args: { command: `touch ${marker}` }, type: 'tool_call' },
          {
            id: 'call-sub-write',
            name: 'write_file',
            args: { file_path: path.join(workspaceDir, 'sub.txt'), content: 'x' },
            type: 'tool_call',
          },
        ],
      }),
      textMessage('subagent done'),
      textMessage('done'),
    ]);

    await runTurn({ policy: 'deny', names: ['execute', 'write_file'] }, model);

    // Parent, then the subagent's two model calls, then the parent again.
    expect(model.offeredTools).toHaveLength(4);
    for (const offered of model.offeredTools) {
      expect(offered).not.toContain('execute');
      expect(offered).not.toContain('write_file');
    }
    expect(model.offeredTools[0]).toContain('task');
    expect(model.offeredTools[1]).toEqual(expect.arrayContaining(['read_file', 'stablehand_search']));
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(path.join(workspaceDir, 'sub.txt'))).toBe(false);
    const refused = toolResults(model).filter((message) => message.status === 'error');
    expect(refused.map((message) => message.tool_call_id).sort()).toEqual(['call-sub-exec', 'call-sub-write']);
  });
});
