import { create } from '@bufbuild/protobuf';
import {
  MessageCommittedSchema,
  SessionEventSchema,
} from '@ctxmill/proto/sandbox/v1';
import { describe, expect, it, vi } from 'vitest';

import type { Message } from '@ctxmill/sandbox-daemon';
import { TURN_CANCELLED_MESSAGE } from '../../turn-cancellation.js';
import { ConcurrencyLimitError } from '../concurrency-limit-error.js';
import { AsyncChannel, type SessionRecord } from '../types.js';
import { SessionStateStore } from '../session-state-store.js';
import { SessionTurnOrchestrator } from '../session-turn-orchestrator.js';
import type { SessionTurnOrchestratorDeps } from '../session-turn-orchestrator.js';
import type { SessionStatusCoordinator } from '../session-status-coordinator.js';

function createSessionRecord(overrides?: Partial<SessionRecord>): SessionRecord {
  return {
    sessionId: overrides?.sessionId ?? 'sess-1',
    conversationId: overrides?.conversationId ?? 'conv-1',
    agentId: overrides?.agentId ?? 'agent-1',
    containerName: overrides?.containerName ?? 'container-1',
    containerId: overrides?.containerId ?? 'container-1',
    status: overrides?.status ?? 'ACTIVE',
    harnessName: overrides?.harnessName ?? 'langgraph',
    grpcClient: overrides?.grpcClient,
  };
}

function createDeps(stateStore: SessionStateStore): SessionTurnOrchestratorDeps {
  return {
    stateStore,
    statusCoordinator: {
      transition: vi.fn(async () => undefined),
    } as unknown as SessionStatusCoordinator,
    lifecyclePolicy: {
      cancelIdleTimeout: vi.fn(async () => undefined),
      scheduleIdleTimeout: vi.fn(),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    config: {
      maxQueuedMessages: 10,
      turnTimeoutMs: 1_000,
    },
    onCheckpoint: vi.fn(async () => undefined),
    onStaleContainer: vi.fn(async () => createSessionRecord()),
    executeDeliverTurn: vi.fn(async function* () {}),
  };
}

function createMessage(content: string): Message {
  return {
    id: `msg-${content}`,
    role: 'user',
    content,
    agentId: 'agent-1',
    createdAt: new Date(),
  };
}

function createIteratorDeferred() {
  let resolve!: (value: IteratorResult<never>) => void;
  const promise = new Promise<IteratorResult<never>>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('SessionTurnOrchestrator turn-owned cancellation', () => {
  it('cancels only the requested turn controller', () => {
    const stateStore = new SessionStateStore();
    const record = createSessionRecord();
    stateStore.setSession(record.conversationId, record);
    const orchestrator = new SessionTurnOrchestrator(createDeps(stateStore));

    const firstSignal = orchestrator.startTurn(record.sessionId, 'turn-a', record.agentId, record.conversationId, 'interactive');
    const secondSignal = orchestrator.startTurn(record.sessionId, 'turn-b', record.agentId, record.conversationId, 'interactive');
    stateStore.markTurnActive(record.sessionId, 'turn-a');

    expect(firstSignal.aborted).toBe(false);
    expect(secondSignal.aborted).toBe(false);
    expect(orchestrator.cancelCurrentTurn(record.sessionId, 'turn-a')).toBe(true);
    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(false);
  });

  it('removes a queued turn without aborting the active turn', async () => {
    const stateStore = new SessionStateStore();
    const record = createSessionRecord();
    stateStore.setSession(record.conversationId, record);
    stateStore.markTurnActive(record.sessionId, 'turn-a');
    const orchestrator = new SessionTurnOrchestrator(createDeps(stateStore));

    const activeSignal = orchestrator.startTurn(record.sessionId, 'turn-a', record.agentId, record.conversationId, 'interactive');
    const queuedSignal = orchestrator.startTurn(record.sessionId, 'turn-b', record.agentId, record.conversationId, 'interactive');
    const channel = new AsyncChannel();
    stateStore.getOrCreateQueue(record.sessionId).push({
      turnId: 'turn-b',
      messages: [createMessage('queued')],
      channel,
    });

    expect(orchestrator.cancelCurrentTurn(record.sessionId, 'turn-b')).toBe(true);
    expect(activeSignal.aborted).toBe(false);
    expect(queuedSignal.aborted).toBe(false);
    expect(stateStore.getQueue(record.sessionId)).toEqual([]);
    expect(stateStore.getTurnAbortSignal(record.sessionId, 'turn-b')).toBeUndefined();
    await expect(channel.generator().next()).rejects.toThrow(TURN_CANCELLED_MESSAGE);
  });

  it('notifies when a turn becomes active at delivery time', async () => {
    const stateStore = new SessionStateStore();
    const record = createSessionRecord();
    stateStore.setSession(record.conversationId, record);
    const deps = createDeps(stateStore);
    deps.executeDeliverTurn = vi.fn(async function* () {});
    deps.onTurnActive = vi.fn(async () => undefined);
    const orchestrator = new SessionTurnOrchestrator(deps);

    for await (const event of orchestrator.deliverTurn(record.sessionId, [createMessage('direct')], 'turn-a')) {
      expect(event).toBeDefined();
    }

    expect(deps.onTurnActive).toHaveBeenCalledWith('turn-a');
  });

  it('cancels an active sandbox stream when its external ownership signal aborts', async () => {
    const next = createIteratorDeferred();
    const iterator = {
      next: vi.fn(() => next.promise),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    };
    const stateStore = new SessionStateStore();
    const record = createSessionRecord({
      grpcClient: {
        deliverTurn: vi.fn(() => ({
          [Symbol.asyncIterator]: () => iterator,
        })),
      } as never,
    });
    stateStore.setSession(record.conversationId, record);
    const deps = createDeps(stateStore);
    const orchestrator = new SessionTurnOrchestrator(deps);
    const controller = new AbortController();

    const eventsPromise = (async () => {
      const events = [];
      for await (const event of orchestrator.executeDeliverTurn(
        record.sessionId,
        [createMessage('continue')],
        'turn-resume',
        false,
        undefined,
        controller.signal,
      )) {
        events.push(event);
      }
      return events;
    })();
    await vi.waitFor(() => {
      expect(iterator.next).toHaveBeenCalledOnce();
    });

    controller.abort(new Error('lease lost'));
    next.resolve({ done: true, value: undefined as never });
    const events = await eventsPromise;

    expect(events).toEqual([]);
    expect(record.grpcClient?.deliverTurn).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'turn-resume' }),
      { signal: controller.signal },
    );
    expect(iterator.return).toHaveBeenCalledOnce();
  });

  it('removes a queued delivery immediately when its external ownership signal aborts', async () => {
    const stateStore = new SessionStateStore();
    const record = createSessionRecord();
    stateStore.setSession(record.conversationId, record);
    stateStore.markTurnActive(record.sessionId, 'turn-active');
    const deps = createDeps(stateStore);
    const orchestrator = new SessionTurnOrchestrator(deps);
    const controller = new AbortController();

    const delivery = (async () => {
      for await (const event of orchestrator.deliverTurn(
        record.sessionId,
        [createMessage('queued')],
        'turn-resume',
        controller.signal,
      )) {
        // A fenced queued turn must not emit or reach the sandbox.
        expect(event).toBeUndefined();
      }
    })();

    await vi.waitFor(() => {
      expect(stateStore.getQueue(record.sessionId)).toHaveLength(1);
    });
    controller.abort(new Error('lease lost while queued'));

    try {
      await vi.waitFor(() => {
        expect(stateStore.getQueue(record.sessionId)).toHaveLength(0);
      });
      await expect(delivery).rejects.toThrow('lease lost while queued');
      expect(deps.executeDeliverTurn).not.toHaveBeenCalled();
    } finally {
      const queued = stateStore.getQueue(record.sessionId)?.shift();
      queued?.channel.fail(new Error('test cleanup'));
      await delivery.catch(() => undefined);
    }
  });
});

describe('SessionTurnOrchestrator concurrency limit', () => {
  function fillActiveSessions(stateStore: SessionStateStore, agentId: string, count: number): void {
    for (let i = 0; i < count; i++) {
      const record = createSessionRecord({
        sessionId: `sess-${agentId}-${i}`,
        conversationId: `conv-${agentId}-${i}`,
        agentId,
        status: 'ACTIVE',
      });
      stateStore.setSession(record.conversationId, record);
    }
  }

  it('throws ConcurrencyLimitError carrying agentId, max, and retryAfterSec when at limit', () => {
    const stateStore = new SessionStateStore();
    fillActiveSessions(stateStore, 'agent-1', 2);
    const deps = createDeps(stateStore);
    deps.config.maxConcurrentSessionsPerAgent = 2;
    const orchestrator = new SessionTurnOrchestrator(deps);

    let caught: unknown;
    try {
      orchestrator.checkConcurrencyLimit('agent-1');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConcurrencyLimitError);
    const err = caught as ConcurrencyLimitError;
    expect(err.statusCode).toBe(429);
    expect(err.agentId).toBe('agent-1');
    expect(err.maxConcurrent).toBe(2);
    expect(err.retryAfterSec).toBeGreaterThan(0);
  });

  it('does not count sessions belonging to other agents toward the limit', () => {
    const stateStore = new SessionStateStore();
    fillActiveSessions(stateStore, 'agent-other', 5);
    const deps = createDeps(stateStore);
    deps.config.maxConcurrentSessionsPerAgent = 2;
    const orchestrator = new SessionTurnOrchestrator(deps);

    expect(() => orchestrator.checkConcurrencyLimit('agent-1')).not.toThrow();
  });

  it('only counts sessions whose status is ACTIVE', () => {
    const stateStore = new SessionStateStore();
    fillActiveSessions(stateStore, 'agent-1', 1);
    const checkpointed = createSessionRecord({
      sessionId: 'sess-cp',
      conversationId: 'conv-cp',
      agentId: 'agent-1',
      status: 'CHECKPOINTED',
    });
    stateStore.setSession(checkpointed.conversationId, checkpointed);
    const deps = createDeps(stateStore);
    deps.config.maxConcurrentSessionsPerAgent = 2;
    const orchestrator = new SessionTurnOrchestrator(deps);

    expect(() => orchestrator.checkConcurrencyLimit('agent-1')).not.toThrow();
  });

  it('counts startup reservations before sessions become ACTIVE', () => {
    const stateStore = new SessionStateStore();
    const deps = createDeps(stateStore);
    deps.config.maxConcurrentSessionsPerAgent = 1;
    const orchestrator = new SessionTurnOrchestrator(deps);

    const reservation = orchestrator.reserveConcurrencySlot('agent-1');

    expect(() => orchestrator.checkConcurrencyLimit('agent-1')).toThrow(ConcurrencyLimitError);

    reservation.release();
    expect(() => orchestrator.checkConcurrencyLimit('agent-1')).not.toThrow();
  });

  it('excludes the caller reservation during its own sandbox bootstrap check', () => {
    const stateStore = new SessionStateStore();
    const deps = createDeps(stateStore);
    deps.config.maxConcurrentSessionsPerAgent = 1;
    const orchestrator = new SessionTurnOrchestrator(deps);

    const reservation = orchestrator.reserveConcurrencySlot('agent-1');

    expect(() =>
      orchestrator.checkConcurrencyLimit('agent-1', {
        excludeReservationId: reservation.id,
      })).not.toThrow();
  });
});

describe('SessionTurnOrchestrator terminal-frame discipline', () => {
  it('settles in-memory lifecycle without emitting a second terminal event', () => {
    const stateStore = new SessionStateStore();
    const record = createSessionRecord();
    stateStore.setSession(record.conversationId, record);
    stateStore.markTurnActive(record.sessionId, 'turn-1');
    const controller = new AbortController();
    stateStore.registerTurnController(record.sessionId, 'turn-1', controller);
    const deps = createDeps(stateStore);
    deps.eventBus = { emit: vi.fn() } as never;
    const orchestrator = new SessionTurnOrchestrator(deps);

    orchestrator.completeTurn(
      record.sessionId,
      'turn-1',
      record.agentId,
      record.conversationId,
      'completed',
      10,
    );

    expect(stateStore.getActiveTurnId(record.sessionId)).toBeUndefined();
    expect(stateStore.getTurnAbortSignal(record.sessionId, 'turn-1')).toBeUndefined();
    expect(deps.eventBus.emit).not.toHaveBeenCalled();
  });

  it('fails the turn when a sandbox stream ends without a raw terminal frame after events', async () => {
    const stateStore = new SessionStateStore();
    const record = createSessionRecord({
      grpcClient: {
        deliverTurn: vi.fn(async function* () {
          yield create(SessionEventSchema, {
            payload: {
              case: 'messageCommitted',
              value: create(MessageCommittedSchema, {
                role: 'assistant',
                content: 'partial',
                turnId: 'turn-1',
                messageSeq: 0,
              }),
            },
          });
        }),
      } as never,
    });
    stateStore.setSession(record.conversationId, record);
    const deps = createDeps(stateStore);
    const orchestrator = new SessionTurnOrchestrator(deps);

    const events = [];
    for await (const event of orchestrator.executeDeliverTurn(record.sessionId, [createMessage('go')], 'turn-1')) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({ type: 'message_committed', content: 'partial' }),
      expect.objectContaining({
        type: 'turn_failed',
        turnId: 'turn-1',
        errorMessage: expect.stringContaining('ended without a terminal frame'),
      }),
    ]);
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('ended without a terminal frame'));
  });
});
