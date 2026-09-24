import { describe, expect, it } from 'vitest';

import {
  createGatewayCorrelationHeaders,
  resolveHarnessModelConnection,
  toOpaqueTurnCorrelation,
} from '../model-gateway.js';

const gatewaySecrets = {
  STABLEHAND_MODEL_GATEWAY_ENABLED: 'true',
  STABLEHAND_MODEL_GATEWAY_URL: 'http://litellm:4000',
  STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY: 'runtime-key',
  STABLEHAND_MODEL_GATEWAY_REVISION: 'dev1-1',
};

describe('resolveHarnessModelConnection', () => {
  it('keeps direct mode free of a gateway dependency', () => {
    expect(resolveHarnessModelConnection({
      provider: 'openai',
      secrets: { OPENAI_API_KEY: 'direct-key' },
    })).toEqual({
      mode: 'direct',
      provider: 'openai',
      apiKey: 'direct-key',
    });
  });

  it('uses the protocol-native OpenAI endpoint when the implicit branch is certified', () => {
    expect(resolveHarnessModelConnection({
      provider: 'openai',
      secrets: gatewaySecrets,
    })).toEqual({
      mode: 'gateway',
      provider: 'openai',
      apiKey: 'runtime-key',
      baseUrl: 'http://litellm:4000/v1',
      gatewayRevision: 'dev1-1',
    });
  });

  it('uses the gateway root for Anthropic native clients', () => {
    expect(resolveHarnessModelConnection({
      provider: 'anthropic',
      secrets: gatewaySecrets,
    })).toEqual({
      mode: 'gateway',
      provider: 'anthropic',
      apiKey: 'runtime-key',
      baseUrl: 'http://litellm:4000',
      gatewayRevision: 'dev1-1',
    });
  });

  it('keeps explicit API-key and endpoint branches direct', () => {
    expect(resolveHarnessModelConnection({
      provider: 'openai',
      apiKeyRef: '$secret:CUSTOM_KEY',
      secrets: {
        ...gatewaySecrets,
        CUSTOM_KEY: 'custom-key',
      },
    })).toEqual({
      mode: 'direct',
      provider: 'openai',
      apiKey: 'custom-key',
    });

    expect(resolveHarnessModelConnection({
      provider: 'anthropic',
      baseUrl: 'https://custom.example.test',
      secrets: {
        ...gatewaySecrets,
        ANTHROPIC_API_KEY: 'direct-key',
      },
    })).toEqual({
      mode: 'direct',
      provider: 'anthropic',
      apiKey: 'direct-key',
      baseUrl: 'https://custom.example.test',
    });
  });

  it('uses the gateway root for certified native Google clients', () => {
    expect(resolveHarnessModelConnection({
      provider: 'google',
      secrets: {
        ...gatewaySecrets,
        GOOGLE_API_KEY: 'google-key',
      },
    })).toEqual({
      mode: 'gateway',
      provider: 'google',
      apiKey: 'runtime-key',
      baseUrl: 'http://litellm:4000',
      gatewayRevision: 'dev1-1',
    });
  });

  it('fails closed on an incomplete enabled gateway environment', () => {
    expect(() => resolveHarnessModelConnection({
      provider: 'openai',
      secrets: {
        STABLEHAND_MODEL_GATEWAY_ENABLED: 'true',
        STABLEHAND_MODEL_GATEWAY_URL: 'http://litellm:4000',
      },
    })).toThrow(/runtime credential/);
  });
});

describe('gateway correlation', () => {
  it('uses a deterministic opaque value instead of forwarding caller turn IDs', () => {
    const rawTurnId = 'customer@example.com-quarter-close';
    const correlation = toOpaqueTurnCorrelation(rawTurnId);

    expect(correlation).toMatch(/^ct_[a-f0-9]{32}$/);
    expect(correlation).not.toContain(rawTurnId);
    expect(toOpaqueTurnCorrelation(rawTurnId)).toBe(correlation);
    expect(toOpaqueTurnCorrelation(`${rawTurnId}-2`)).not.toBe(correlation);
  });

  it('places only the opaque correlation in LiteLLM headers', () => {
    const headers = createGatewayCorrelationHeaders('sensitive-turn-name');
    expect(headers).toEqual({
      'x-litellm-trace-id': expect.stringMatching(/^ct_[a-f0-9]{32}$/),
      'x-litellm-spend-logs-metadata': expect.any(String),
    });
    expect(JSON.parse(headers['x-litellm-spend-logs-metadata']!)).toEqual({
      stablehand_turn_correlation: expect.stringMatching(/^ct_[a-f0-9]{32}$/),
    });
    expect(JSON.stringify(headers)).not.toContain('sensitive-turn-name');
  });
});
