import { describe, expect, it, vi } from 'vitest';

import {
  TOOL_CALL_INTERRUPTED_ERROR,
  TURN_ERROR_ORCHESTRATOR_RESTART,
  TurnFinalizer,
} from '../turn-finalizer.js';
import type { TurnTakeoverResult } from '../turn-takeover.js';
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
  resumeAttempt?: Record<string, unknown> | undefined;
  messages?: Array<Record<string, unknown>>;
} = {}) {
  const eventBus = { emit: vi.fn(), emitAsync: vi.fn().mockResolvedValue(undefined) };
  const db = {
    getOpenTurnsStartedBefore: vi.fn().mockResolvedValue(options.openTurns ?? []),
    getPendingInterruptForTurn: vi.fn().mockResolvedValue(options.interrupt),
    getOpenInterruptResumeAttemptForTurn: vi.fn().mockResolvedValue(options.resumeAttempt),
    getMessages: vi.fn().mockResolvedValue(options.messages ?? []),
    getTurnFrames: vi.fn().mockResolvedValue([]),
    getSandboxSession: vi.fn().mockResolvedValue({
      id: 'sess-1',
      conversationId: 'conv-1',
      agentId: 'agent-1',
      containerName: 'stablehand-sandbox-sess-1',
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
    getTurn: vi.fn().mockResolvedValue(undefined),
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

  it('leaves dispatchable queued turns untouched for the dispatcher (ctx-z5k0)', async () => {
    const deps = createDeps({
      openTurns: [createTurn({
        id: 'turn-queued-1',
        status: 'queued',
        userMessageId: 'msg-user-1',
      })],
    });

    const result = await reconcileStrandedTurnsOnStartup(deps, BOOT_TIME);

    expect(result).toEqual(expect.objectContaining({ failed: 0, redispatched: 0 }));
    expect(deps.db.finalizeTurnIfOpen).not.toHaveBeenCalled();
    expect(deps.db.claimTurnDeliveryLease).not.toHaveBeenCalled();
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

describe('crash takeover of running turns (ADR 025)', () => {
  it('leaves an approved turn whose resume is still open to the resume worker (ctx-2jp0)', async () => {
    const deps = createDeps({
      openTurns: [createTurn()],
      resumeAttempt: { id: 'attempt-1', turnId: 'turn-1', status: 'pending', attempts: 0 },
    });
    const adoptRunningTurn = vi.fn(async (): Promise<TurnTakeoverResult> => ({
      outcome: 'unavailable',
      reason: 'the sandbox no longer had the turn running',
    }));
    const resetStrandedSession = vi.fn().mockResolvedValue(undefined);

    const result = await reconcileStrandedTurnsOnStartup({
      ...deps,
      adoptRunningTurn,
      resetStrandedSession,
    }, BOOT_TIME);

    expect(result).toEqual(expect.objectContaining({
      failed: 0,
      adopting: 0,
      skippedHitlParked: 1,
    }));
    await expect(result.adoptionComplete).resolves.toEqual({ adopted: 0, failed: 0, skipped: 0 });
    expect(adoptRunningTurn).not.toHaveBeenCalled();
    expect(deps.db.claimTurnDeliveryLease).not.toHaveBeenCalled();
    expect(deps.db.finalizeTurnIfOpen).not.toHaveBeenCalled();
    expect(deps.db.finalizeTurnAndMarkLifecycleDraining).not.toHaveBeenCalled();
    expect(resetStrandedSession).not.toHaveBeenCalled();
  });

  it('hands a running turn with a sandbox to takeover instead of failing it', async () => {
    const deps = createDeps({ openTurns: [createTurn()] });
    const adoptRunningTurn = vi.fn(async (): Promise<TurnTakeoverResult> => ({ outcome: 'adopted' }));
    const resetStrandedSession = vi.fn().mockResolvedValue(undefined);

    const result = await reconcileStrandedTurnsOnStartup({
      ...deps,
      adoptRunningTurn,
      resetStrandedSession,
    }, BOOT_TIME);

    expect(result).toEqual(expect.objectContaining({ failed: 0, adopting: 1 }));
    await expect(result.adoptionComplete).resolves.toEqual({ adopted: 1, failed: 0, skipped: 0 });
    expect(adoptRunningTurn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'turn-1' }),
      expect.objectContaining({
        fence: expect.objectContaining({ fenceToken: 1 }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(deps.db.finalizeTurnIfOpen).not.toHaveBeenCalled();
    expect(resetStrandedSession).not.toHaveBeenCalled();
    expect(deps.db.releaseTurnDeliveryLease).toHaveBeenCalledTimes(1);
  });

  it('closes the turn with takeover copy and resets its sandbox when re-attach is impossible', async () => {
    const deps = createDeps({ openTurns: [createTurn()] });
    const resetStrandedSession = vi.fn().mockResolvedValue(undefined);

    const result = await reconcileStrandedTurnsOnStartup({
      ...deps,
      adoptRunningTurn: async () => ({
        outcome: 'unavailable',
        reason: 'the sandbox no longer had the turn running',
      }),
      resetStrandedSession,
    }, BOOT_TIME);

    await expect(result.adoptionComplete).resolves.toEqual({ adopted: 0, failed: 1, skipped: 0 });
    expect(deps.db.finalizeTurnAndMarkLifecycleDraining).toHaveBeenCalledWith(
      'turn-1',
      expect.objectContaining({
        status: 'error',
        error: expect.stringContaining('could not reconnect to its sandbox (the sandbox no longer had the turn running)'),
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(resetStrandedSession).toHaveBeenCalledWith('sess-1', expect.anything());
  });

  it('waits for a lease held by another orchestrator to lapse, then takes over', async () => {
    const deps = createDeps({ openTurns: [createTurn()] });
    const claim = deps.db.claimTurnDeliveryLease.getMockImplementation()!;
    deps.db.claimTurnDeliveryLease
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockImplementation(claim);
    deps.db.getTurn.mockResolvedValue(createTurn());
    const adoptRunningTurn = vi.fn(async (): Promise<TurnTakeoverResult> => ({ outcome: 'adopted' }));

    const result = await reconcileStrandedTurnsOnStartup({
      ...deps,
      adoptRunningTurn,
    }, BOOT_TIME, { adoptionPollMs: 1, adoptionClaimWaitMs: 5_000 });

    await expect(result.adoptionComplete).resolves.toEqual({ adopted: 1, failed: 0, skipped: 0 });
    expect(deps.db.claimTurnDeliveryLease).toHaveBeenCalledTimes(3);
    expect(adoptRunningTurn).toHaveBeenCalledTimes(1);
  });

  it('stops waiting once the turn is finalized elsewhere', async () => {
    const deps = createDeps({ openTurns: [createTurn()] });
    deps.db.claimTurnDeliveryLease.mockResolvedValue(undefined);
    deps.db.getTurn.mockResolvedValue(createTurn({ status: 'completed', completedAt: BOOT_TIME + 5 }));
    const adoptRunningTurn = vi.fn(async (): Promise<TurnTakeoverResult> => ({ outcome: 'adopted' }));

    const result = await reconcileStrandedTurnsOnStartup({
      ...deps,
      adoptRunningTurn,
    }, BOOT_TIME, { adoptionPollMs: 1 });

    await expect(result.adoptionComplete).resolves.toEqual({ adopted: 0, failed: 0, skipped: 1 });
    expect(adoptRunningTurn).not.toHaveBeenCalled();
  });

  it('claims leases of a dead earlier boot of this instance without waiting', async () => {
    const deps = createDeps({ openTurns: [createTurn()] });
    const previousBootTakeover = {
      instancePrefix: 'orchestrator-1/',
      ownBootPrefix: 'orchestrator-1/boot-2/',
    };

    const result = await reconcileStrandedTurnsOnStartup({
      ...deps,
      adoptRunningTurn: async () => ({ outcome: 'adopted' }),
    }, BOOT_TIME, { previousBootTakeover, ownerId: 'orchestrator-1/boot-2/owner' });
    await result.adoptionComplete;

    expect(deps.db.claimTurnDeliveryLease).toHaveBeenCalledWith(expect.objectContaining({
      turnId: 'turn-1',
      ownerId: 'orchestrator-1/boot-2/owner',
      previousBootTakeover,
    }));
  });
});

