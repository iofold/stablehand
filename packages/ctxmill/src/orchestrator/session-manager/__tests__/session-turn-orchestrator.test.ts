import { describe, expect, it, vi } from 'vitest';

import type { Message } from '../../../types.js';
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
    await expect(channel.generator().next()).rejects.toThrow('Turn turn-b cancelled for session sess-1');
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
