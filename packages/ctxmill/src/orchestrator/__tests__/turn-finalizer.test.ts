import { describe, expect, it, vi } from 'vitest';

import { TURN_CANCELLED_MESSAGE } from '@ctxmill/shared';
import { TurnFinalizer, deriveTurnStatus } from '../turn-finalizer.js';

const BASE_TURN = {
  id: 'turn-1',
  sandboxSessionId: 'sandbox-session-1',
  agentId: 'agent-1',
  conversationId: 'conv-1',
  mode: 'interactive',
  taskDescription: 'test',
  status: 'error' as const,
  userMessageId: null,
  startedAt: 100,
  completedAt: 150,
  error: 'boom',
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  costUsd: null,
  nextMessageSeq: 0,
  terminalPublishedSeq: null,
  tags: {},
};

function createDeps(options: {
  finalizeResult?: boolean;
  turn?: typeof BASE_TURN;
} = {}) {
  return {
    db: {
      finalizeTurnIfOpen: vi.fn().mockResolvedValue(options.finalizeResult ?? true),
      finalizeTurnAndMarkLifecycleDraining: vi.fn().mockResolvedValue(
        options.finalizeResult ?? true,
      ),
      getTurn: vi.fn().mockResolvedValue(options.turn ?? BASE_TURN),
    },
    eventBus: {
      emitAsync: vi.fn().mockResolvedValue(undefined),
      emit: vi.fn(),
    },
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
  it('awaits durable terminal publication before settling session lifecycle', async () => {
    const order: string[] = [];
    const deps = createDeps();
    deps.db.finalizeTurnIfOpen.mockImplementation(async () => {
      order.push('finalize');
      return true;
    });
    deps.eventBus.emitAsync.mockImplementation(async () => {
      order.push('publish');
    });
    const settleSessionLifecycle = vi.fn(() => {
      order.push('settle');
    });
    const finalizer = new TurnFinalizer(deps);

    const result = await finalizer.finalize({
      ...BASE_PARAMS,
      sandboxSessionId: 'sandbox-session-1',
      durationMs: 42,
      settleSessionLifecycle,
    });

    expect(result).toEqual({ finalized: true, published: true });
    expect(order).toEqual(['finalize', 'publish', 'settle']);
    expect(deps.db.finalizeTurnIfOpen).toHaveBeenCalledWith('turn-1', {
      sandboxSessionId: 'sandbox-session-1',
      completedAt: expect.any(Number),
      error: 'boom',
      status: 'error',
    });
    expect(deps.eventBus.emitAsync).toHaveBeenCalledWith(
      'turn.completed',
      expect.objectContaining({
        turnId: 'turn-1',
        sandboxSessionId: 'sandbox-session-1',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        status: 'error',
        error: 'boom',
      }),
    );
    expect(deps.eventBus.emit).not.toHaveBeenCalled();
  });

  it('recovers an already-finalized unpublished terminal from its durable row', async () => {
    const deps = createDeps({
      finalizeResult: false,
      turn: {
        ...BASE_TURN,
        status: 'cancelled',
        error: TURN_CANCELLED_MESSAGE,
        inputTokens: 3,
        outputTokens: 4,
        totalTokens: 7,
        costUsd: 0.01,
      },
    });
    const finalizer = new TurnFinalizer(deps);

    const result = await finalizer.finalize({
      ...BASE_PARAMS,
      status: 'completed',
      error: undefined,
    });

    expect(result).toEqual({ finalized: false, published: true });
    expect(deps.eventBus.emitAsync).toHaveBeenCalledWith('turn.completed', {
      turnId: 'turn-1',
      sandboxSessionId: 'sandbox-session-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      status: 'cancelled',
      error: TURN_CANCELLED_MESSAGE,
      durationMs: 50,
      usage: {
        inputTokens: 3,
        outputTokens: 4,
        totalTokens: 7,
        modelCalls: {
          observed: 0,
          costKnown: 0,
          expected: null,
        },
        cost: {
          totalUsd: 0.01,
          knownUsd: 0.01,
          coverage: 'complete',
        },
      },
      timestamp: 150,
    });
  });

  it('does not publish or settle again when the terminal watermark already exists', async () => {
    const deps = createDeps({
      finalizeResult: false,
      turn: { ...BASE_TURN, terminalPublishedSeq: 123 },
    });
    const settleSessionLifecycle = vi.fn();
    const finalizer = new TurnFinalizer(deps);

    const result = await finalizer.finalize({ ...BASE_PARAMS, settleSessionLifecycle });

    expect(result).toEqual({ finalized: false, published: false });
    expect(deps.eventBus.emitAsync).not.toHaveBeenCalled();
    expect(settleSessionLifecycle).not.toHaveBeenCalled();
  });

  it('does not repair or publish after a fenced finalizer loses ownership', async () => {
    const deps = createDeps({ finalizeResult: false });
    const settleSessionLifecycle = vi.fn();
    const finalizer = new TurnFinalizer(deps);

    const result = await finalizer.finalize({
      ...BASE_PARAMS,
      expectedDeliveryFence: {
        ownerId: 'stale-owner',
        fenceToken: 1,
      },
      settleSessionLifecycle,
    });

    expect(result).toEqual({ finalized: false, published: false });
    expect(deps.db.finalizeTurnIfOpen).toHaveBeenCalledWith(
      'turn-1',
      expect.objectContaining({ status: 'error' }),
      expect.objectContaining({
        ownerId: 'stale-owner',
        fenceToken: 1,
      }),
    );
    expect(deps.db.getTurn).not.toHaveBeenCalled();
    expect(deps.eventBus.emitAsync).not.toHaveBeenCalled();
    expect(settleSessionLifecycle).not.toHaveBeenCalled();
  });

  it('settles session lifecycle even when durable terminal publication fails', async () => {
    const deps = createDeps();
    deps.eventBus.emitAsync.mockRejectedValueOnce(new Error('event store unavailable'));
    const settleSessionLifecycle = vi.fn();
    const finalizer = new TurnFinalizer(deps);

    await expect(finalizer.finalize({
      ...BASE_PARAMS,
      settleSessionLifecycle,
    })).rejects.toThrow('event store unavailable');

    expect(settleSessionLifecycle).toHaveBeenCalledOnce();
    expect(deps.eventBus.emit).not.toHaveBeenCalled();
  });

  it('emits a webhook-safe status vocabulary via deriveTurnStatus', () => {
    expect(deriveTurnStatus({ cancelled: true })).toBe('cancelled');
    expect(deriveTurnStatus({ error: TURN_CANCELLED_MESSAGE })).toBe('cancelled');
    expect(deriveTurnStatus({ error: 'boom' })).toBe('error');
    expect(deriveTurnStatus({})).toBe('completed');
  });
});
