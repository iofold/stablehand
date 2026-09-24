import { describe, expect, it } from 'vitest';

import {
  resolveModelGatewayTurnAttribution,
} from './model-gateway-attribution.js';

const gateway = {
  enabled: true,
  profile: 'default',
  revision: 'dev1-r1',
} as const;

describe('resolveModelGatewayTurnAttribution', () => {
  it('creates no gateway attribution when deployment access is disabled', () => {
    expect(resolveModelGatewayTurnAttribution({
      harness: 'langgraph',
      harnessConfig: {
        provider: 'openai',
        model: 'gpt-5.4-mini',
      },
      gateway: { enabled: false },
      turnId: 'turn-direct',
    })).toEqual({ mode: 'direct' });
  });

  it('marks an implicit certified branch as gateway-only with opaque correlation', () => {
    const attribution = resolveModelGatewayTurnAttribution({
      harness: 'claude-agents',
      harnessConfig: {
        model: 'claude-sonnet-4-6',
      },
      gateway,
      turnId: 'customer@example.com-close',
    });

    expect(attribution).toEqual({
      mode: 'gateway_only',
      profile: 'default',
      revision: 'dev1-r1',
      correlationId: expect.stringMatching(/^ct_[a-f0-9]{32}$/),
    });
    expect(JSON.stringify(attribution)).not.toContain('customer@example.com');
  });

  it('keeps explicit key and endpoint branches direct', () => {
    expect(resolveModelGatewayTurnAttribution({
      harness: 'pi-agent',
      harnessConfig: {
        provider: 'openai',
        model: 'gpt-5.4-mini',
        apiKeyRef: '$secret:OPENAI_API_KEY',
      },
      gateway,
      turnId: 'turn-key',
    })).toEqual({ mode: 'direct' });

    expect(resolveModelGatewayTurnAttribution({
      harness: 'claude-agents',
      harnessConfig: {
        model: 'claude-sonnet-4-6',
        baseUrl: 'https://anthropic-proxy.example.test',
      },
      gateway,
      turnId: 'turn-endpoint',
    })).toEqual({ mode: 'direct' });
  });

  it('attributes implicit native Google branches to the gateway', () => {
    expect(resolveModelGatewayTurnAttribution({
      harness: 'langgraph',
      harnessConfig: {
        provider: 'google',
        model: 'gemini-2.5-flash',
      },
      gateway,
      turnId: 'turn-google',
    })).toEqual({
      mode: 'gateway_only',
      profile: 'default',
      revision: 'dev1-r1',
      correlationId: expect.stringMatching(/^ct_[a-f0-9]{32}$/),
    });
  });

  it('classifies independently configured LangGraph branches as mixed', () => {
    expect(resolveModelGatewayTurnAttribution({
      harness: 'langgraph',
      harnessConfig: {
        provider: 'openai',
        model: 'gpt-5.4-mini',
        subagents: [
          {
            name: 'direct-google',
            description: 'Uses Google directly',
            systemPrompt: 'Help',
            provider: 'google',
            model: 'gemini-2.5-flash',
            apiKeyRef: '$secret:GOOGLE_API_KEY',
          },
          {
            name: 'gateway-anthropic',
            description: 'Uses Anthropic through the gateway',
            systemPrompt: 'Help',
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
          },
        ],
      },
      gateway,
      turnId: 'turn-mixed',
    })).toEqual({
      mode: 'mixed',
      profile: 'default',
      revision: 'dev1-r1',
      correlationId: expect.stringMatching(/^ct_[a-f0-9]{32}$/),
    });
  });

  it('does not infer a model contract for custom harnesses', () => {
    expect(resolveModelGatewayTurnAttribution({
      harness: 'custom-harness',
      harnessConfig: { anything: true },
      gateway,
      turnId: 'turn-custom',
    })).toEqual({ mode: 'direct' });
  });
});
