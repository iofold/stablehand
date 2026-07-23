import { create } from '@bufbuild/protobuf';
import {
  MessageCommittedSchema,
  SessionEventSchema,
  TurnCompletedSchema,
  TurnDeliveryCapabilitySchema,
} from '@ctxmill/proto/sandbox/v1';
import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, it, vi } from 'vitest';

import type { Message } from '@ctxmill/sandbox-daemon';
import { TURN_CANCELLED_MESSAGE } from '../../turn-cancellation.js';
import { ConcurrencyLimitError } from '../concurrency-limit-error.js';
import { AsyncChannel, type SessionRecord } from '../types.js';
import { SessionStateStore } from '../session-state-store.js';
import { SessionTurnOrchestrator } from '../session-turn-orchestrator.js';
import type { SessionTurnOrchestratorDeps } from '../session-turn-orchestrator.js';
import type { SessionStatusCoordinator } from '../session-status-coordinator.js';
import type { SandboxSessionLifecycleOperationGuard } from '../../sandbox-session-lifecycle-operation.js';

function createSessionRecord(overrides?: Partial<SessionRecord>): SessionRecord {
  return {
    sessionId: overrides?.sessionId ?? 'sess-1',
    conversationId: overrides?.conversationId ?? 'conv-1',
    agentId: overrides?.agentId ?? 'agent-1',
    containerName: overrides?.containerName ?? 'container-1',
    containerId: overrides?.containerId ?? 'container-1',
    restoreFenceToken: overrides?.restoreFenceToken ?? 0,
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
    reserveSessionReset: vi.fn(async () => undefined),
    executeReservedSessionReset: vi.fn(async () => undefined),
    resetSession: vi.fn(async () => undefined),
    issueTurnDeliveryCapability: vi.fn(async (input) => create(
      TurnDeliveryCapabilitySchema,
      {
        ownerId: input.expectedDeliveryFence.ownerId,
        fenceToken: BigInt(input.expectedDeliveryFence.fenceToken),
        leaseExpiresAtMs: BigInt(Date.now() + 60_000),
        restoreFenceToken: BigInt(
          input.expectedActiveGeneration.restoreFenceToken,
        ),
        ...(input.expectedActiveGeneration.containerId === null
          ? {}
          : { containerId: input.expectedActiveGeneration.containerId }),
        agentId: input.agentId,
        signature: 'test-capability',
      },
    )),
    executeDeliverTurn: vi.fn(async function* () {}),
  };
}

function createResetGuard(): SandboxSessionLifecycleOperationGuard {
  return {
    operation: 'reset',
    operationId: 'reset-operation-1',
    phase: 'reserved',
    fence: {
      ownerId: 'reset-owner-1',
      fenceToken: 1,
    },
    signal: new AbortController().signal,
    markExecuting: vi.fn(async () => true),
    cancel: vi.fn(async () => true),
    stop: vi.fn(async () => undefined),
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

    expect(deps.onTurnActive).toHaveBeenCalledWith({
      turnId: 'turn-a',
      sessionId: record.sessionId,
      expectedActiveGeneration: {
        restoreFenceToken: record.restoreFenceToken,
        containerId: record.containerId,
      },
    });
  });

  it('rechecks external ownership after waiting for the conversation lock', async () => {
    const stateStore = new SessionStateStore();
    const record = createSessionRecord();
    stateStore.setSession(record.conversationId, record);
    const deps = createDeps(stateStore);
    deps.onTurnActive = vi.fn(async () => true);
    const orchestrator = new SessionTurnOrchestrator(deps);
    const controller = new AbortController();
    let releaseLock!: () => void;
    const lockHeld = stateStore.withConversationLock(record.conversationId, async () => {
      await new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
    });
    await vi.waitFor(() => {
      expect(releaseLock).toBeTypeOf('function');
    });

    const delivery = orchestrator.deliverTurn(
      record.sessionId,
      [createMessage('blocked')],
      'turn-blocked',
      { signal: controller.signal },
    ).next();
    controller.abort(new Error('lease lost while waiting for conversation lock'));
    releaseLock();
    await lockHeld;

    await expect(delivery).rejects.toThrow('lease lost while waiting for conversation lock');
    expect(deps.onTurnActive).not.toHaveBeenCalled();
    expect(deps.executeDeliverTurn).not.toHaveBeenCalled();
    expect(stateStore.getActiveTurnId(record.sessionId)).toBeUndefined();
  });

  it('publishes recovery startup events only after fenced durable activation', async () => {
    const stateStore = new SessionStateStore();
    const record = createSessionRecord();
    stateStore.setSession(record.conversationId, record);
    const deps = createDeps(stateStore);
    const order: string[] = [];
    deps.eventBus = {
      emit: vi.fn(),
      emitAsync: vi.fn(async (event: string) => {
        order.push(event);
      }),
    } as never;
    deps.onTurnActive = vi.fn(async () => {
      order.push('activate');
      return true;
    });
    deps.verifyTurnDeliveryFence = vi.fn(async () => {
      order.push('verify');
      return true;
    });
    const orchestrator = new SessionTurnOrchestrator(deps);

    orchestrator.startTurn(
      record.sessionId,
      'turn-recovery',
      record.agentId,
      record.conversationId,
      'interactive',
      'recover',
      {
        deliveryContext: {
          fence: { ownerId: 'owner-a', fenceToken: 1 },
          userMessage: {
            turnId: 'turn-recovery',
            agentId: record.agentId,
            conversationId: record.conversationId,
            messageId: 'message-recovery',
            content: 'recover',
            timestamp: 100,
          },
        },
      },
    );
    expect(deps.eventBus.emit).not.toHaveBeenCalled();

    await orchestrator.deliverTurn(
      record.sessionId,
      [createMessage('recover')],
      'turn-recovery',
    ).next();

    expect(order[0]).toBe('activate');
    expect(order).toContain('user.message');
    expect(order).toContain('turn.started');
    expect(order.indexOf('user.message')).toBeLessThan(order.indexOf('turn.started'));
    expect(deps.onTurnActive).toHaveBeenCalledWith({
      turnId: 'turn-recovery',
      sessionId: record.sessionId,
      expectedActiveGeneration: {
        restoreFenceToken: record.restoreFenceToken,
        containerId: record.containerId,
      },
      deliveryFence: { ownerId: 'owner-a', fenceToken: 1 },
    });
    expect(stateStore.getActiveTurnId(record.sessionId)).toBe('turn-recovery');
  });

  it('delivers a continuation under its existing fence without reactivating or restarting the original turn', async () => {
    const stateStore = new SessionStateStore();
    const record = createSessionRecord();
    stateStore.setSession(record.conversationId, record);
    const deps = createDeps(stateStore);
    deps.eventBus = {
      emit: vi.fn(),
      emitAsync: vi.fn(),
    } as never;
    deps.onTurnActive = vi.fn(async () => {
      throw new Error('continuation must not reactivate the original turn');
    });
    deps.verifyTurnDeliveryFence = vi.fn(async () => true);
    deps.verifyActiveGeneration = vi.fn(async () => true);
    const orchestrator = new SessionTurnOrchestrator(deps);

    orchestrator.startTurn(
      record.sessionId,
      'turn-original',
      record.agentId,
      record.conversationId,
      'interactive',
      'continue',
      {
        deliveryAdmission: 'continuation',
        deliveryContext: {
          fence: { ownerId: 'resume-worker', fenceToken: 7 },
        },
      },
    );

    await orchestrator.deliverTurn(
      record.sessionId,
      [createMessage('approval result')],
      'turn-original',
    ).next();

    expect(deps.onTurnActive).not.toHaveBeenCalled();
    expect(deps.verifyTurnDeliveryFence).toHaveBeenCalledWith(
      'turn-original',
      { ownerId: 'resume-worker', fenceToken: 7 },
    );
    expect(deps.verifyActiveGeneration).toHaveBeenCalledWith(
      record.sessionId,
      {
        restoreFenceToken: record.restoreFenceToken,
        containerId: record.containerId,
      },
    );
    expect(deps.eventBus.emitAsync).not.toHaveBeenCalledWith(
      'turn.started',
      expect.anything(),
      expect.anything(),
    );
    expect(stateStore.getActiveTurnId(record.sessionId)).toBe('turn-original');
  });

  it('dispatches the exact capability issued for the delivery fence and runtime generation', async () => {
    const capability = create(TurnDeliveryCapabilitySchema, {
      ownerId: 'delivery-owner',
      fenceToken: 4n,
      leaseExpiresAtMs: BigInt(Date.now() + 60_000),
      restoreFenceToken: 9n,
      containerId: 'container-generation-9',
      agentId: 'agent-1',
      signature: 'signed-capability',
    });
    const deliverTurn = vi.fn(async function* () {
      yield create(SessionEventSchema, {
        payload: {
          case: 'turnCompleted',
          value: create(TurnCompletedSchema, { turnId: 'turn-capability' }),
        },
      });
    });
    const stateStore = new SessionStateStore();
    const record = createSessionRecord({
      restoreFenceToken: 9,
      containerId: 'container-generation-9',
      grpcClient: { deliverTurn } as never,
    });
    stateStore.setSession(record.conversationId, record);
    const deps = createDeps(stateStore);
    deps.verifyTurnDeliveryFence = vi.fn(async () => true);
    deps.issueTurnDeliveryCapability = vi.fn(async () => capability);
    const orchestrator = new SessionTurnOrchestrator(deps);
    orchestrator.startTurn(
      record.sessionId,
      'turn-capability',
      record.agentId,
      record.conversationId,
      'interactive',
      undefined,
      {
        deliveryContext: {
          fence: { ownerId: 'delivery-owner', fenceToken: 4 },
        },
      },
    );

    for await (const _event of orchestrator.executeDeliverTurn(
      record.sessionId,
      [createMessage('capability')],
      'turn-capability',
    )) {
      // Drain the terminal frame.
      void _event;
    }

    expect(deps.issueTurnDeliveryCapability).toHaveBeenCalledWith({
      turnId: 'turn-capability',
      sandboxSessionId: record.sessionId,
      agentId: record.agentId,
      expectedActiveGeneration: {
        restoreFenceToken: 9,
        containerId: 'container-generation-9',
      },
      expectedDeliveryFence: {
        ownerId: 'delivery-owner',
        fenceToken: 4,
      },
    });
    expect(deliverTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: record.sessionId,
        turnId: 'turn-capability',
        deliveryCapability: capability,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('dispatches exact turn secrets on the gRPC request and preserves them across an empty-stream retry', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const deliverTurn = vi.fn((request: Record<string, unknown>) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          async *[Symbol.asyncIterator]() {
            yield* [];
            throw new ConnectError('retry delivery', Code.Aborted);
          },
        };
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield create(SessionEventSchema, {
            payload: {
              case: 'messageCommitted',
              value: create(MessageCommittedSchema, {
                role: 'assistant',
                content: 'retried safely',
                turnId: 'turn-secrets-retry',
                messageSeq: 1n,
              }),
            },
          });
          yield create(SessionEventSchema, {
            payload: {
              case: 'turnCompleted',
              value: create(TurnCompletedSchema, { turnId: 'turn-secrets-retry' }),
            },
          });
        },
      };
    });
    const stateStore = new SessionStateStore();
    const record = createSessionRecord({
      grpcClient: { deliverTurn } as never,
    });
    stateStore.setSession(record.conversationId, record);
    const deps = createDeps(stateStore);
    const orchestrator = new SessionTurnOrchestrator(deps);

    const events = [];
    for await (const event of orchestrator.executeDeliverTurn(
      record.sessionId,
      [createMessage('retry with exact secrets')],
      'turn-secrets-retry',
      {
        turnSecrets: {
          PILOT_TURN_OWNERSHIP_TOKEN: 'ownership-retry',
        },
      },
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: 'message_committed',
        turnId: 'turn-secrets-retry',
      }),
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      turnSecrets: {
        PILOT_TURN_OWNERSHIP_TOKEN: 'ownership-retry',
      },
    });
    expect(requests[1]).toMatchObject({
      turnSecrets: {
        PILOT_TURN_OWNERSHIP_TOKEN: 'ownership-retry',
      },
    });
  });

  it('retains an immutable copy of turn secrets while a delivery is queued', async () => {
    const stateStore = new SessionStateStore();
    const record = createSessionRecord();
    stateStore.setSession(record.conversationId, record);
    stateStore.markTurnActive(record.sessionId, 'turn-active');
    const deps = createDeps(stateStore);
    const orchestrator = new SessionTurnOrchestrator(deps);
    const turnSecrets = {
      PILOT_TURN_OWNERSHIP_TOKEN: 'ownership-queued',
    };
    const queuedMessage = createMessage('queued with secrets');

    const delivery = (async () => {
      for await (const event of orchestrator.deliverTurn(
        record.sessionId,
        [queuedMessage],
        'turn-queued-secrets',
        { turnSecrets },
      )) {
        void event;
      }
    })();

    await vi.waitFor(() => {
      expect(stateStore.getQueue(record.sessionId)).toHaveLength(1);
    });
    turnSecrets.PILOT_TURN_OWNERSHIP_TOKEN = 'mutated-after-enqueue';
    stateStore.markTurnInactive(record.sessionId, 'turn-active');
    await orchestrator.drainCoalescedQueue(record.sessionId);
    await delivery;

    expect(deps.executeDeliverTurn).toHaveBeenCalledWith(
      record.sessionId,
      [queuedMessage],
      'turn-queued-secrets',
      {
        turnSecrets: {
          PILOT_TURN_OWNERSHIP_TOKEN: 'ownership-queued',
        },
      },
    );
  });

  it('fails closed before gRPC when the exact capability tuple is no longer admitted', async () => {
    const deliverTurn = vi.fn();
    const stateStore = new SessionStateStore();
    const record = createSessionRecord({
      grpcClient: { deliverTurn } as never,
    });
    stateStore.setSession(record.conversationId, record);
    const deps = createDeps(stateStore);
    deps.verifyTurnDeliveryFence = vi.fn(async () => true);
    deps.issueTurnDeliveryCapability = vi.fn(async () => undefined);
    const orchestrator = new SessionTurnOrchestrator(deps);
    orchestrator.startTurn(
      record.sessionId,
      'turn-capability-lost',
      record.agentId,
      record.conversationId,
      'interactive',
      undefined,
      {
        deliveryContext: {
          fence: { ownerId: 'delivery-owner', fenceToken: 4 },
        },
      },
    );

    await expect(orchestrator.executeDeliverTurn(
      record.sessionId,
      [createMessage('must-not-dispatch')],
      'turn-capability-lost',
    ).next()).rejects.toThrow('lost delivery capability admission');
    expect(deliverTurn).not.toHaveBeenCalled();
  });

  it('refreshes a healthy long-running delivery with a newly issued capability', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      const initialCapability = create(TurnDeliveryCapabilitySchema, {
        ownerId: 'delivery-owner',
        fenceToken: 4n,
        leaseExpiresAtMs: BigInt(Date.now() + 30_000),
        restoreFenceToken: 9n,
        containerId: 'container-generation-9',
        agentId: 'agent-1',
        signature: 'initial-signature',
      });
      const renewedCapability = create(TurnDeliveryCapabilitySchema, {
        ...initialCapability,
        leaseExpiresAtMs: BigInt(Date.now() + 60_000),
        signature: 'renewed-signature',
      });
      const next = createIteratorDeferred();
      const iterator = {
        next: vi.fn(() => next.promise),
        return: vi.fn(async () => ({ done: true as const, value: undefined })),
      };
      const deliverTurn = vi.fn(() => ({
        [Symbol.asyncIterator]: () => iterator,
      }));
      const renewTurnDeliveryCapability = vi.fn().mockResolvedValue({
        renewed: true,
      });
      const stateStore = new SessionStateStore();
      const record = createSessionRecord({
        restoreFenceToken: 9,
        containerId: 'container-generation-9',
        grpcClient: {
          deliverTurn,
          renewTurnDeliveryCapability,
        } as never,
      });
      stateStore.setSession(record.conversationId, record);
      const deps = createDeps(stateStore);
      deps.config.turnTimeoutMs = 120_000;
      deps.verifyTurnDeliveryFence = vi.fn(async () => true);
      deps.issueTurnDeliveryCapability = vi.fn()
        .mockResolvedValueOnce(initialCapability)
        .mockResolvedValueOnce(renewedCapability);
      const orchestrator = new SessionTurnOrchestrator(deps);
      orchestrator.startTurn(
        record.sessionId,
        'turn-renewal',
        record.agentId,
        record.conversationId,
        'interactive',
        undefined,
        {
          deliveryContext: {
            fence: { ownerId: 'delivery-owner', fenceToken: 4 },
          },
        },
      );

      const delivery = (async () => {
        for await (const _event of orchestrator.executeDeliverTurn(
          record.sessionId,
          [createMessage('renew')],
          'turn-renewal',
        )) {
          // Drain until the controlled iterator ends.
          void _event;
        }
      })();
      await vi.advanceTimersByTimeAsync(0);
      expect(iterator.next).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(10_100);
      expect(renewTurnDeliveryCapability).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: record.sessionId,
          turnId: 'turn-renewal',
          deliveryCapability: renewedCapability,
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      next.resolve({ done: true, value: undefined as never });
      await vi.advanceTimersByTimeAsync(0);
      await delivery;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a continuation before delivery when its cached runtime generation is stale', async () => {
    const stateStore = new SessionStateStore();
    const record = createSessionRecord({ restoreFenceToken: 3 });
    stateStore.setSession(record.conversationId, record);
    const deps = createDeps(stateStore);
    deps.verifyTurnDeliveryFence = vi.fn(async () => true);
    deps.verifyActiveGeneration = vi.fn(async () => false);
    const orchestrator = new SessionTurnOrchestrator(deps);

    orchestrator.startTurn(
      record.sessionId,
      'turn-stale-continuation',
      record.agentId,
      record.conversationId,
      'interactive',
      'continue',
      {
        deliveryAdmission: 'continuation',
        deliveryContext: {
          fence: { ownerId: 'resume-worker', fenceToken: 8 },
        },
      },
    );

    await expect(orchestrator.deliverTurn(
      record.sessionId,
      [createMessage('approval result')],
      'turn-stale-continuation',
    ).next()).rejects.toThrow('stale runtime generation');

    expect(deps.executeDeliverTurn).not.toHaveBeenCalled();
    expect(stateStore.getActiveTurnId(record.sessionId)).toBeUndefined();
  });

  it('does not activate or deliver a turn rejected by the durable open-turn CAS', async () => {
    const stateStore = new SessionStateStore();
    const record = createSessionRecord();
    stateStore.setSession(record.conversationId, record);
    const deps = createDeps(stateStore);
    deps.onTurnActive = vi.fn(async () => false);
    const orchestrator = new SessionTurnOrchestrator(deps);

    await expect(orchestrator.deliverTurn(
      record.sessionId,
      [createMessage('cancelled before delivery')],
      'turn-cancelled',
    ).next()).rejects.toThrow('lost durable delivery admission');

    expect(stateStore.getActiveTurnId(record.sessionId)).toBeUndefined();
    expect(deps.executeDeliverTurn).not.toHaveBeenCalled();
  });

  it('reserves a fenced reset and fails closed when the sandbox is stale', async () => {
    const stateStore = new SessionStateStore();
    const staleRecord = createSessionRecord({
      grpcClient: {
        deliverTurn: vi.fn(() => {
          throw new ConnectError('stale sandbox', Code.Unavailable);
        }),
      } as never,
    });
    stateStore.setSession(staleRecord.conversationId, staleRecord);
    const deps = createDeps(stateStore);
    const resetGuard = createResetGuard();
    deps.reserveSessionReset = vi.fn(async () => resetGuard);
    deps.verifyTurnDeliveryFence = vi.fn(async () => true);
    const orchestrator = new SessionTurnOrchestrator(deps);

    orchestrator.startTurn(
      staleRecord.sessionId,
      'turn-stale',
      staleRecord.agentId,
      staleRecord.conversationId,
      'interactive',
      'recover',
      {
        deliveryContext: {
          fence: { ownerId: 'delivery-owner-1', fenceToken: 4 },
        },
      },
    );

    const events = [];
    for await (const event of orchestrator.executeDeliverTurn(
      staleRecord.sessionId,
      [createMessage('recover')],
      'turn-stale',
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: 'turn_failed',
        errorMessage: '[unavailable] stale sandbox',
      }),
    ]);
    expect(staleRecord.grpcClient?.deliverTurn).toHaveBeenCalledOnce();
    expect(deps.statusCoordinator.transition).not.toHaveBeenCalledWith(
      expect.objectContaining({ toStatus: 'TERMINATED' }),
    );
    expect(deps.reserveSessionReset).toHaveBeenCalledWith({
      sessionId: staleRecord.sessionId,
      turnId: 'turn-stale',
      deliveryFence: { ownerId: 'delivery-owner-1', fenceToken: 4 },
    });
    expect(orchestrator.getPendingSessionReset('turn-stale')).toEqual({
      sandboxSessionId: staleRecord.sessionId,
      fence: resetGuard.fence,
    });
    expect(deps.executeReservedSessionReset).not.toHaveBeenCalled();

    await orchestrator.completeTurn(
      staleRecord.sessionId,
      'turn-stale',
      staleRecord.agentId,
      staleRecord.conversationId,
      'error',
      10,
      'stale sandbox',
    );

    expect(deps.executeReservedSessionReset).toHaveBeenCalledWith(
      staleRecord.sessionId,
      resetGuard,
    );
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
        { signal: controller.signal },
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
    expect(deps.statusCoordinator.transition).not.toHaveBeenCalled();
    expect(deps.lifecyclePolicy.scheduleIdleTimeout).not.toHaveBeenCalled();
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
        { signal: controller.signal },
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
  it('routes container-gone cleanup through the fenced reset contract', async () => {
    const stateStore = new SessionStateStore();
    const record = createSessionRecord();
    stateStore.setSession(record.conversationId, record);
    const deps = createDeps(stateStore);
    const orchestrator = new SessionTurnOrchestrator(deps);

    orchestrator.scheduleIdleTimeoutForActiveSession(record.sessionId, record);
    const callbacks = (
      deps.lifecyclePolicy.scheduleIdleTimeout as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[2] as { onContainerGone: (sessionId: string) => Promise<void> };
    await callbacks.onContainerGone(record.sessionId);

    expect(deps.resetSession).toHaveBeenCalledWith(record.sessionId);
    expect(deps.statusCoordinator.transition).not.toHaveBeenCalledWith(
      expect.objectContaining({ toStatus: 'TERMINATED' }),
    );
  });

  it('settles in-memory lifecycle without emitting a second terminal event', async () => {
    const stateStore = new SessionStateStore();
    const record = createSessionRecord();
    stateStore.setSession(record.conversationId, record);
    stateStore.markTurnActive(record.sessionId, 'turn-1');
    const controller = new AbortController();
    stateStore.registerTurnController(record.sessionId, 'turn-1', controller);
    const deps = createDeps(stateStore);
    deps.eventBus = { emit: vi.fn() } as never;
    const orchestrator = new SessionTurnOrchestrator(deps);

    await orchestrator.completeTurn(
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
