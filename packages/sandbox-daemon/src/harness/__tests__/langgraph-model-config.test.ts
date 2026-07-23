import { beforeEach, describe, expect, it, vi } from 'vitest';

const constructorCalls = vi.hoisted(() => ({
  anthropic: [] as Array<Record<string, unknown>>,
  google: [] as Array<Record<string, unknown>>,
  openai: [] as Array<Record<string, unknown>>,
}));

vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class MockChatAnthropic {
    constructor(options: Record<string, unknown>) {
      constructorCalls.anthropic.push(options);
    }
  },
}));

vi.mock('@langchain/google-genai', () => ({
  ChatGoogleGenerativeAI: class MockChatGoogleGenerativeAI {
    constructor(options: Record<string, unknown>) {
      constructorCalls.google.push(options);
    }
  },
}));

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class MockChatOpenAI {
    constructor(options: Record<string, unknown>) {
      constructorCalls.openai.push(options);
    }
  },
}));

import { LangGraphHarness } from '../langgraph.js';
import type { HarnessSessionConfig } from '../types.js';

function makeConfig(provider: 'openai' | 'anthropic' | 'google'): HarnessSessionConfig {
  return {
    systemPrompt: 'Test model configuration.',
    tools: [],
    secrets: { providerKey: 'test-key' },
    agentId: 'agent-1',
    conversationId: 'conversation-1',
    workspaceDir: '/tmp/workspace',
    harnessConfigJson: JSON.stringify({
      provider,
      model: 'model-id',
      apiKeyRef: 'providerKey',
      topP: 0.42,
    }),
  };
}

describe('LangGraph provider model configuration', () => {
  beforeEach(() => {
    constructorCalls.anthropic.length = 0;
    constructorCalls.google.length = 0;
    constructorCalls.openai.length = 0;
  });

  it.each(['openai', 'anthropic', 'google'] as const)(
    'forwards topP to the %s LangChain model',
    async (provider) => {
      const session = await new LangGraphHarness().openSession(makeConfig(provider));
      const buildModel = Reflect.get(session, 'buildModelFromConfig') as (
        secrets: Readonly<Record<string, string>>,
        turnId?: string,
      ) => Promise<unknown>;

      try {
        await buildModel({ providerKey: 'test-key' });
      } finally {
        await session.close();
      }

      expect(constructorCalls[provider]).toEqual([
        expect.objectContaining({ topP: 0.42 }),
      ]);
    },
  );

  it('routes an implicit OpenAI branch through the gateway with opaque turn correlation', async () => {
    const config = makeConfig('openai');
    config.harnessConfigJson = JSON.stringify({
      provider: 'openai',
      model: 'ctxmill-openai',
    });
    config.secrets = {
      CTXMILL_MODEL_GATEWAY_ENABLED: 'true',
      CTXMILL_MODEL_GATEWAY_URL: 'http://litellm:4000',
      CTXMILL_MODEL_GATEWAY_RUNTIME_KEY: 'runtime-key',
      CTXMILL_MODEL_GATEWAY_REVISION: 'dev1-1',
    };
    const session = await new LangGraphHarness().openSession(config);
    const buildModel = Reflect.get(session, 'buildModelFromConfig') as (
      secrets: Readonly<Record<string, string>>,
      turnId?: string,
    ) => Promise<unknown>;

    try {
      await buildModel(config.secrets, 'customer@example.com-close');
    } finally {
      await session.close();
    }

    expect(constructorCalls.openai).toEqual([
      expect.objectContaining({
        apiKey: 'runtime-key',
        modelName: 'ctxmill-openai',
        configuration: {
          baseURL: 'http://litellm:4000/v1',
          defaultHeaders: {
            'x-litellm-trace-id': expect.stringMatching(/^ct_[a-f0-9]{32}$/),
            'x-litellm-spend-logs-metadata': expect.not.stringContaining('customer@example.com'),
          },
        },
      }),
    ]);
  });

  it('routes an implicit Anthropic branch through its native gateway endpoint', async () => {
    const config = makeConfig('anthropic');
    config.harnessConfigJson = JSON.stringify({
      provider: 'anthropic',
      model: 'ctxmill-anthropic',
    });
    config.secrets = {
      CTXMILL_MODEL_GATEWAY_ENABLED: 'true',
      CTXMILL_MODEL_GATEWAY_URL: 'http://litellm:4000',
      CTXMILL_MODEL_GATEWAY_RUNTIME_KEY: 'runtime-key',
      CTXMILL_MODEL_GATEWAY_REVISION: 'dev1-1',
    };
    const session = await new LangGraphHarness().openSession(config);
    const buildModel = Reflect.get(session, 'buildModelFromConfig') as (
      secrets: Readonly<Record<string, string>>,
      turnId?: string,
    ) => Promise<unknown>;

    try {
      await buildModel(config.secrets, 'turn-1');
    } finally {
      await session.close();
    }

    expect(constructorCalls.anthropic).toEqual([
      expect.objectContaining({
        anthropicApiKey: 'runtime-key',
        anthropicApiUrl: 'http://litellm:4000',
        model: 'ctxmill-anthropic',
        clientOptions: {
          defaultHeaders: expect.objectContaining({
            'x-litellm-trace-id': expect.stringMatching(/^ct_[a-f0-9]{32}$/),
          }),
        },
      }),
    ]);
  });
});
