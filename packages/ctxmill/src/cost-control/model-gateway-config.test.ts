import { afterEach, describe, expect, it } from 'vitest';

import {
  MODEL_GATEWAY_SANDBOX_ENV,
  mergeSandboxSecrets,
  resolveModelGatewayConfig,
} from './model-gateway-config.js';

describe('resolveModelGatewayConfig', () => {
  afterEach(() => {
    delete process.env.CTXMILL_MODEL_GATEWAY_ENABLED;
  });

  it('creates no dependency when the gateway is disabled', () => {
    expect(resolveModelGatewayConfig({
      CTXMILL_MODEL_GATEWAY_ENABLED: 'false',
      CTXMILL_MODEL_GATEWAY_URL: 'not a url',
    })).toEqual({ enabled: false });
  });

  it('requires every deployment-owned value when enabled', () => {
    expect(() => resolveModelGatewayConfig({
      CTXMILL_MODEL_GATEWAY_ENABLED: 'true',
      CTXMILL_MODEL_GATEWAY_URL: 'http://litellm:4000',
      CTXMILL_MODEL_GATEWAY_RUNTIME_KEY: 'runtime-key',
      CTXMILL_MODEL_GATEWAY_METERING_KEY: 'metering-key',
    })).toThrow(/CTXMILL_MODEL_GATEWAY_REVISION/);
  });

  it('rejects a URL with a route path because harnesses add protocol-native paths', () => {
    expect(() => resolveModelGatewayConfig({
      CTXMILL_MODEL_GATEWAY_ENABLED: 'true',
      CTXMILL_MODEL_GATEWAY_URL: 'http://litellm:4000/v1',
      CTXMILL_MODEL_GATEWAY_RUNTIME_KEY: 'runtime-key',
      CTXMILL_MODEL_GATEWAY_METERING_KEY: 'metering-key',
      CTXMILL_MODEL_GATEWAY_REVISION: 'dev1-1',
    })).toThrow(/root URL/);
  });

  it('resolves a strict enabled profile and exposes no metering key to sandboxes', () => {
    const config = resolveModelGatewayConfig({
      CTXMILL_MODEL_GATEWAY_ENABLED: 'true',
      CTXMILL_MODEL_GATEWAY_URL: 'http://litellm:4000/',
      CTXMILL_MODEL_GATEWAY_RUNTIME_KEY: 'runtime-key',
      CTXMILL_MODEL_GATEWAY_METERING_KEY: 'metering-key',
      CTXMILL_MODEL_GATEWAY_REVISION: 'dev1-1',
      CTXMILL_MODEL_GATEWAY_EXPLICIT_FREE_MODELS: 'local-free, test-free,local-free',
    });

    expect(config).toEqual({
      enabled: true,
      profile: 'default',
      baseUrl: 'http://litellm:4000',
      runtimeKey: 'runtime-key',
      meteringKey: 'metering-key',
      revision: 'dev1-1',
      explicitFreeModels: ['local-free', 'test-free'],
      sandboxEnvironment: {
        [MODEL_GATEWAY_SANDBOX_ENV.enabled]: 'true',
        [MODEL_GATEWAY_SANDBOX_ENV.url]: 'http://litellm:4000',
        [MODEL_GATEWAY_SANDBOX_ENV.runtimeKey]: 'runtime-key',
        [MODEL_GATEWAY_SANDBOX_ENV.revision]: 'dev1-1',
      },
    });
    if (!config.enabled) {
      throw new Error('expected enabled gateway');
    }
    expect(config.sandboxEnvironment).toEqual({
      [MODEL_GATEWAY_SANDBOX_ENV.enabled]: 'true',
      [MODEL_GATEWAY_SANDBOX_ENV.url]: 'http://litellm:4000',
      [MODEL_GATEWAY_SANDBOX_ENV.runtimeKey]: 'runtime-key',
      [MODEL_GATEWAY_SANDBOX_ENV.revision]: 'dev1-1',
    });
    expect(JSON.stringify(config.sandboxEnvironment)).not.toContain('metering-key');
  });
});

describe('mergeSandboxSecrets', () => {
  it('drops agent-controlled gateway values and applies deployment values last', () => {
    const merged = mergeSandboxSecrets(
      {
        OPENAI_API_KEY: 'agent-openai',
        [MODEL_GATEWAY_SANDBOX_ENV.enabled]: 'true',
        [MODEL_GATEWAY_SANDBOX_ENV.url]: 'https://attacker.invalid',
        [MODEL_GATEWAY_SANDBOX_ENV.runtimeKey]: 'attacker-key',
      },
      {
        [MODEL_GATEWAY_SANDBOX_ENV.enabled]: 'true',
        [MODEL_GATEWAY_SANDBOX_ENV.url]: 'http://litellm:4000',
        [MODEL_GATEWAY_SANDBOX_ENV.runtimeKey]: 'runtime-key',
        [MODEL_GATEWAY_SANDBOX_ENV.revision]: 'dev1-1',
      },
    );

    expect(merged).toEqual({
      OPENAI_API_KEY: 'agent-openai',
      [MODEL_GATEWAY_SANDBOX_ENV.enabled]: 'true',
      [MODEL_GATEWAY_SANDBOX_ENV.url]: 'http://litellm:4000',
      [MODEL_GATEWAY_SANDBOX_ENV.runtimeKey]: 'runtime-key',
      [MODEL_GATEWAY_SANDBOX_ENV.revision]: 'dev1-1',
    });
  });

  it('removes forged gateway values even in a direct-only deployment', () => {
    expect(mergeSandboxSecrets({
      FOO: 'bar',
      [MODEL_GATEWAY_SANDBOX_ENV.enabled]: 'true',
      [MODEL_GATEWAY_SANDBOX_ENV.runtimeKey]: 'forged',
    })).toEqual({ FOO: 'bar' });
  });
});
