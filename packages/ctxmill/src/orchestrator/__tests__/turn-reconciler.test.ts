import { describe, expect, it, vi } from 'vitest';

import {
  TOOL_CALL_INTERRUPTED_ERROR,
  TURN_ERROR_ORCHESTRATOR_RESTART,
  TurnFinalizer,
} from '../turn-finalizer.js';
import { reconcileStrandedTurnsOnStartup, repairRunningEntries } from '../turn-reconciler.js';

const BOOT_TIME = 1_000_000;

function createTurn(overrides: Record<string, unknown> = {}) {
  return {
    id: 'turn-1',
    sandboxSessionId: 'sess-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    mode: 'interactive',
    taskDescription: null,
    status: 'running',
    userMessageId: null,
    startedAt: BOOT_TIME - 60_000,
    completedAt: null,
    error: null,
    deliveryOwnerId: null,
    deliveryFenceToken: null,
    ...overrides,
  };
}

function createDeps(options: {
  openTurns?: ReturnType<typeof createTurn>[];
  interrupt?: Record<string, unknown> | undefined;
  messages?: Array<Record<string, unknown>>;
} = {}) {
  const eventBus = { emit: vi.fn(), emitAsync: vi.fn().mockResolvedValue(undefined) };
  const db = {
    getOpenTurnsStartedBefore: vi.fn().mockResolvedValue(options.openTurns ?? []),
    getPendingInterruptForTurn: vi.fn().mockResolvedValue(options.interrupt),
    getMessages: vi.fn().mockResolvedValue(options.messages ?? []),
    getTurnFrames: vi.fn().mockResolvedValue([]),
    getSandboxSession: vi.fn().mockResolvedValue({
      id: 'sess-1',
      conversationId: 'conv-1',
      agentId: 'agent-1',
      containerName: 'ctxmill-sandbox-sess-1',
      containerId: 'container-1',
      status: 'ACTIVE',
      harnessName: 'langgraph',
      checkpointRef: null,
      createdAt: 1,
      updatedAt: 1,
      lastActivityAt: 1,
      restoreAttempts: 0,
      lastRestoreError: null,
      restoreOwnerId: null,
      restoreFenceToken: 0,
      restoreLeaseExpiresAt: null,
    }),
    claimTurnDeliveryLease: vi.fn().mockImplementation(async (input: {
      turnId: string;
      ownerId: string;
      leaseDurationMs: number;
    }) => ({
      turnId: input.turnId,
      ownerId: input.ownerId,
      fenceToken: 1,
      leaseExpiresAt: Date.now() + input.leaseDurationMs,
      updatedAt: Date.now(),
    })),
    renewTurnDeliveryLease: vi.fn(),
    releaseTurnDeliveryLease: vi.fn().mockResolvedValue(true),
    isTurnDeliveryFenceCurrent: vi.fn().mockResolvedValue(true),
    wasTurnFinalizedByDeliveryFence: vi.fn().mockResolvedValue(false),
    claimSandboxSessionLifecycleOperation: vi.fn().mockImplementation(async (
      input: {
        sandboxSessionId: string;
        operation: 'reset';
        ownerId: string;
        leaseDurationMs: number;
        allowedTurnDelivery?: {
          turnId: string;
          ownerId: string;
          fenceToken: number;
        };
      },
    ) => ({
      sandboxSessionId: input.sandboxSessionId,
      operation: input.operation,
      operationId: 'logical-reset-1',
      phase: 'reserved' as const,
      ownerId: input.ownerId,
      fenceToken: 1,
      allowedTurnId: input.allowedTurnDelivery?.turnId ?? null,
      allowedDeliveryOwnerId: input.allowedTurnDelivery?.ownerId ?? null,
      allowedDeliveryFenceToken:
        input.allowedTurnDelivery?.fenceToken ?? null,
      leaseExpiresAt: Date.now() + input.leaseDurationMs,
      updatedAt: Date.now(),
    })),
    renewSandboxSessionLifecycleOperation: vi.fn(),
    markSandboxSessionLifecycleOperationExecuting: vi.fn().mockResolvedValue(true),
    cancelSandboxSessionLifecycleOperation: vi.fn().mockResolvedValue(true),
    stageAssistantMessageUpdate: vi.fn().mockImplementation(async (
      id: string,
      toolCalls: unknown[],
      parts: unknown[],
    ) => ({
      id,
      agentId: 'agent-1',
      conversationId: 'conv-1',
      turnId: 'turn-1',
      messageSeq: 0,
      messageRevision: 1,
      publishedRevision: 0,
      role: 'assistant',
      content: 'working on it',
      toolCalls,
      parts,
      toolCallId: null,
      createdAt: 1,
    })),
    finalizeTurnIfOpen: vi.fn().mockResolvedValue(true),
    finalizeTurnAndMarkLifecycleDraining: vi.fn().mockResolvedValue(true),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const finalizer = new TurnFinalizer({ db, eventBus, logger });
  return { db, eventBus, logger, finalizer };
}

describe('startup turn reconciliation (ADR-014, ctx-nm3o)', () => {
  it('directly repairs parts-only running entries without touching completed entries', () => {
    const entries = [
      { type: 'tool_call', id: 'tc-running', name: 'bash', status: 'running' },
      { type: 'tool_call', id: 'tc-complete', name: 'read', status: 'complete', result: 'ok' },
    ];

    expect(repairRunningEntries(entries, true)).toEqual([
      {
        type: 'tool_call',
        id: 'tc-running',
        name: 'bash',
        status: 'error',
        error: TOOL_CALL_INTERRUPTED_ERROR,
      },
      { type: 'tool_call', id: 'tc-complete', name: 'read', status: 'complete', result: 'ok' },
    ]);
  });

  it('fails open turns started before boot with restart error copy', async () => {
    const deps = createDeps({ openTurns: [createTurn()] });

    const result = await reconcileStrandedTurnsOnStartup(deps, BOOT_TIME);

    expect(result).toEqual(expect.objectContaining({ failed: 1, skippedHitlParked: 0, redispatched: 0 }));
    expect(deps.db.getOpenTurnsStartedBefore).toHaveBeenCalledWith(BOOT_TIME);
    expect(deps.db.finalizeTurnIfOpen).toHaveBeenCalledWith(
      'turn-1',
      expect.objectContaining({
        error: TURN_ERROR_ORCHESTRATOR_RESTART,
      }),
      expect.objectContaining({ fenceToken: 1 }),
    );
    // pilot contract: turn.completed carries conversationId and a status
    // within completed|error|cancelled — never a new vocabulary value.
    expect(deps.eventBus.emitAsync).toHaveBeenCalledWith('turn.completed', expect.objectContaining({
      turnId: 'turn-1',
      conversationId: 'conv-1',
      status: 'error',
    }));
  });

  it('leaves turns parked on pending or timed_out HITL interrupts open (WS-B owns them)', async () => {
    for (const status of ['pending', 'timed_out']) {
      const deps = createDeps({
        openTurns: [createTurn()],
        interrupt: { id: 'turn-1', status },
      });

      const result = await reconcileStrandedTurnsOnStartup(deps, BOOT_TIME);

      expect(result).toEqual(expect.objectContaining({ failed: 0, skippedHitlParked: 1, redispatched: 0 }));
      expect(deps.db.finalizeTurnIfOpen).not.toHaveBeenCalled();
      expect(deps.eventBus.emit).not.toHaveBeenCalled();
    }
  });

  it('does not treat a resolved interrupt row as parked', async () => {
    const deps = createDeps({
      openTurns: [createTurn()],
      interrupt: { id: 'turn-1', status: 'resolved' },
    });

    const result = await reconcileStrandedTurnsOnStartup(deps, BOOT_TIME);

    expect(result.failed).toBe(1);
  });

  it('repairs running tool calls in both toolCalls and parts projections', async () => {
    const deps = createDeps({
      openTurns: [createTurn()],
      messages: [
        {
          id: 'msg-1',
          turnId: 'turn-1',
          toolCalls: [
            { id: 'tc-1', name: 'bash', args: '{}', status: 'running' },
            { id: 'tc-2', name: 'read', args: '{}', status: 'complete', result: 'ok' },
          ],
          parts: [
            { type: 'text', text: 'working on it' },
            { type: 'tool_call', id: 'tc-1', name: 'bash', args: '{}', status: 'running' },
          ],
        },
        { id: 'msg-2', turnId: 'turn-1', toolCalls: null, parts: null },
      ],
    });

    await reconcileStrandedTurnsOnStartup(deps, BOOT_TIME);

    expect(deps.db.stageAssistantMessageUpdate).toHaveBeenCalledTimes(1);
    const [messageId, toolCalls, parts] = deps.db.stageAssistantMessageUpdate.mock.calls[0];
    expect(messageId).toBe('msg-1');
    expect(toolCalls).toEqual([
      { id: 'tc-1', name: 'bash', args: '{}', status: 'error', error: TOOL_CALL_INTERRUPTED_ERROR },
      { id: 'tc-2', name: 'read', args: '{}', status: 'complete', result: 'ok' },
    ]);
    expect(parts).toEqual([
      { type: 'text', text: 'working on it' },
      { type: 'tool_call', id: 'tc-1', name: 'bash', args: '{}', status: 'error', error: TOOL_CALL_INTERRUPTED_ERROR },
    ]);
    expect(deps.eventBus.emitAsync).toHaveBeenCalledWith(
      'message.updated',
      expect.objectContaining({
        messageId: 'msg-1',
        messageRevision: 1,
        messageSeq: 0,
        parts,
        toolCalls,
      }),
      {
        deliveryFence: expect.objectContaining({
          ownerId: expect.any(String),
          fenceToken: 1,
        }),
      },
    );
  });

  it('leaves messages without running tool calls untouched', async () => {
    const deps = createDeps({
      openTurns: [createTurn()],
      messages: [
        { id: 'msg-1', toolCalls: [{ id: 'tc-1', status: 'complete' }], parts: [{ type: 'text', text: 'done' }] },
      ],
    });

    await reconcileStrandedTurnsOnStartup(deps, BOOT_TIME);

    expect(deps.db.stageAssistantMessageUpdate).not.toHaveBeenCalled();
  });

  it('continues reconciling remaining turns when one fails', async () => {
    const deps = createDeps({
      openTurns: [createTurn({ id: 'turn-1' }), createTurn({ id: 'turn-2', conversationId: 'conv-2' })],
    });
    deps.db.getPendingInterruptForTurn
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValue(undefined);

    const result = await reconcileStrandedTurnsOnStartup(deps, BOOT_TIME);

    expect(result.failed).toBe(1);
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('turn-1'),
      expect.any(Error),
    );
    expect(deps.db.finalizeTurnIfOpen).toHaveBeenCalledWith(
      'turn-2',
      expect.anything(),
      expect.objectContaining({ fenceToken: 1 }),
    );
  });

  it('redispatches queued turns from transcript through the durable user message', async () => {
    const redispatchQueuedTurn = vi.fn().mockResolvedValue(undefined);
    const deps = createDeps({
      openTurns: [
        createTurn({
          id: 'turn-queued',
          status: 'queued',
          userMessageId: 'msg-2',
          taskDescription: 'second prompt',
        }),
      ],
      messages: [
        { id: 'msg-1', agentId: 'agent-1', conversationId: 'conv-1', role: 'user', content: 'first prompt', createdAt: 1 },
        { id: 'msg-2', agentId: 'agent-1', conversationId: 'conv-1', role: 'user', content: 'second prompt', createdAt: 2 },
        { id: 'msg-3', agentId: 'agent-1', conversationId: 'conv-1', role: 'user', content: 'later prompt', createdAt: 3 },
      ],
    });
    const result = await reconcileStrandedTurnsOnStartup({
      ...deps,
      redispatchQueuedTurn,
    }, BOOT_TIME);

    expect(result).toEqual(expect.objectContaining({ failed: 0, skippedHitlParked: 0, redispatched: 1 }));
    expect(deps.db.finalizeTurnIfOpen).not.toHaveBeenCalled();
    expect(redispatchQueuedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 'turn-queued',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        mode: 'interactive',
        taskDescription: 'second prompt',
        userMessageId: 'msg-2',
        deliveryContext: {
          fence: expect.objectContaining({ fenceToken: 1 }),
          userMessage: expect.objectContaining({
            messageId: 'msg-2',
            content: 'second prompt',
          }),
        },
        messages: [
          expect.objectContaining({ id: 'msg-1', content: 'first prompt' }),
          expect.objectContaining({ id: 'msg-2', content: 'second prompt' }),
        ],
      }),
      expect.anything(),
    );
    expect(deps.eventBus.emitAsync).not.toHaveBeenCalledWith('user.message', expect.anything());
  });

  it('counts a redispatch that finalized under its own delivery fence', async () => {
    const redispatchQueuedTurn = vi.fn().mockResolvedValue(undefined);
    const deps = createDeps({
      openTurns: [
        createTurn({
          id: 'turn-queued',
          status: 'queued',
          userMessageId: 'msg-1',
        }),
      ],
      messages: [
        {
          id: 'msg-1',
          agentId: 'agent-1',
          conversationId: 'conv-1',
          role: 'user',
          content: 'finish during redispatch',
          createdAt: 1,
        },
      ],
    });
    deps.db.isTurnDeliveryFenceCurrent.mockResolvedValue(false);
    deps.db.wasTurnFinalizedByDeliveryFence.mockResolvedValue(true);

    const result = await reconcileStrandedTurnsOnStartup({
      ...deps,
      redispatchQueuedTurn,
    }, BOOT_TIME);

    expect(result.redispatched).toBe(1);
    expect(deps.db.wasTurnFinalizedByDeliveryFence).toHaveBeenCalledWith(
      'turn-queued',
      expect.objectContaining({ ownerId: expect.any(String), fenceToken: 1 }),
    );
    expect(deps.logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('lost its fence'),
    );
  });

  it('defers an interactive recovery user message to the fenced delivery boundary', async () => {
    const order: string[] = [];
    const redispatchQueuedTurn = vi.fn(async () => {
      order.push('redispatch');
    });
    const deps = createDeps({
      openTurns: [
        createTurn({
          id: 'turn-queued',
          sandboxSessionId: null,
          status: 'queued',
          userMessageId: 'msg-2',
          taskDescription: 'second prompt',
        }),
      ],
      messages: [
        { id: 'msg-1', agentId: 'agent-1', conversationId: 'conv-1', role: 'user', content: 'first prompt', createdAt: 1 },
        { id: 'msg-2', agentId: 'agent-1', conversationId: 'conv-1', role: 'user', content: 'second prompt', createdAt: 2 },
      ],
    });
    const result = await reconcileStrandedTurnsOnStartup({
      ...deps,
      redispatchQueuedTurn,
    }, BOOT_TIME);

    expect(result).toEqual(expect.objectContaining({ failed: 0, redispatched: 1 }));
    expect(redispatchQueuedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryContext: {
          fence: expect.objectContaining({ fenceToken: 1 }),
          userMessage: {
            turnId: 'turn-queued',
            agentId: 'agent-1',
            conversationId: 'conv-1',
            messageId: 'msg-2',
            content: 'second prompt',
            timestamp: 2,
          },
        },
      }),
      expect.any(AbortSignal),
    );
    expect(deps.eventBus.emitAsync).not.toHaveBeenCalledWith('user.message', expect.anything());
    expect(order).toEqual(['redispatch']);
  });

  it('does not synthesize user-message frames for queued background turns', async () => {
    const redispatchQueuedTurn = vi.fn().mockResolvedValue(undefined);
    const deps = createDeps({
      openTurns: [
        createTurn({
          id: 'turn-background',
          sandboxSessionId: null,
          status: 'queued',
          mode: 'background',
          userMessageId: 'msg-background',
          taskDescription: 'triggered task',
        }),
      ],
      messages: [
        {
          id: 'msg-background',
          agentId: 'agent-1',
          conversationId: 'conv-1',
          role: 'user',
          content: 'triggered task',
          createdAt: 2,
        },
      ],
    });

    const result = await reconcileStrandedTurnsOnStartup({
      ...deps,
      redispatchQueuedTurn,
    }, BOOT_TIME);

    expect(result).toEqual(expect.objectContaining({ failed: 0, redispatched: 1 }));
    expect(deps.eventBus.emitAsync).not.toHaveBeenCalledWith('user.message', expect.anything());
    expect(redispatchQueuedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 'turn-background',
        mode: 'background',
        deliveryContext: {
          fence: expect.objectContaining({ fenceToken: 1 }),
        },
      }),
      expect.anything(),
    );
  });

  it('does not republish or redispatch when another replica owns the turn lease', async () => {
    const redispatchQueuedTurn = vi.fn().mockResolvedValue(undefined);
    const deps = createDeps({
      openTurns: [
        createTurn({
          id: 'turn-queued',
          sandboxSessionId: null,
          status: 'queued',
          userMessageId: 'msg-queued',
        }),
      ],
      messages: [
        {
          id: 'msg-queued',
          agentId: 'agent-1',
          conversationId: 'conv-1',
          role: 'user',
          content: 'only once',
          createdAt: 2,
        },
      ],
    });
    deps.db.claimTurnDeliveryLease.mockResolvedValue(undefined);

    const result = await reconcileStrandedTurnsOnStartup({
      ...deps,
      redispatchQueuedTurn,
    }, BOOT_TIME);

    expect(result).toEqual(expect.objectContaining({ failed: 0, redispatched: 0 }));
    expect(deps.db.claimTurnDeliveryLease).toHaveBeenCalledWith(expect.objectContaining({
      turnId: 'turn-queued',
    }));
    expect(deps.eventBus.emitAsync).not.toHaveBeenCalledWith('user.message', expect.anything());
    expect(redispatchQueuedTurn).not.toHaveBeenCalled();
    expect(deps.db.releaseTurnDeliveryLease).not.toHaveBeenCalled();
    expect(deps.logger.error).not.toHaveBeenCalled();
  });

  it('does not count a redispatch whose fence is no longer current at completion', async () => {
    const redispatchQueuedTurn = vi.fn().mockResolvedValue(undefined);
    const deps = createDeps({
      openTurns: [
        createTurn({
          id: 'turn-queued',
          sandboxSessionId: null,
          status: 'queued',
          userMessageId: 'msg-queued',
        }),
      ],
      messages: [
        {
          id: 'msg-queued',
          agentId: 'agent-1',
          conversationId: 'conv-1',
          role: 'user',
          content: 'fenced',
          createdAt: 2,
        },
      ],
    });
    deps.db.isTurnDeliveryFenceCurrent.mockResolvedValue(false);

    const result = await reconcileStrandedTurnsOnStartup({
      ...deps,
      redispatchQueuedTurn,
    }, BOOT_TIME, {
      ownerId: 'reconciler-a',
      now: () => 10_000,
    });

    expect(result).toEqual(expect.objectContaining({ failed: 0, redispatched: 0 }));
    expect(deps.db.isTurnDeliveryFenceCurrent).toHaveBeenCalledWith(
      'turn-queued',
      { ownerId: 'reconciler-a', fenceToken: 1 },
    );
    expect(deps.eventBus.emitAsync).not.toHaveBeenCalledWith('user.message', expect.anything());
    expect(redispatchQueuedTurn).toHaveBeenCalledOnce();
  });

  it('aborts a long redispatch when delivery lease ownership is lost', async () => {
    vi.useFakeTimers();
    try {
      const deps = createDeps({
        openTurns: [
          createTurn({
            id: 'turn-queued',
            sandboxSessionId: null,
            status: 'queued',
            userMessageId: 'msg-queued',
          }),
        ],
        messages: [
          {
            id: 'msg-queued',
            agentId: 'agent-1',
            conversationId: 'conv-1',
            role: 'user',
            content: 'long-running',
            createdAt: 2,
          },
        ],
      });
      deps.db.renewTurnDeliveryLease.mockResolvedValue(undefined);
      let observedSignal: AbortSignal | undefined;
      const redispatchQueuedTurn = vi.fn((_params: unknown, signal: AbortSignal) => {
        observedSignal = signal;
        return new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      });

      const reconciliation = reconcileStrandedTurnsOnStartup({
        ...deps,
        redispatchQueuedTurn,
      }, BOOT_TIME, {
        ownerId: 'reconciler-a',
        leaseMs: 100,
        heartbeatMs: 10,
        now: Date.now,
      });

      await vi.advanceTimersByTimeAsync(10);
      const result = await reconciliation;
      await result.redispatchComplete;

      expect(deps.db.renewTurnDeliveryLease).toHaveBeenCalledTimes(1);
      expect(observedSignal?.aborted).toBe(true);
      expect(result.redispatched).toBe(0);
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('lost delivery lease'),
      );
      expect(deps.db.releaseTurnDeliveryLease).toHaveBeenCalledWith(
        'turn-queued',
        'reconciler-a',
        1,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets stranded active sessions before redispatching queued turns', async () => {
    const order: string[] = [];
    const resetStrandedSession = vi.fn(async () => {
      order.push('reset');
    });
    const redispatchQueuedTurn = vi.fn(async () => {
      order.push('redispatch');
    });
    const deps = createDeps({
      openTurns: [
        createTurn({
          id: 'turn-running',
          sandboxSessionId: 'sess-1',
          status: 'running',
        }),
        createTurn({
          id: 'turn-queued',
          sandboxSessionId: 'sess-1',
          status: 'queued',
          userMessageId: 'msg-2',
          taskDescription: 'second prompt',
        }),
      ],
      messages: [
        { id: 'msg-1', agentId: 'agent-1', conversationId: 'conv-1', role: 'user', content: 'first prompt', createdAt: 1 },
        { id: 'msg-2', agentId: 'agent-1', conversationId: 'conv-1', role: 'user', content: 'second prompt', createdAt: 2 },
      ],
    });

    const result = await reconcileStrandedTurnsOnStartup({
      ...deps,
      redispatchQueuedTurn,
      resetStrandedSession,
    }, BOOT_TIME);

    expect(result).toEqual(expect.objectContaining({ failed: 1, skippedHitlParked: 0, redispatched: 1 }));
    expect(resetStrandedSession).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({
        operation: 'reset',
        operationId: 'logical-reset-1',
      }),
    );
    expect(
      deps.db.finalizeTurnAndMarkLifecycleDraining,
    ).toHaveBeenCalledWith(
      'turn-running',
      expect.objectContaining({
        status: 'error',
      }),
      expect.objectContaining({
        fenceToken: 1,
      }),
      expect.objectContaining({
        sandboxSessionId: 'sess-1',
        fenceToken: 1,
      }),
    );
    expect(
      deps.db.markSandboxSessionLifecycleOperationExecuting,
    ).toHaveBeenCalledOnce();
    expect(order).toEqual(['reset', 'redispatch']);
  });

  it('fails queued turns without durable user-message linkage instead of redispatching', async () => {
    const redispatchQueuedTurn = vi.fn().mockResolvedValue(undefined);
    const deps = createDeps({
      openTurns: [createTurn({ id: 'turn-queued', status: 'queued', userMessageId: null })],
    });

    const result = await reconcileStrandedTurnsOnStartup({
      ...deps,
      redispatchQueuedTurn,
    }, BOOT_TIME);

    expect(result).toEqual(expect.objectContaining({ failed: 1, skippedHitlParked: 0, redispatched: 0 }));
    expect(redispatchQueuedTurn).not.toHaveBeenCalled();
    expect(deps.db.finalizeTurnIfOpen).toHaveBeenCalledWith(
      'turn-queued',
      expect.objectContaining({
        error: TURN_ERROR_ORCHESTRATOR_RESTART,
        status: 'error',
      }),
      expect.objectContaining({ fenceToken: 1 }),
    );
  });
});
