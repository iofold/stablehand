import { describe, expect, it, vi } from 'vitest';

import { SESSION_CANCELLED_MESSAGE } from '@ctxmill/shared';
import { TurnFinalizer, deriveTurnStatus } from '../turn-finalizer.js';

function createDeps(finalizeResult = true) {
  return {
    db: { finalizeTurnIfOpen: vi.fn().mockResolvedValue(finalizeResult) },
    eventBus: { emit: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

const BASE_PARAMS = {
  turnId: 'turn-1',
  agentId: 'agent-1',
  conversationId: 'conv-1',
  status: 'error' as const,
  error: 'boom',
};

describe('TurnFinalizer (ADR-014)', () => {
  it('writes terminal state through finalizeTurnIfOpen and emits turn.completed', async () => {
    const deps = createDeps();
    const finalizer = new TurnFinalizer(deps);

    const result = await finalizer.finalize({ ...BASE_PARAMS, sessionId: 'sess-1', durationMs: 42 });

    expect(result.finalized).toBe(true);
    expect(deps.db.finalizeTurnIfOpen).toHaveBeenCalledWith('turn-1', {
      sessionId: 'sess-1',
      completedAt: expect.any(Number),
      error: 'boom',
      status: 'error',
    });
    expect(deps.eventBus.emit).toHaveBeenCalledWith('turn.completed', expect.objectContaining({
      turnId: 'turn-1',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      status: 'error',
      error: 'boom',
      durationMs: 42,
    }));
  });

  it('skips the emit entirely when the turn was already terminal (idempotence)', async () => {
    const deps = createDeps(false);
    const finalizer = new TurnFinalizer(deps);

    const result = await finalizer.finalize(BASE_PARAMS);

    expect(result.finalized).toBe(false);
    expect(deps.eventBus.emit).not.toHaveBeenCalled();
  });

  it('routes the completion signal through emitCompletion when provided', async () => {
    const deps = createDeps();
    const finalizer = new TurnFinalizer(deps);
    const emitCompletion = vi.fn();

    await finalizer.finalize({ ...BASE_PARAMS, emitCompletion });

    expect(emitCompletion).toHaveBeenCalledWith(expect.any(Number));
    expect(deps.eventBus.emit).not.toHaveBeenCalled();
  });

  it('keeps the turn finalized when the completion signal throws', async () => {
    const deps = createDeps();
    const finalizer = new TurnFinalizer(deps);

    const result = await finalizer.finalize({
      ...BASE_PARAMS,
      emitCompletion: () => { throw new Error('signal failed'); },
    });

    expect(result.finalized).toBe(true);
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it('emits a webhook-safe status vocabulary via deriveTurnStatus', () => {
    expect(deriveTurnStatus({ cancelled: true })).toBe('cancelled');
    expect(deriveTurnStatus({ error: SESSION_CANCELLED_MESSAGE })).toBe('cancelled');
    expect(deriveTurnStatus({ error: 'boom' })).toBe('error');
    expect(deriveTurnStatus({})).toBe('completed');
  });
});
