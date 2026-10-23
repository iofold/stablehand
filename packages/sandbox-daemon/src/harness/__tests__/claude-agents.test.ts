import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const {
  mockQuery,
  mockCreateSdkMcpServer,
  mockTool,
  mockReadFile,
  mockMkdir,
  mockWriteFile,
  mockWrapClaudeAgentSDK,
  mockLangSmith,
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
  mockWrapClaudeAgentSDK: vi.fn((sdk: unknown) => sdk),
  mockLangSmith: (() => {
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
  })(),
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

vi.mock('langsmith', () => ({
  Client: mockLangSmith.FakeClient,
  RunTree: mockLangSmith.FakeRunTree,
}));

vi.mock('langsmith/experimental/anthropic', () => ({
  wrapClaudeAgentSDK: mockWrapClaudeAgentSDK,
}));

import { ClaudeAgentsHarness, toSdkSessionId } from '../claude-agents.js';
import type { AgentEvent, HarnessSessionConfig } from '../types.js';
import type { Message } from '../../types.js';
import type { ToolDefinition } from '../../tool/types.js';
import {
  assertAbortContract,
  assertApprovalFlowContract,
  assertPlainTextTurnContract,
  assertRestorePromptShape,
  assertToolErrorContract,
  assertToolRoundTripContract,
} from './contract/assert-agent-event-contract.js';
import {
  RELAYED_BUDGET_ERROR_TEXT,
  recordRelayBudgetRefusal,
} from './support/budget-refusal-fixture.js';

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
        sessionId: '11111111-1111-4111-8111-111111111111',
        sessionJSONL: '{"type":"user"}\n',
      },
    });
    expect(mockReadFile).toHaveBeenCalledWith(
      '/home/test/.claude/projects/-tmp-workspace/sessions/11111111-1111-4111-8111-111111111111.jsonl',
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
      '/home/test/.claude/projects/-tmp-workspace/sessions/11111111-1111-4111-8111-111111111111.jsonl',
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
    expect(queryCall?.options.resume).toBe('11111111-1111-4111-8111-111111111111');
    expect(queryCall?.options.sessionId).toBeUndefined();

    await session.close();
  });

  it('fresh replay after sandbox replacement uses full prior context with a new SDK session id', async () => {
    const harness = new ClaudeAgentsHarness();
    Reflect.set(harness, 'loadSdkModule', async () => ({
      query: mockQuery,
      tool: mockTool,
      createSdkMcpServer: mockCreateSdkMcpServer,
    }));

    const prompts: string[] = [];
    mockQuery.mockImplementation(async function* (request: {
      prompt: AsyncIterable<{ message: { content: string } }>;
      options: { sessionId?: string; resume?: string };
    }) {
      for await (const promptMessage of request.prompt) {
        prompts.push(promptMessage.message.content);
      }
      yield {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 1, output_tokens: 2 },
      };
    });

    const previousAssistant = makeMessage('assistant', 'Earlier answer');
    const previousTool = makeMessage('tool', 'Earlier tool output');
    const currentUser = makeMessage('user', 'Continue after replacement');
    const session = await harness.openSession(makeConfig());

    await collectEvents(
      session.deliverTurn(
        { messages: [previousAssistant, previousTool, currentUser], turnId: 'turn-replay' },
        {},
      ),
    );

    const queryCall = mockQuery.mock.calls[0]?.[0];
    expect(queryCall?.options.sessionId).toBe('turn-replay');
    expect(queryCall?.options.resume).toBeUndefined();
    expect(prompts).toEqual([
      '[Previous assistant response]\nEarlier answer',
      '[Previous tool output]\nEarlier tool output',
      'Continue after replacement',
    ]);

    await session.close();
  });

  it('restore writes session JSONL to both sanitized and hashed Claude project session paths', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-config';
    const workspaceDir = '/tmp/workspaces/pilot project';
    const sanitizedWorkspaceDir = workspaceDir.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200);
    const hashedWorkspaceDir = createHash('sha256').update(workspaceDir).digest('hex');
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

    const session = await harness.openSession(makeConfig({ workspaceDir }), {
      stateVersion: '2',
      messages: [],
      payload: {
        transcript: [makeMessage('assistant', 'Restored reply')],
        sessionJSONL: '{"type":"assistant"}\n',
      },
    });

    expect(mockMkdir).toHaveBeenCalledWith(
      `/tmp/claude-config/projects/${sanitizedWorkspaceDir}/sessions`,
      { recursive: true },
    );
    expect(mockMkdir).toHaveBeenCalledWith(
      `/tmp/claude-config/projects/${hashedWorkspaceDir}/sessions`,
      { recursive: true },
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      `/tmp/claude-config/projects/${sanitizedWorkspaceDir}/sessions/11111111-1111-4111-8111-111111111111.jsonl`,
      '{"type":"assistant"}\n',
      'utf-8',
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      `/tmp/claude-config/projects/${hashedWorkspaceDir}/sessions/11111111-1111-4111-8111-111111111111.jsonl`,
      '{"type":"assistant"}\n',
      'utf-8',
    );

    await session.close();
  });

  it('exportState falls back to the hashed Claude project session path when the sanitized path is missing', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-config';
    const workspaceDir = '/tmp/workspaces/pilot project';
    const sanitizedWorkspaceDir = workspaceDir.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200);
    const hashedWorkspaceDir = createHash('sha256').update(workspaceDir).digest('hex');
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
    mockReadFile.mockImplementation(async (filePath: string) => {
      if (filePath === `/tmp/claude-config/projects/${sanitizedWorkspaceDir}/sessions/11111111-1111-4111-8111-111111111111.jsonl`) {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      if (filePath === `/tmp/claude-config/projects/${hashedWorkspaceDir}/sessions/11111111-1111-4111-8111-111111111111.jsonl`) {
        return '{"type":"assistant","ok":true}\n';
      }
      throw new Error(`unexpected read path: ${filePath}`);
    });

    const session = await harness.openSession(makeConfig({ workspaceDir }));
    await collectEvents(session.deliverTurn({ messages: [makeMessage('user', 'Hello')], turnId: 'turn-1' }, {}));

    await expect(session.exportState()).resolves.toMatchObject({
      stateVersion: '2',
      payload: {
        sessionJSONL: '{"type":"assistant","ok":true}\n',
      },
    });
    expect(mockReadFile).toHaveBeenCalledWith(
      `/tmp/claude-config/projects/${sanitizedWorkspaceDir}/sessions/11111111-1111-4111-8111-111111111111.jsonl`,
      'utf-8',
    );
    expect(mockReadFile).toHaveBeenCalledWith(
      `/tmp/claude-config/projects/${hashedWorkspaceDir}/sessions/11111111-1111-4111-8111-111111111111.jsonl`,
      'utf-8',
    );

    await session.close();
  });
});


describe('ClaudeAgentsHarness stream mapping fallbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('streams text deltas without re-emitting them from the complete assistant message', () => {
    const harness = new ClaudeAgentsHarness();
    const toolStartTimes = new Map<string, number>();
    const streamState = harness.createStreamMappingState();

    const deltaEvents = ['Hello', ' world'].flatMap((text) => [...harness.mapSDKMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      },
    } as never, toolStartTimes, streamState)]);

    expect(deltaEvents).toEqual([
      { type: 'text_delta', content: 'Hello' },
      { type: 'text_delta', content: ' world' },
    ]);

    const assistantEvents = [...harness.mapSDKMessage({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello world' }],
      },
    } as never, toolStartTimes, streamState)];

    expect(assistantEvents).toEqual([]);

    // A later assistant message with no preceding deltas still emits its text.
    const unstreamedEvents = [...harness.mapSDKMessage({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Unstreamed reply' }],
      },
    } as never, toolStartTimes, streamState)];

    expect(unstreamedEvents).toEqual([
      { type: 'text_delta', content: 'Unstreamed reply' },
    ]);
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
          __stablehandDegraded: true,
          __stablehandError: expect.stringContaining('Failed to parse streamed Claude tool arguments'),
          __stablehandRawArgsPreview: '{"query":',
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

describe('ClaudeAgentsHarness AgentEvent contract baseline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HOME = '/home/test';
    delete process.env.CLAUDE_CONFIG_DIR;
    const enoent = Object.assign(new Error('missing session jsonl'), { code: 'ENOENT' });
    mockReadFile.mockRejectedValue(enoent);
  });

  it('satisfies the shared plain-text turn contract', async () => {
    const harness = new ClaudeAgentsHarness();
    Reflect.set(harness, 'loadSdkModule', async () => ({
      query: mockQuery,
      tool: mockTool,
      createSdkMcpServer: mockCreateSdkMcpServer,
    }));

    mockQuery.mockImplementation(() => sdkStream([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Claude contract reply' }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'Claude contract reply',
        usage: { input_tokens: 3, output_tokens: 4 },
      },
    ]));

    const turnId = 'turn-claude-contract';
    const session = await harness.openSession(makeConfig());
    try {
      const events = await collectEvents(
        session.deliverTurn({ messages: [makeMessage('user', 'Hello')], turnId }, {}),
      );
      const exportedState = await session.exportState();

      assertPlainTextTurnContract({
        events,
        turnId,
        exportedState,
        expectedContent: 'Claude contract reply',
      });
    } finally {
      await session.close();
    }
  });

  it('satisfies the shared tool round-trip contract', async () => {
    const harness = new ClaudeAgentsHarness();
    Reflect.set(harness, 'loadSdkModule', async () => ({
      query: mockQuery,
      tool: mockTool,
      createSdkMcpServer: mockCreateSdkMcpServer,
    }));

    mockQuery.mockImplementation(() => sdkStream([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Using search.' },
            {
              type: 'tool_use',
              id: 'tool-claude-search',
              name: 'search',
              input: { query: 'stablehand' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-claude-search',
            content: 'search result',
          }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'Done',
        usage: { input_tokens: 5, output_tokens: 6 },
      },
    ]));

    const turnId = 'turn-claude-tool-contract';
    const session = await harness.openSession(makeConfig());
    try {
      const events = await collectEvents(
        session.deliverTurn({ messages: [makeMessage('user', 'Search')], turnId }, {}),
      );
      const exportedState = await session.exportState();

      assertToolRoundTripContract({
        events,
        turnId,
        exportedState,
        expectedContent: 'Using search.',
        expectedTool: {
          id: 'tool-claude-search',
          name: 'search',
          args: { query: 'stablehand' },
          result: 'search result',
        },
      });
    } finally {
      await session.close();
    }
  });

  it('traces Claude normalized AgentEvents through the shared decorator without the SDK wrapper', async () => {
    process.env.LANGSMITH_TRACING = 'true';
    process.env.LANGSMITH_PROJECT = 'stablehand-test';
    mockLangSmith.FakeRunTree.runs = [];
    mockQuery.mockImplementation(() => sdkStream([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Using search.' },
            {
              type: 'tool_use',
              id: 'tool-claude-search',
              name: 'search',
              input: { query: 'stablehand' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-claude-search',
            content: 'search result',
          }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'Done',
        usage: { input_tokens: 5, output_tokens: 6 },
      },
    ]));

    const turnId = 'turn-claude-traced';
    let session: Awaited<ReturnType<ClaudeAgentsHarness['openSession']>> | undefined;
    try {
      session = await new ClaudeAgentsHarness().openSession(makeConfig());
      await collectEvents(
        session.deliverTurn({ messages: [makeMessage('user', 'Search')], turnId }, {}),
      );
    } finally {
      await session?.close();
      delete process.env.LANGSMITH_TRACING;
      delete process.env.LANGSMITH_PROJECT;
    }

    expect(mockWrapClaudeAgentSDK).not.toHaveBeenCalled();
    const root = mockLangSmith.FakeRunTree.runs[0];
    expect(root.config).toEqual(expect.objectContaining({
      name: 'claude-agents-agent-agent-1',
      run_type: 'chain',
      project_name: 'stablehand-test',
    }));
    const turn = root.children[0];
    expect(turn.config).toEqual(expect.objectContaining({
      name: 'claude-agents-turn',
      inputs: { turnId },
    }));
    const llm = turn.children.find((child) => child.config.run_type === 'llm');
    expect(llm?.end).toHaveBeenCalledWith(expect.objectContaining({
      generations: [{ text: 'Using search.' }],
      toolCalls: [expect.objectContaining({ id: 'tool-claude-search', name: 'search' })],
    }));
    const tool = turn.children.find((child) => child.config.run_type === 'tool');
    expect(tool?.config).toEqual(expect.objectContaining({
      name: 'search',
      inputs: { args: { query: 'stablehand' }, toolCallId: 'tool-claude-search' },
    }));
    expect(tool?.end).toHaveBeenCalledWith(expect.objectContaining({
      result: 'search result',
    }));
    expect(root.end).toHaveBeenCalledWith({ status: 'completed' });
  });

  it('satisfies the shared tool-error contract', async () => {
    const harness = new ClaudeAgentsHarness();
    Reflect.set(harness, 'loadSdkModule', async () => ({
      query: mockQuery,
      tool: mockTool,
      createSdkMcpServer: mockCreateSdkMcpServer,
    }));

    mockQuery.mockImplementation(() => sdkStream([
      {
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'tool-claude-error',
            name: 'search',
            input: { query: 'bad' },
          }],
        },
      },
      {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-claude-error',
            content: 'search failed',
            is_error: true,
          }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'Recovered',
        usage: { input_tokens: 7, output_tokens: 8 },
      },
    ]));

    const turnId = 'turn-claude-tool-error-contract';
    const session = await harness.openSession(makeConfig());
    try {
      const events = await collectEvents(
        session.deliverTurn({ messages: [makeMessage('user', 'Search badly')], turnId }, {}),
      );
      const exportedState = await session.exportState();

      assertToolErrorContract({
        events,
        turnId,
        exportedState,
        expectedTool: {
          id: 'tool-claude-error',
          name: 'search',
          args: { query: 'bad' },
          error: 'search failed',
        },
      });
    } finally {
      await session.close();
    }
  });

  it('satisfies the shared approval approve and reject contracts', async () => {
    const harness = new ClaudeAgentsHarness();
    type ClaudeSdkForTools = Parameters<ClaudeAgentsHarness['convertToolsWithSDK']>[0];
    const makeApprovalTool = (): ToolDefinition => ({
      name: 'guarded_search',
      description: 'Searches with approval',
      input: z.object({ query: z.string() }),
      requiresApproval: true,
      handler: vi.fn(async () => 'approved result'),
    });
    const sdk = {
      tool: vi.fn((
        name: string,
        _description: string,
        _schema: unknown,
        handler: (rawArgs: unknown) => Promise<unknown>,
      ) => ({ name, handler })),
    } as unknown as ClaudeSdkForTools;

    const approvedEvents: AgentEvent[] = [];
    const approvedTools = harness.convertToolsWithSDK(
      sdk,
      [makeApprovalTool()],
      'turn-approval-approved',
      makeConfig(),
      vi.fn(async () => ({ action: 'approve' as const })),
      approvedEvents,
    );
    const approvedTool = approvedTools[0] as unknown as {
      handler: (rawArgs: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    };
    const approvedResult = await approvedTool.handler({ query: 'allowed' });

    assertApprovalFlowContract(approvedEvents, {
      tool: 'guarded_search',
      action: 'approve',
      args: { query: 'allowed' },
    });
    expect(approvedResult).toEqual(expect.objectContaining({
      content: [{ type: 'text', text: 'approved result' }],
    }));

    const rejectedEvents: AgentEvent[] = [];
    const rejectedTools = harness.convertToolsWithSDK(
      sdk,
      [makeApprovalTool()],
      'turn-approval-rejected',
      makeConfig(),
      vi.fn(async () => ({ action: 'reject' as const })),
      rejectedEvents,
    );
    const rejectedTool = rejectedTools[0] as unknown as {
      handler: (rawArgs: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    };
    const rejectedResult = await rejectedTool.handler({ query: 'blocked' });

    assertApprovalFlowContract(rejectedEvents, {
      tool: 'guarded_search',
      action: 'reject',
      args: { query: 'blocked' },
    });
    expect(rejectedResult).toEqual(expect.objectContaining({
      content: [{ type: 'text', text: 'Tool call was rejected by the user.' }],
      isError: true,
    }));
  });

  it('satisfies the shared abort contract by ending without done', async () => {
    const harness = new ClaudeAgentsHarness();
    Reflect.set(harness, 'loadSdkModule', async () => ({
      query: mockQuery,
      tool: mockTool,
      createSdkMcpServer: mockCreateSdkMcpServer,
    }));

    mockQuery.mockImplementation(async function* (request: {
      options: { abortController: AbortController };
    }) {
      if (!request.options.abortController.signal.aborted) {
        await new Promise<void>((resolve) => {
          request.options.abortController.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      const unreachable: never[] = [];
      for (const event of unreachable) {
        yield event;
      }
    });

    const abortController = new AbortController();
    const session = await harness.openSession(makeConfig());
    try {
      const eventsPromise = collectEvents(
        session.deliverTurn(
          { messages: [makeMessage('user', 'Abort')], turnId: 'turn-claude-abort-contract' },
          { signal: abortController.signal },
        ),
      );
      abortController.abort();
      const events = await eventsPromise;
      assertAbortContract(events);
    } finally {
      await session.close();
    }
  });

  it('satisfies the shared restore prompt-shape contract', async () => {
    const harness = new ClaudeAgentsHarness();
    Reflect.set(harness, 'loadSdkModule', async () => ({
      query: mockQuery,
      tool: mockTool,
      createSdkMcpServer: mockCreateSdkMcpServer,
    }));

    const prompts: string[] = [];
    mockQuery.mockImplementation(async function* (request: {
      prompt: AsyncIterable<{ message: { content: string } }>;
    }) {
      for await (const promptMessage of request.prompt) {
        prompts.push(promptMessage.message.content);
      }
      yield {
        type: 'result',
        subtype: 'success',
        result: 'Restored',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    });

    const messages = [
      makeMessage('assistant', 'Earlier answer'),
      makeMessage('tool', 'Earlier tool output'),
      makeMessage('user', 'Continue after restore'),
    ];
    const session = await harness.openSession(makeConfig());
    try {
      await collectEvents(
        session.deliverTurn({ messages, turnId: 'turn-claude-restore-contract' }, {}),
      );

      assertRestorePromptShape(prompts, [
        '[Previous assistant response]\nEarlier answer',
        '[Previous tool output]\nEarlier tool output',
        'Continue after restore',
      ]);
    } finally {
      await session.close();
    }
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
      for await (const event of session.deliverTurn(
        { messages: [makeMessage('user', 'Hello')], turnId: 'turn-value-test' },
        {},
      )) {
        void event;
      }

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

  it('passes each turn secret only in that SDK query environment', async () => {
    const tokenKey = 'PILOT_TURN_OWNERSHIP_TOKEN';
    const blockedHostKey = 'AWS_ACCESS_KEY_ID';
    const providerKey = 'ANTHROPIC_API_KEY';
    const previousToken = process.env[tokenKey];
    const previousBlockedHostValue = process.env[blockedHostKey];
    const previousProviderValue = process.env[providerKey];
    process.env[tokenKey] = 'stable-token';
    process.env[blockedHostKey] = 'stable-aws-key';
    process.env[providerKey] = 'stable-anthropic-key';

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
    try {
      await collectEvents(session.deliverTurn(
        { messages: [makeMessage('user', 'Turn A')], turnId: 'turn-secret-a' },
        {
          turnSecrets: {
            [tokenKey]: 'turn-token-a',
            [blockedHostKey]: 'turn-aws-key-a',
            [providerKey]: 'turn-anthropic-key-a',
          },
        },
      ));
      expect(process.env[tokenKey]).toBe('stable-token');
      expect(process.env[blockedHostKey]).toBe('stable-aws-key');
      expect(process.env[providerKey]).toBe('stable-anthropic-key');

      await collectEvents(session.deliverTurn(
        { messages: [makeMessage('user', 'Turn B')], turnId: 'turn-secret-b' },
        {
          turnSecrets: {
            [tokenKey]: 'turn-token-b',
            [blockedHostKey]: 'turn-aws-key-b',
            [providerKey]: 'turn-anthropic-key-b',
          },
        },
      ));
      expect(process.env[tokenKey]).toBe('stable-token');
      expect(process.env[blockedHostKey]).toBe('stable-aws-key');
      expect(process.env[providerKey]).toBe('stable-anthropic-key');

      const firstEnv = mockQuery.mock.calls[0]?.[0]?.options?.env;
      const secondEnv = mockQuery.mock.calls[1]?.[0]?.options?.env;
      expect(firstEnv?.[tokenKey]).toBe('turn-token-a');
      expect(secondEnv?.[tokenKey]).toBe('turn-token-b');
      expect(firstEnv?.[blockedHostKey]).toBe('turn-aws-key-a');
      expect(secondEnv?.[blockedHostKey]).toBe('turn-aws-key-b');
      expect(firstEnv?.[providerKey]).toBe('turn-anthropic-key-a');
      expect(secondEnv?.[providerKey]).toBe('turn-anthropic-key-b');
    } finally {
      await session.close();
      if (previousToken === undefined) {
        delete process.env[tokenKey];
      } else {
        process.env[tokenKey] = previousToken;
      }
      if (previousBlockedHostValue === undefined) {
        delete process.env[blockedHostKey];
      } else {
        process.env[blockedHostKey] = previousBlockedHostValue;
      }
      if (previousProviderValue === undefined) {
        delete process.env[providerKey];
      } else {
        process.env[providerKey] = previousProviderValue;
      }
    }
  });
});

describe('Claude Agents model gateway connection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the Anthropic-native gateway endpoint and opaque correlation headers', async () => {
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
    const config = makeConfig({
      harnessConfigJson: JSON.stringify({
        model: 'stablehand-anthropic',
      }),
      secrets: {
        STABLEHAND_MODEL_GATEWAY_ENABLED: 'true',
        STABLEHAND_MODEL_GATEWAY_URL: 'http://litellm:4000',
        STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY: 'runtime-key',
        STABLEHAND_MODEL_GATEWAY_REVISION: 'dev1-1',
        ANTHROPIC_API_KEY: 'upstream-key-that-must-not-win',
      },
    });

    const session = await harness.openSession(config);
    try {
      await collectEvents(session.deliverTurn(
        {
          messages: [makeMessage('user', 'Hello')],
          turnId: 'customer@example.com-close',
        },
        {
          turnSecrets: {
            ANTHROPIC_API_KEY: 'turn-override-that-must-not-win',
            ANTHROPIC_BASE_URL: 'https://attacker.invalid',
          },
        },
      ));
    } finally {
      await session.close();
    }

    const queryCall = mockQuery.mock.calls[0]?.[0] as {
      options?: { env?: Record<string, string> };
    } | undefined;
    const capturedEnv = queryCall?.options?.env ?? {};
    expect(capturedEnv.ANTHROPIC_API_KEY).toBe('runtime-key');
    expect(capturedEnv.ANTHROPIC_BASE_URL).toBe('http://litellm:4000');
    expect(capturedEnv.ANTHROPIC_CUSTOM_HEADERS).toContain(
      'x-litellm-trace-id: ct_',
    );
    expect(capturedEnv.ANTHROPIC_CUSTOM_HEADERS).toContain(
      'x-litellm-spend-logs-metadata:',
    );
    expect(capturedEnv.ANTHROPIC_CUSTOM_HEADERS).not.toContain(
      'customer@example.com',
    );
    expect(capturedEnv).not.toHaveProperty('STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY');
  });

  it('preserves an explicit direct endpoint and key', async () => {
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
    const session = await harness.openSession(makeConfig({
      harnessConfigJson: JSON.stringify({
        model: 'claude-sonnet-4-6',
        apiKeyRef: '$secret:DIRECT_ANTHROPIC_KEY',
        baseUrl: 'https://direct.example.test',
      }),
      secrets: {
        DIRECT_ANTHROPIC_KEY: 'direct-key',
        STABLEHAND_MODEL_GATEWAY_ENABLED: 'true',
        STABLEHAND_MODEL_GATEWAY_URL: 'http://litellm:4000',
        STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY: 'runtime-key',
        STABLEHAND_MODEL_GATEWAY_REVISION: 'dev1-1',
      },
    }));

    try {
      await collectEvents(session.deliverTurn(
        { messages: [makeMessage('user', 'Hello')], turnId: 'turn-direct' },
        {},
      ));
    } finally {
      await session.close();
    }

    const queryCall = mockQuery.mock.calls[0]?.[0] as {
      options?: { env?: Record<string, string> };
    } | undefined;
    expect(queryCall?.options?.env).toEqual(expect.objectContaining({
      ANTHROPIC_API_KEY: 'direct-key',
      ANTHROPIC_BASE_URL: 'https://direct.example.test',
    }));
    expect(queryCall?.options?.env).not.toHaveProperty('ANTHROPIC_CUSTOM_HEADERS');
  });
});

describe('toSdkSessionId (ctx-0u1b: SDK requires UUID sessionId)', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('passes bare UUIDs through unchanged', () => {
    const id = '5ec974fd-26b1-480d-9229-88447fbb144c';
    expect(toSdkSessionId(id)).toBe(id);
  });

  it('extracts the UUID embedded in AG-UI thread ids', () => {
    // createStablehandId("thread") produces thread-<uuid>; the SDK rejects the
    // prefixed form and crashes the child process.
    expect(toSdkSessionId('thread-fb20a343-0206-4ba0-8eb5-3c9d0dcc9ebe'))
      .toBe('fb20a343-0206-4ba0-8eb5-3c9d0dcc9ebe');
  });

  it('derives a stable UUID for ids with no embedded UUID', () => {
    const a = toSdkSessionId('legacy-conversation-key');
    const b = toSdkSessionId('legacy-conversation-key');
    expect(a).toMatch(UUID_RE);
    expect(a).toBe(b); // stable so cross-turn resume aligns
    expect(toSdkSessionId('different-key')).not.toBe(a);
  });
});

describe('ClaudeAgentsHarness subagent mapping (ctx-5myn)', () => {
  it('annotates subagent tool activity with the spawning Task id and suppresses subagent prose', () => {
    const harness = new ClaudeAgentsHarness();
    const toolStartTimes = new Map<string, number>();
    const streamState = harness.createStreamMappingState();

    // Parent spawns a Task subagent — records subagent_type for its children.
    const taskStart = [...harness.mapSDKMessage({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'task-1',
          name: 'Task',
          input: { subagent_type: 'researcher', prompt: 'dig' },
        }],
      },
    } as never, toolStartTimes, streamState)];
    expect(taskStart).toEqual([
      {
        type: 'tool_call_start',
        id: 'task-1',
        name: 'Task',
        args: { subagent_type: 'researcher', prompt: 'dig' },
      },
    ]);

    // Subagent prose (parent_tool_use_id set) stays out of the parent stream.
    const subagentDelta = [...harness.mapSDKMessage({
      type: 'stream_event',
      parent_tool_use_id: 'task-1',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'internal narration' },
      },
    } as never, toolStartTimes, streamState)];
    expect(subagentDelta).toEqual([]);

    const subagentAssistant = [...harness.mapSDKMessage({
      type: 'assistant',
      parent_tool_use_id: 'task-1',
      message: {
        content: [
          { type: 'text', text: 'more narration' },
          { type: 'tool_use', id: 'child-1', name: 'Read', input: { path: '/x' } },
        ],
      },
    } as never, toolStartTimes, streamState)];
    expect(subagentAssistant).toEqual([
      {
        type: 'tool_call_start',
        id: 'child-1',
        name: 'Read',
        args: { path: '/x' },
        parentToolCallId: 'task-1',
        agentName: 'researcher',
      },
    ]);

    // Subagent tool result carries the parent pointer too.
    const subagentResult = [...harness.mapSDKMessage({
      type: 'user',
      parent_tool_use_id: 'task-1',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'child-1',
          content: 'file contents',
        }],
      },
    } as never, toolStartTimes, streamState)];
    expect(subagentResult).toHaveLength(1);
    expect(subagentResult[0]).toMatchObject({
      type: 'tool_call_end',
      id: 'child-1',
      result: 'file contents',
      parentToolCallId: 'task-1',
    });

    // Parent-level activity stays unannotated.
    const parentTool = [...harness.mapSDKMessage({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'p-1', name: 'Bash', input: { cmd: 'ls' } }],
      },
    } as never, toolStartTimes, streamState)];
    expect(parentTool).toEqual([
      { type: 'tool_call_start', id: 'p-1', name: 'Bash', args: { cmd: 'ls' } },
    ]);
  });
});

describe('Claude Agents spend-cap stop', () => {
  const gatewaySecrets = {
    STABLEHAND_MODEL_GATEWAY_ENABLED: 'true',
    STABLEHAND_MODEL_GATEWAY_URL: 'http://litellm:4000',
    STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY: 'session-key',
    STABLEHAND_MODEL_GATEWAY_REVISION: 'dev1-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function openGatewaySession() {
    const harness = new ClaudeAgentsHarness();
    Reflect.set(harness, 'loadSdkModule', async () => ({
      query: mockQuery,
      tool: mockTool,
      createSdkMcpServer: mockCreateSdkMcpServer,
    }));
    return harness.openSession(makeConfig({
      harnessConfigJson: JSON.stringify({ model: 'claude-sonnet-5' }),
      secrets: gatewaySecrets,
    }));
  }

  it('ends the turn on the typed budget stop instead of streaming the CLI API-error text', async () => {
    const turnId = 'turn-claude-budget';
    const { cleanup } = await recordRelayBudgetRefusal(turnId, { spentUsd: 0.0512, capUsd: 0.05 });
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working on it. ' } },
        parent_tool_use_id: null,
      };
      yield {
        type: 'assistant',
        error: 'invalid_request',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: `API Error: ${RELAYED_BUDGET_ERROR_TEXT}` }] },
      };
      yield {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: `API Error: ${RELAYED_BUDGET_ERROR_TEXT}`,
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    });

    const session = await openGatewaySession();
    try {
      const events = await collectEvents(session.deliverTurn(
        { messages: [makeMessage('user', 'Loop forever')], turnId },
        {},
      ));

      const texts = events
        .filter((event): event is Extract<AgentEvent, { type: 'text_delta' }> => event.type === 'text_delta')
        .map((event) => event.content)
        .join('');
      expect(texts).toBe('Working on it. ');
      const errors = events.filter((event) => event.type === 'error');
      expect(errors).toEqual([{
        type: 'error',
        error: expect.stringContaining('reached its spend cap ($0.0512 spent of $0.05)'),
        code: 'model_gateway_budget_exceeded',
        details: { spentUsd: 0.0512, capUsd: 0.05 },
      }]);
      expect(events.some((event) => event.type === 'done')).toBe(false);
    } finally {
      await session.close();
      await cleanup();
    }
  });

  it('recognizes a relayed refusal in a failed query result without the relay record', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        errors: [`API Error: ${RELAYED_BUDGET_ERROR_TEXT}`],
        usage: { input_tokens: 1, output_tokens: 0 },
      };
    });

    const session = await openGatewaySession();
    try {
      const events = await collectEvents(session.deliverTurn(
        { messages: [makeMessage('user', 'Hello')], turnId: 'turn-claude-budget-text' },
        {},
      ));

      expect(events.filter((event) => event.type === 'error')).toEqual([{
        type: 'error',
        error: expect.stringContaining('reached its spend cap'),
        code: 'model_gateway_budget_exceeded',
        details: { spentUsd: null, capUsd: null },
      }]);
    } finally {
      await session.close();
    }
  });

  it('leaves unrelated API errors untyped', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['API Error: 500 upstream exploded'],
      };
    });

    const session = await openGatewaySession();
    try {
      const events = await collectEvents(session.deliverTurn(
        { messages: [makeMessage('user', 'Hello')], turnId: 'turn-claude-500' },
        {},
      ));

      expect(events.filter((event) => event.type === 'error')).toEqual([{
        type: 'error',
        error: 'API Error: 500 upstream exploded',
      }]);
    } finally {
      await session.close();
    }
  });
});
