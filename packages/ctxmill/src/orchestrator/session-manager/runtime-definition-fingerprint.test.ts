import { describe, expect, it } from 'vitest';

import {
  createRuntimeDefinitionFingerprint,
  type RuntimeDefinitionFingerprintContext,
} from './runtime-definition-fingerprint.js';

const DIRECT_CONTEXT: RuntimeDefinitionFingerprintContext = {
  gateway: { enabled: false },
  agentSecretRevision: 'secrets-1',
};

function agentDefinition() {
  return {
    name: 'finance-agent',
    harness: 'langgraph',
    systemPrompt: 'Close the books.',
    tools: ['artifact_upload'],
    harnessConfig: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
  };
}

describe('createRuntimeDefinitionFingerprint', () => {
  it('is stable across object key order without reading credential values', () => {
    const first = createRuntimeDefinitionFingerprint(
      agentDefinition(),
      DIRECT_CONTEXT,
    );
    const reordered = createRuntimeDefinitionFingerprint({
      tools: ['artifact_upload'],
      systemPrompt: 'Close the books.',
      harnessConfig: {
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
      },
      harness: 'langgraph',
      name: 'finance-agent',
    }, DIRECT_CONTEXT);

    expect(reordered).toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes for execution, connection-mode, gateway, or secret revisions', () => {
    const base = createRuntimeDefinitionFingerprint(
      agentDefinition(),
      DIRECT_CONTEXT,
    );
    const explicitDirect = createRuntimeDefinitionFingerprint({
      ...agentDefinition(),
      harnessConfig: {
        ...agentDefinition().harnessConfig,
        apiKeyRef: '$secret:ANTHROPIC_API_KEY',
      },
    }, {
      gateway: {
        enabled: true,
        profile: 'default',
        revision: 'gateway-1',
      },
      agentSecretRevision: 'secrets-1',
    });
    const gateway = createRuntimeDefinitionFingerprint(
      agentDefinition(),
      {
        gateway: {
          enabled: true,
          profile: 'default',
          revision: 'gateway-1',
        },
        agentSecretRevision: 'secrets-1',
      },
    );
    const rotatedGateway = createRuntimeDefinitionFingerprint(
      agentDefinition(),
      {
        gateway: {
          enabled: true,
          profile: 'default',
          revision: 'gateway-2',
        },
        agentSecretRevision: 'secrets-1',
      },
    );
    const rotatedAgentSecret = createRuntimeDefinitionFingerprint(
      agentDefinition(),
      {
        gateway: { enabled: false },
        agentSecretRevision: 'secrets-2',
      },
    );

    expect(new Set([
      base,
      explicitDirect,
      gateway,
      rotatedGateway,
      rotatedAgentSecret,
    ])).toHaveLength(5);
  });
});
