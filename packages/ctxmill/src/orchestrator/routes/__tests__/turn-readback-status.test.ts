import { describe, expect, it } from 'vitest';
import { toApiAgentTurn } from '../agents/helpers.js';

const baseTurn = {
  id: 'turn-1',
  agentId: 'agent-1',
  conversationId: 'conv-1',
  sandboxSessionId: 'sandbox-1',
  mode: 'interactive',
  status: 'running',
  taskDescription: null,
  startedAt: 1,
  completedAt: null,
  error: null,
};

describe('toApiAgentTurn', () => {
  it('does not report an unfinished logical turn as TERMINATED from a stale sandbox attempt', () => {
    const turn = toApiAgentTurn(baseTurn, { status: 'TERMINATED' }, 1);

    expect(turn.status).toBe('RUNNING');
    expect(turn.completedAt).toBeUndefined();
    expect(turn.error).toBeUndefined();
  });

  it('still reports completed turns from the turn row', () => {
    const turn = toApiAgentTurn(
      { ...baseTurn, completedAt: 10 },
      { status: 'TERMINATED' },
      2,
    );

    expect(turn.status).toBe('COMPLETED');
    expect(turn.completedAt).toBe(10);
  });

  it('reports durably cancelled turns as CANCELLED', () => {
    const turn = toApiAgentTurn(
      { ...baseTurn, completedAt: 10, error: 'Turn cancelled' },
      null,
      1,
    );

    expect(turn.status).toBe('CANCELLED');
    expect(turn.error).toBe('Turn cancelled');
  });

  it('reports gateway-attributed turns awaiting reconciliation as cost-pending', () => {
    const turn = toApiAgentTurn(
      {
        ...baseTurn,
        completedAt: 10,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        gatewayMode: 'gateway_only',
      },
      null,
      1,
    );

    expect(turn.usage?.cost.coverage).toBe('pending');
  });

  it('reports direct turns without cost as unpriced, matching analytics', () => {
    const turn = toApiAgentTurn(
      {
        ...baseTurn,
        completedAt: 10,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        gatewayMode: 'direct',
      },
      null,
      1,
    );

    expect(turn.usage?.cost.coverage).toBe('unpriced');
  });

  it('exposes budget tags and gateway attribution mode', () => {
    const turn = toApiAgentTurn(
      {
        ...baseTurn,
        tags: { agent: 'agent-1', team: 'growth' },
        gatewayMode: 'mixed',
      },
      null,
      1,
    );

    expect(turn.tags).toEqual({ agent: 'agent-1', team: 'growth' });
    expect(turn.gatewayMode).toBe('mixed');
  });

  it('defaults tags to empty and gatewayMode to null for direct turns', () => {
    const turn = toApiAgentTurn(baseTurn, null, 1);

    expect(turn.tags).toEqual({});
    expect(turn.gatewayMode).toBeNull();
  });

  it('includes raw sandbox restore fields even when the turn projects ERROR', () => {
    const turn = toApiAgentTurn(
      { ...baseTurn, completedAt: 10, error: 'Restore retry budget exhausted' },
      {
        status: 'CHECKPOINTED',
        restoreAttempts: 3,
        lastRestoreError: 'simulated restore failure',
        updatedAt: 42,
      },
      2,
    );

    expect(turn.status).toBe('ERROR');
    expect(turn.sandboxSessionId).toBe('sandbox-1');
    expect(turn.sandboxStatus).toBe('CHECKPOINTED');
    expect(turn.restoreAttempts).toBe(3);
    expect(turn.lastRestoreError).toBe('simulated restore failure');
    expect(turn.checkpointAt).toBe(42);
  });
});
