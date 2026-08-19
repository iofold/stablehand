import { describe, expect, it } from 'vitest';

import {
  RunFinishedEventSchema,
  TurnCompletedWebhookPayloadSchema,
  TurnSchema,
  TurnUsageSchema,
} from './index.js';

const USAGE = {
  inputTokens: 120,
  outputTokens: 30,
  totalTokens: 150,
  modelCalls: {
    observed: 2,
    costKnown: 1,
    expected: 2,
  },
  cost: {
    totalUsd: null,
    knownUsd: 0.003,
    coverage: 'partial',
  },
} as const;

describe('TurnUsageSchema', () => {
  it('represents partial cost without presenting the known subtotal as total', () => {
    expect(TurnUsageSchema.parse(USAGE)).toEqual(USAGE);
  });

  it('distinguishes complete free, unpriced, and pending cost', () => {
    expect(TurnUsageSchema.parse({
      ...USAGE,
      modelCalls: { observed: 1, costKnown: 1, expected: 1 },
      cost: { totalUsd: 0, knownUsd: 0, coverage: 'complete' },
    }).cost.totalUsd).toBe(0);
    expect(TurnUsageSchema.parse({
      ...USAGE,
      modelCalls: { observed: 1, costKnown: 0, expected: 1 },
      cost: { totalUsd: null, knownUsd: 0, coverage: 'unpriced' },
    }).cost.coverage).toBe('unpriced');
    expect(TurnUsageSchema.parse({
      ...USAGE,
      modelCalls: { observed: 1, costKnown: 0, expected: 1 },
      cost: { totalUsd: null, knownUsd: 0, coverage: 'pending' },
    }).cost.coverage).toBe('pending');
  });

  it('rejects impossible call counts and dishonest totals', () => {
    expect(() => TurnUsageSchema.parse({
      ...USAGE,
      modelCalls: { observed: 1, costKnown: 2, expected: 1 },
    })).toThrow();
    expect(() => TurnUsageSchema.parse({
      ...USAGE,
      cost: { totalUsd: 0.003, knownUsd: 0.003, coverage: 'partial' },
    })).toThrow();
    expect(() => TurnUsageSchema.parse({
      ...USAGE,
      cost: { totalUsd: null, knownUsd: 0.003, coverage: 'complete' },
    })).toThrow();
  });
});

describe('usage-bearing API boundaries', () => {
  const identity = {
    id: 'turn-1',
    agentId: 'agent-1',
    conversationId: 'conversation-1',
    status: 'COMPLETED',
    mode: 'interactive',
    queuedAt: 1,
    startedAt: 1,
  } as const;

  it('accepts budget tags and gateway attribution on turns', () => {
    const parsed = TurnSchema.parse({
      ...identity,
      usage: null,
      tags: { agent: 'agent-1' },
      gatewayMode: 'gateway_only',
    });
    expect(parsed.tags).toEqual({ agent: 'agent-1' });
    expect(parsed.gatewayMode).toBe('gateway_only');
    expect(TurnSchema.parse({
      ...identity,
      usage: null,
      gatewayMode: null,
    }).gatewayMode).toBeNull();
    expect(() => TurnSchema.parse({
      ...identity,
      usage: null,
      gatewayMode: 'direct',
    })).toThrow();
  });

  it('requires usage as nullable on turns and rejects the legacy optional shape', () => {
    expect(TurnSchema.parse({ ...identity, usage: null }).usage).toBeNull();
    expect(TurnSchema.parse({ ...identity, usage: USAGE }).usage).toEqual(USAGE);
    expect(() => TurnSchema.parse(identity)).toThrow();
    expect(() => TurnSchema.parse({
      ...identity,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        costUsd: 0.01,
      },
    })).toThrow();
  });

  it('uses the same required-nullable usage contract for SSE and webhooks', () => {
    const run = {
      type: 'RUN_FINISHED',
      runId: 'turn-1',
      threadId: 'conversation-1',
      usage: null,
    };
    expect(RunFinishedEventSchema.parse(run).usage).toBeNull();
    expect(() => RunFinishedEventSchema.parse({
      ...run,
      usage: undefined,
    })).toThrow();

    const webhook = {
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      status: 'completed',
      durationMs: 1,
      usage: null,
      timestamp: 2,
    };
    expect(TurnCompletedWebhookPayloadSchema.parse(webhook).usage).toBeNull();
    expect(() => TurnCompletedWebhookPayloadSchema.parse({
      ...webhook,
      usage: undefined,
    })).toThrow();
  });
});
