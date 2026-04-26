import { describe, expect, it, vi } from 'vitest';

import type { Message } from '../../../types.js';
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
