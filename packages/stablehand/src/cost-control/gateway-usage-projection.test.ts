import { describe, expect, it } from 'vitest';

import { projectGatewayTurnUsage } from './gateway-usage-projection.js';

const pricedAttempt = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  costUsd: 0.02,
  costState: 'priced' as const,
};

describe('projectGatewayTurnUsage', () => {
  it('keeps finish-time gateway usage pending while retaining known spend', () => {
    expect(projectGatewayTurnUsage({
      turnMode: 'gateway_only',
      harnessUsage: {
        inputTokens: 9,
        outputTokens: 4,
        totalTokens: 13,
      },
      attempts: [pricedAttempt],
      settled: false,
    })).toEqual({
      inputTokens: 9,
      outputTokens: 4,
      totalTokens: 13,
      modelCalls: {
        observed: 1,
        costKnown: 1,
        expected: null,
      },
      cost: {
        totalUsd: null,
        knownUsd: 0.02,
        coverage: 'pending',
      },
    });
  });

  it('uses complete LiteLLM aggregate usage once a gateway-only turn settles', () => {
    expect(projectGatewayTurnUsage({
      turnMode: 'gateway_only',
      harnessUsage: {
        inputTokens: 999,
        outputTokens: 999,
        totalTokens: 1998,
      },
      attempts: [
        pricedAttempt,
        {
          inputTokens: 20,
          outputTokens: 10,
          totalTokens: 30,
          costUsd: 0,
          costState: 'explicit_free',
        },
      ],
      settled: true,
    })).toEqual({
      inputTokens: 30,
      outputTokens: 15,
      totalTokens: 45,
      modelCalls: {
        observed: 2,
        costKnown: 2,
        expected: null,
      },
      cost: {
        totalUsd: 0.02,
        knownUsd: 0.02,
        coverage: 'complete',
      },
    });
  });

  it('never turns an unknown zero price into free', () => {
    expect(projectGatewayTurnUsage({
      turnMode: 'gateway_only',
      harnessUsage: {
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 3,
      },
      attempts: [{
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 3,
        costState: 'unpriced',
      }],
      settled: true,
    })?.cost).toEqual({
      totalUsd: null,
      knownUsd: 0,
      coverage: 'unpriced',
    });
  });

  it('keeps mixed direct and gateway branches partial after settlement', () => {
    expect(projectGatewayTurnUsage({
      turnMode: 'mixed',
      harnessUsage: {
        inputTokens: 30,
        outputTokens: 15,
        totalTokens: 45,
      },
      attempts: [pricedAttempt],
      settled: true,
    })).toEqual({
      inputTokens: 30,
      outputTokens: 15,
      totalTokens: 45,
      modelCalls: {
        observed: 1,
        costKnown: 1,
        expected: null,
      },
      cost: {
        totalUsd: null,
        knownUsd: 0.02,
        coverage: 'partial',
      },
    });
  });

  it('returns null only when neither harness nor gateway reports tokens', () => {
    expect(projectGatewayTurnUsage({
      turnMode: 'gateway_only',
      harnessUsage: null,
      attempts: [],
      settled: false,
    })).toBeNull();
  });
});
