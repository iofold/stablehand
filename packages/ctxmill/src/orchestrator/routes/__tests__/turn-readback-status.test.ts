import { describe, expect, it } from 'vitest';
import { toApiAgentTurn } from '../agents/helpers.js';

const baseTurn = {
  id: 'turn-1',
  agentId: 'agent-1',
  conversationId: 'conv-1',
  sandboxSessionId: 'sandbox-1',
  mode: 'interactive',
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
