import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { z } from 'zod';
import { Type } from '@sinclair/typebox';
import { TurnDeliveryCapabilitySchema } from '@ctxmill/proto/sandbox/v1';
import type { BashToolOptions } from '@earendil-works/pi-coding-agent';

const mockCreateAgentSession = vi.fn();
const mockSetRuntimeApiKey = vi.fn();
const mockGetModel = vi.fn((
  provider: string,
  model: string,
): { provider: string; id: string; api: string } | undefined => {
  const apiByProvider: Record<string, string> = {
    openai: 'openai-completions',
    anthropic: 'anthropic-messages',
    google: 'google-generative-ai',
  };
  return {
    provider,
    id: model,
    api: apiByProvider[provider],
  };
});
const mockModelRuntime = {
  getModel: mockGetModel,
  setRuntimeApiKey: mockSetRuntimeApiKey,
};
function createNativeState(onMessages = vi.fn()) {
  let messages: Array<Record<string, unknown>> = [];
  return {
    get messages() {
      return messages;
    },
    set messages(next: Array<Record<string, unknown>>) {
      messages = next;
      onMessages(next);
    },
  };
}
const mockCreateCodingTools = vi.fn((
  cwd: string,
  _options?: { bash?: BashToolOptions },
) => [{ name: 'coding-tools', cwd }]);
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

vi.mock('@earendil-works/pi-coding-agent', () => ({
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
  ModelRuntime: {
    create: vi.fn(async () => mockModelRuntime),
  },
  createCodingTools: mockCreateCodingTools,
  createReadTool: vi.fn((cwd: string) => ({ name: 'read', cwd })),
  createBashTool: vi.fn((cwd: string) => ({ name: 'bash', cwd })),
  createEditTool: vi.fn((cwd: string) => ({ name: 'edit', cwd })),
  createWriteTool: vi.fn((cwd: string) => ({ name: 'write', cwd })),
  createGrepTool: vi.fn((cwd: string) => ({ name: 'grep', cwd })),
  createFindTool: vi.fn((cwd: string) => ({ name: 'find', cwd })),
  createLsTool: vi.fn((cwd: string) => ({ name: 'ls', cwd })),
}));

vi.mock('@earendil-works/pi-ai', async () => {
  const { Type } = await import('@sinclair/typebox');
  return {
    Type,
    InMemoryCredentialStore: vi.fn(function MockCredentialStore() {
      return { type: 'credential-store' };
    }),
  };
});

vi.mock('langsmith', () => ({
  Client: mockLangSmith.FakeClient,
  RunTree: mockLangSmith.FakeRunTree,
}));

import { _piUpdateUsage, convertTools, PIAgentHarness } from '../pi-agent.js';
import type { AgentEvent, HarnessSessionConfig } from '../types.js';
import type { Message } from '../../types.js';
import type { ToolDefinition } from '../../tool/types.js';
import {
  runWithTurnDeliveryContext,
  type TurnDeliveryContext,
} from '../../sandbox/turn-delivery-context.js';
import {
  assertAbortContract,
  assertApprovalFlowContract,
  assertPlainTextTurnContract,
  assertRestorePromptShape,
  assertToolErrorContract,
  assertToolRoundTripContract,
} from './contract/assert-agent-event-contract.js';

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

describe('PI usage normalization', () => {
  it('does not present unknown catalog pricing as free', () => {
    const usage = _piUpdateUsage(undefined, {
      type: 'turn_end',
      message: {
        usage: {
          input: 10,
          output: 5,
          totalTokens: 15,
          cost: { total: 0 },
        },
      },
    }, false);

    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it('sums known catalog costs across model turns exactly once', () => {
    const first = _piUpdateUsage(undefined, {
      type: 'turn_end',
      message: {
        usage: {
          input: 10,
          output: 5,
          totalTokens: 15,
          cost: { total: 0.01 },
        },
      },
    }, true);
    const second = _piUpdateUsage(first, {
      type: 'turn_end',
      message: {
        usage: {
          input: 20,
          output: 10,
          totalTokens: 30,
          cost: { total: 0.02 },
        },
      },
    }, true);

    expect(second).toEqual({
      inputTokens: 30,
      outputTokens: 15,
      totalTokens: 45,
      costUsd: 0.03,
    });
  });
});

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

  it('satisfies the shared plain-text turn contract when the PI SDK reports no usage', async () => {
    const replaceMessages = vi.fn();
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    const prompt = vi.fn(async () => {
      listener?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'PI contract reply' },
      });
      listener?.({ type: 'agent_end', messages: [] });
    });

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
        state: createNativeState(replaceMessages),
        setModel: vi.fn(),
      },
    });

    const turnId = 'turn-pi-contract';
    const harness = new PIAgentHarness();
    const session = await harness.openSession(makeConfig());
    try {
      const events = await collectEvents(session.deliverTurn({
        turnId,
        messages: [makeMessage('user', 'Hello', '2026-04-05T10:00:00.000Z')],
      }, {}));
      const exportedState = await session.exportState();

      assertPlainTextTurnContract({
        events,
        turnId,
        exportedState,
        expectedContent: 'PI contract reply',
        requireDoneUsage: false,
      });
    } finally {
      await session.close();
    }
  });

  it('emits an error instead of success when the PI SDK reports a model error', async () => {
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    const prompt = vi.fn(async () => {
      listener?.({
        type: 'turn_end',
        message: {
          stopReason: 'error',
          errorMessage: 'provider rejected configured model',
          usage: {
            input: 0,
            output: 0,
            totalTokens: 0,
          },
        },
      });
      listener?.({ type: 'agent_end', messages: [], willRetry: false });
    });

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
        state: createNativeState(),
        setModel: vi.fn(),
      },
    });

    const session = await new PIAgentHarness().openSession(makeConfig());
    try {
      const events = await collectEvents(session.deliverTurn({
        turnId: 'turn-pi-model-error',
        messages: [
          makeMessage('user', 'Trigger an error', '2026-04-05T10:00:00.000Z'),
        ],
      }, {}));

      expect(events).toEqual([{
        type: 'error',
        error: 'provider rejected configured model',
      }]);
    } finally {
      await session.close();
    }
  });

  it('registers Google runtime auth through the canonical model runtime', async () => {
    const dispose = vi.fn();
    mockCreateAgentSession.mockResolvedValue({
      session: {
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(),
        abort: vi.fn(async () => undefined),
        dispose,
        state: createNativeState(),
        setModel: vi.fn(),
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
    expect(mockSetRuntimeApiKey).toHaveBeenCalledOnce();
    expect(mockCreateAgentSession.mock.calls[0]?.[0]).toMatchObject({
      modelRuntime: mockModelRuntime,
      noTools: 'builtin',
    });
    expect(mockCreateAgentSession.mock.calls[0]?.[0]).not.toHaveProperty(
      'authStorage',
    );
    expect(mockCreateAgentSession.mock.calls[0]?.[0]).not.toHaveProperty(
      'modelRegistry',
    );

    await session.close();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ['openai', 'gpt-5.4-mini', 'openai-completions'],
    ['anthropic', 'claude-sonnet-4-6', 'anthropic-messages'],
    ['google', 'gemini-2.5-flash', 'google-generative-ai'],
  ] as const)(
    'keeps the %s protocol when applying a custom base URL',
    async (provider, model, api) => {
      mockCreateAgentSession.mockResolvedValue({
        session: {
          subscribe: vi.fn(() => vi.fn()),
          prompt: vi.fn(),
          abort: vi.fn(async () => undefined),
          dispose: vi.fn(),
          state: createNativeState(),
          setModel: vi.fn(),
        },
      });

      const session = await new PIAgentHarness().openSession(makeConfig({
        secrets: { providerKey: 'test-provider-key' },
        harnessConfigJson: JSON.stringify({
          provider,
          model,
          apiKeyRef: 'providerKey',
          baseUrl: 'https://gateway.example.test/v1',
        }),
      }));

      try {
        expect(mockCreateAgentSession.mock.calls[0]?.[0]).toMatchObject({
          model: {
            provider,
            id: model,
            api,
            baseUrl: 'https://gateway.example.test/v1',
            apiKey: 'test-provider-key',
          },
        });
      } finally {
        await session.close();
      }
    },
  );

  it('applies canonical output and reasoning bounds to custom gateway models', async () => {
    mockGetModel.mockReturnValueOnce(undefined);
    mockCreateAgentSession.mockResolvedValue({
      session: {
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(),
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
        state: createNativeState(),
        setModel: vi.fn(),
      },
    });

    const session = await new PIAgentHarness().openSession(makeConfig({
      secrets: {
        CTXMILL_MODEL_GATEWAY_ENABLED: 'true',
        CTXMILL_MODEL_GATEWAY_URL: 'http://litellm:4000',
        CTXMILL_MODEL_GATEWAY_RUNTIME_KEY: 'runtime-key',
        CTXMILL_MODEL_GATEWAY_REVISION: 'dev2-1',
      },
      harnessConfigJson: JSON.stringify({
        provider: 'openai',
        model: 'cf-glm-5.2',
        maxTokens: 96,
        reasoning: true,
        thinkingLevel: 'minimal',
      }),
    }));

    try {
      expect(mockCreateAgentSession.mock.calls[0]?.[0]).toMatchObject({
        model: {
          provider: 'openai',
          id: 'cf-glm-5.2',
          maxTokens: 96,
          reasoning: true,
        },
        thinkingLevel: 'minimal',
      });
    } finally {
      await session.close();
    }
  });

  it('uses deployment gateway access and rotates opaque correlation headers per turn', async () => {
    const setModel = vi.fn();
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    const prompt = vi.fn(async () => {
      listener?.({ type: 'agent_end', messages: [] });
    });
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
        state: createNativeState(),
        setModel,
      },
    });

    const session = await new PIAgentHarness().openSession(makeConfig({
      secrets: {
        OPENAI_API_KEY: 'upstream-key-must-not-win',
        CTXMILL_MODEL_GATEWAY_ENABLED: 'true',
        CTXMILL_MODEL_GATEWAY_URL: 'http://litellm:4000',
        CTXMILL_MODEL_GATEWAY_RUNTIME_KEY: 'runtime-key',
        CTXMILL_MODEL_GATEWAY_REVISION: 'dev1-1',
      },
      harnessConfigJson: JSON.stringify({
        provider: 'openai',
        model: 'gpt-4o-mini',
      }),
    }));

    try {
      expect(mockCreateAgentSession.mock.calls[0]?.[0]).toMatchObject({
        model: {
          provider: 'openai',
          id: 'gpt-4o-mini',
          api: 'openai-completions',
          baseUrl: 'http://litellm:4000/v1',
          apiKey: 'runtime-key',
        },
      });
      expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('openai', 'runtime-key');
      expect(mockSetRuntimeApiKey).not.toHaveBeenCalledWith(
        'openai',
        'upstream-key-must-not-win',
      );

      const rawTurnId = 'sensitive-customer-turn';
      await collectEvents(session.deliverTurn({
        turnId: rawTurnId,
        messages: [makeMessage('user', 'Hello', '2026-04-05T10:00:00.000Z')],
      }, {}));

      expect(setModel).toHaveBeenCalledOnce();
      const correlatedModel = setModel.mock.calls[0]?.[0] as {
        headers?: Record<string, string>;
      };
      expect(correlatedModel.headers).toEqual({
        'x-litellm-trace-id': expect.stringMatching(/^ct_[a-f0-9]{32}$/),
        'x-litellm-spend-logs-metadata': expect.any(String),
      });
      expect(JSON.stringify(correlatedModel.headers)).not.toContain(rawTurnId);
    } finally {
      await session.close();
    }
  });

  it('uses the versioned native Google gateway and per-turn correlation headers', async () => {
    const setModel = vi.fn();
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    mockCreateAgentSession.mockResolvedValue({
      session: {
        subscribe: (next: (event: Record<string, unknown>) => void) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        prompt: vi.fn(async () => {
          listener?.({ type: 'agent_end', messages: [] });
        }),
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
        state: createNativeState(),
        setModel,
      },
    });

    const session = await new PIAgentHarness().openSession(makeConfig({
      secrets: {
        GOOGLE_API_KEY: 'upstream-key-must-not-win',
        CTXMILL_MODEL_GATEWAY_ENABLED: 'true',
        CTXMILL_MODEL_GATEWAY_URL: 'http://litellm:4000',
        CTXMILL_MODEL_GATEWAY_RUNTIME_KEY: 'runtime-key',
        CTXMILL_MODEL_GATEWAY_REVISION: 'dev1-1',
      },
      harnessConfigJson: JSON.stringify({
        provider: 'google',
        model: 'gemini-2.5-flash',
      }),
    }));

    try {
      expect(mockCreateAgentSession.mock.calls[0]?.[0]).toMatchObject({
        model: {
          provider: 'google',
          id: 'gemini-2.5-flash',
          api: 'google-generative-ai',
          baseUrl: 'http://litellm:4000/v1beta',
          apiKey: 'runtime-key',
        },
      });
      expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('google', 'runtime-key');
      expect(mockSetRuntimeApiKey).toHaveBeenCalledOnce();
      expect(mockSetRuntimeApiKey).not.toHaveBeenCalledWith(
        'google',
        'upstream-key-must-not-win',
      );

      await collectEvents(session.deliverTurn({
        turnId: 'sensitive-native-google-turn',
        messages: [makeMessage('user', 'Hello', '2026-04-05T10:00:00.000Z')],
      }, {}));

      expect(setModel).toHaveBeenCalledOnce();
      const correlatedModel = setModel.mock.calls[0]?.[0] as {
        headers?: Record<string, string>;
      };
      expect(correlatedModel.headers).toEqual({
        'x-litellm-trace-id': expect.stringMatching(/^ct_[a-f0-9]{32}$/),
        'x-litellm-spend-logs-metadata': expect.any(String),
      });
      expect(JSON.stringify(correlatedModel.headers)).not.toContain(
        'sensitive-native-google-turn',
      );
    } finally {
      await session.close();
    }
  });

  it('falls back to environment secrets for Google runtime auth', async () => {
    process.env.GOOGLE_API_KEY = 'env-google-key';
    mockCreateAgentSession.mockResolvedValue({
      session: {
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(),
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
        state: createNativeState(),
        setModel: vi.fn(),
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
    expect(mockSetRuntimeApiKey).toHaveBeenCalledOnce();

    await session.close();
  });

  it('uses provider-default Google secrets when apiKeyRef is omitted', async () => {
    mockCreateAgentSession.mockResolvedValue({
      session: {
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(),
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
        state: createNativeState(),
        setModel: vi.fn(),
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
    expect(mockSetRuntimeApiKey).toHaveBeenCalledOnce();

    await session.close();
  });

  it('passes the current turn secrets only to native child processes', async () => {
    const tokenKey = 'PILOT_TURN_OWNERSHIP_TOKEN';
    const previousToken = process.env[tokenKey];
    process.env[tokenKey] = 'stable-token';
    mockCreateAgentSession.mockResolvedValue({
      session: {
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(),
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
        state: createNativeState(),
        setModel: vi.fn(),
      },
    });

    const session = await new PIAgentHarness().openSession(makeConfig());
    try {
      const toolOptions = mockCreateCodingTools.mock.calls[0]?.[1] as
        | { bash?: BashToolOptions }
        | undefined;
      const spawnHook = toolOptions?.bash?.spawnHook;
      expect(spawnHook).toBeTypeOf('function');

      const deliveryContext: TurnDeliveryContext = {
        identity: {
          turnId: 'turn-secret-a',
          sandboxSessionId: 'sandbox-session-a',
          agentId: 'test-agent',
          ownerId: 'owner-a',
          fenceToken: 1,
          restoreFenceToken: 1,
        },
        abortController: new AbortController(),
        turnSecrets: Object.freeze({ [tokenKey]: 'turn-token-a' }),
        capability: create(TurnDeliveryCapabilitySchema, {
          ownerId: 'owner-a',
          fenceToken: 1n,
          restoreFenceToken: 1n,
          leaseExpiresAtMs: BigInt(Date.now() + 60_000),
          agentId: 'test-agent',
          signature: 'ctxmill-open-turn-delivery-capability-v1',
        }),
        leaseExpiresAtMs: Date.now() + 60_000,
      };
      const spawnContext = runWithTurnDeliveryContext(deliveryContext, () => spawnHook?.({
        command: 'echo ok',
        cwd: '/tmp/workspace',
        env: { [tokenKey]: 'stable-token' },
      }));

      expect(spawnContext?.env[tokenKey]).toBe('turn-token-a');
      expect(process.env[tokenKey]).toBe('stable-token');
    } finally {
      await session.close();
      if (previousToken === undefined) {
        delete process.env[tokenKey];
      } else {
        process.env[tokenKey] = previousToken;
      }
    }
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
        state: createNativeState(replaceMessages),
        setModel: vi.fn(),
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
    expect(events.at(-1)).toEqual({
      type: 'done',
    });

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
        state: createNativeState(replaceMessages),
        setModel: vi.fn(),
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
    const restoredNativeMessages = replaceMessages.mock.calls[0]?.[0] as Array<{ content: string }> | undefined;
    assertRestorePromptShape(restoredNativeMessages?.map((message) => message.content) ?? [], [
      'Restore user',
      '[Previous tool result (tool-restore)]\nRestored tool output',
      '[Previous assistant response]\nRestored assistant reply',
    ]);
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

describe('PIAgentHarness AgentEvent contract baseline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLangSmith.FakeRunTree.runs = [];
    delete process.env.LANGSMITH_TRACING;
    delete process.env.LANGSMITH_PROJECT;
  });

  it('satisfies the shared tool round-trip contract when usage is available', async () => {
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    const prompt = vi.fn(async () => {
      listener?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'PI used search.' },
      });
      listener?.({
        type: 'tool_execution_start',
        toolCallId: 'tool-pi-search',
        toolName: 'search',
        args: { query: 'ctxmill' },
      });
      listener?.({
        type: 'tool_execution_end',
        toolCallId: 'tool-pi-search',
        result: { content: [{ type: 'text', text: 'pi search result' }] },
      });
      listener?.({
        type: 'turn_end',
        message: { usage: { input: 2, output: 3, totalTokens: 5 } },
      });
      listener?.({ type: 'agent_end', messages: [] });
    });

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
        state: createNativeState(),
        setModel: vi.fn(),
      },
    });

    const turnId = 'turn-pi-tool-contract';
    const harness = new PIAgentHarness();
    const session = await harness.openSession(makeConfig());
    try {
      const events = await collectEvents(session.deliverTurn({
        turnId,
        messages: [makeMessage('user', 'Search', '2026-04-05T12:00:00.000Z')],
      }, {}));
      const exportedState = await session.exportState();

      assertToolRoundTripContract({
        events,
        turnId,
        exportedState,
        expectedContent: 'PI used search.',
        expectedTool: {
          id: 'tool-pi-search',
          name: 'search',
          args: { query: 'ctxmill' },
          result: 'pi search result',
        },
      });
    } finally {
      await session.close();
    }
  });

  it('traces PI normalized AgentEvents through the shared decorator', async () => {
    process.env.LANGSMITH_TRACING = 'true';
    process.env.LANGSMITH_PROJECT = 'ctxmill-test';
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    const prompt = vi.fn(async () => {
      listener?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'PI used search.' },
      });
      listener?.({
        type: 'tool_execution_start',
        toolCallId: 'tool-pi-search',
        toolName: 'search',
        args: { query: 'ctxmill' },
      });
      listener?.({
        type: 'tool_execution_end',
        toolCallId: 'tool-pi-search',
        result: { content: [{ type: 'text', text: 'pi search result' }] },
      });
      listener?.({
        type: 'turn_end',
        message: { usage: { input: 2, output: 3, totalTokens: 5 } },
      });
      listener?.({ type: 'agent_end', messages: [] });
    });

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
        state: createNativeState(),
        setModel: vi.fn(),
      },
    });

    const turnId = 'turn-pi-traced';
    let session: Awaited<ReturnType<PIAgentHarness['openSession']>> | undefined;
    try {
      session = await new PIAgentHarness().openSession(makeConfig());
      await collectEvents(session.deliverTurn({
        turnId,
        messages: [makeMessage('user', 'Search', '2026-04-05T12:00:00.000Z')],
      }, {}));
    } finally {
      await session?.close();
      delete process.env.LANGSMITH_TRACING;
      delete process.env.LANGSMITH_PROJECT;
    }

    const root = mockLangSmith.FakeRunTree.runs[0];
    expect(root.config).toEqual(expect.objectContaining({
      name: 'pi-agent-agent-test-agent',
      run_type: 'chain',
      project_name: 'ctxmill-test',
    }));
    const turn = root.children[0];
    expect(turn.config).toEqual(expect.objectContaining({
      name: 'pi-agent-turn',
      inputs: { turnId },
    }));
    const llm = turn.children.find((child) => child.config.run_type === 'llm');
    expect(llm?.end).toHaveBeenCalledWith(expect.objectContaining({
      generations: [{ text: 'PI used search.' }],
      toolCalls: [expect.objectContaining({ id: 'tool-pi-search', name: 'search' })],
    }));
    const tool = turn.children.find((child) => child.config.run_type === 'tool');
    expect(tool?.config).toEqual(expect.objectContaining({
      name: 'search',
      inputs: { args: { query: 'ctxmill' }, toolCallId: 'tool-pi-search' },
    }));
    expect(tool?.end).toHaveBeenCalledWith(expect.objectContaining({
      result: 'pi search result',
    }));
    expect(root.end).toHaveBeenCalledWith({ status: 'completed' });
  });

  it('satisfies the shared tool-error contract when usage is available', async () => {
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    const prompt = vi.fn(async () => {
      listener?.({
        type: 'tool_execution_start',
        toolCallId: 'tool-pi-error',
        toolName: 'search',
        args: { query: 'bad' },
      });
      listener?.({
        type: 'tool_execution_end',
        toolCallId: 'tool-pi-error',
        result: { content: [{ type: 'text', text: 'pi search failed' }] },
        isError: true,
      });
      listener?.({
        type: 'turn_end',
        message: { usage: { input: 4, output: 1, totalTokens: 5 } },
      });
      listener?.({ type: 'agent_end', messages: [] });
    });

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
        state: createNativeState(),
        setModel: vi.fn(),
      },
    });

    const turnId = 'turn-pi-tool-error-contract';
    const harness = new PIAgentHarness();
    const session = await harness.openSession(makeConfig());
    try {
      const events = await collectEvents(session.deliverTurn({
        turnId,
        messages: [makeMessage('user', 'Search badly', '2026-04-05T12:00:00.000Z')],
      }, {}));
      const exportedState = await session.exportState();

      assertToolErrorContract({
        events,
        turnId,
        exportedState,
        expectedTool: {
          id: 'tool-pi-error',
          name: 'search',
          args: { query: 'bad' },
          error: 'pi search failed',
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
    const tools = convertTools(
      Type,
      [approvalTool],
      {
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        workspaceDir: '/tmp/workspace',
        turnId: 'turn-pi-approval',
        onApprovalNeeded: vi.fn(async () => ({ action: 'approve' as const })),
        queuedEvents: approvalEvents,
      },
    ) as Array<{
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
    }>;

    await tools[0]?.execute('tool-pi-approval', { query: 'allowed' });
    assertApprovalFlowContract(approvalEvents, {
      tool: 'guarded_search',
      action: 'approve',
      args: { query: 'allowed' },
    });
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
    const tools = convertTools(
      Type,
      [approvalTool],
      {
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        workspaceDir: '/tmp/workspace',
        turnId: 'turn-pi-approval-rejected',
        onApprovalNeeded: vi.fn(async () => ({ action: 'reject' as const })),
        queuedEvents: approvalEvents,
      },
    ) as Array<{
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
    }>;

    await expect(tools[0]?.execute('tool-pi-approval-rejected', { query: 'blocked' })).resolves.toEqual({
      content: [{ type: 'text', text: 'Tool call was rejected by the user.' }],
      details: {},
    });
    assertApprovalFlowContract(approvalEvents, {
      tool: 'guarded_search',
      action: 'reject',
      args: { query: 'blocked' },
    });
  });

  it('satisfies the shared abort contract by ending without done', async () => {
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    let resolvePrompt: (() => void) | undefined;
    const prompt = vi.fn(async () => new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    }));
    const abort = vi.fn(async () => {
      resolvePrompt?.();
      listener?.({ type: 'agent_end', messages: [] });
    });

    mockCreateAgentSession.mockResolvedValue({
      session: {
        subscribe: (next: (event: Record<string, unknown>) => void) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        prompt,
        abort,
        dispose: vi.fn(),
        state: createNativeState(),
        setModel: vi.fn(),
      },
    });

    const harness = new PIAgentHarness();
    const session = await harness.openSession(makeConfig());
    try {
      const abortController = new AbortController();
      const eventsPromise = collectEvents(session.deliverTurn({
        turnId: 'turn-pi-abort-contract',
        messages: [makeMessage('user', 'Abort', '2026-04-05T12:00:00.000Z')],
      }, { signal: abortController.signal }));

      while (prompt.mock.calls.length === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      abortController.abort();

      const events = await eventsPromise;
      expect(abort).toHaveBeenCalledTimes(1);
      assertAbortContract(events);
    } finally {
      await session.close();
    }
  });
});
