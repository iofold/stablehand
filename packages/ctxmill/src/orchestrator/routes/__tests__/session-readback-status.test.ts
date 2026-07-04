import { describe, expect, it } from 'vitest';
import { toApiAgentSession } from '../agents/helpers.js';

const baseTurn = {
  id: 'turn-1',
  agentId: 'agent-1',
  conversationId: 'conv-1',
  sessionId: 'sandbox-1',
  mode: 'interactive',
  taskDescription: null,
  startedAt: 1,
  completedAt: null,
  error: null,
};

describe('toApiAgentSession', () => {
  it('does not report an unfinished logical turn as TERMINATED from a stale sandbox attempt', () => {
    const session = toApiAgentSession(baseTurn, { status: 'TERMINATED' }, 1);

    expect(session.status).toBe('ACTIVE');
    expect(session.completedAt).toBeUndefined();
    expect(session.error).toBeUndefined();
  });

  it('still reports completed turns from the turn row', () => {
    const session = toApiAgentSession(
      { ...baseTurn, completedAt: 10 },
      { status: 'TERMINATED' },
      2,
    );

    expect(session.status).toBe('COMPLETED');
    expect(session.completedAt).toBe(10);
  });

  it('reports durably cancelled turns as CANCELLED', () => {
    const session = toApiAgentSession(
      { ...baseTurn, completedAt: 10, error: 'Session cancelled' },
      null,
      1,
    );

    expect(session.status).toBe('CANCELLED');
    expect(session.error).toBe('Session cancelled');
  });

  it('includes raw sandbox restore fields even when the turn projects ERROR', () => {
    const session = toApiAgentSession(
      { ...baseTurn, completedAt: 10, error: 'Restore retry budget exhausted' },
      {
        status: 'CHECKPOINTED',
        restoreAttempts: 3,
        lastRestoreError: 'simulated restore failure',
        updatedAt: 42,
      },
      2,
    );

    expect(session.status).toBe('ERROR');
    expect(session.sandboxSessionId).toBe('sandbox-1');
    expect(session.sandboxStatus).toBe('CHECKPOINTED');
    expect(session.restoreAttempts).toBe(3);
    expect(session.lastRestoreError).toBe('simulated restore failure');
    expect(session.checkpointAt).toBe(42);
  });
});
