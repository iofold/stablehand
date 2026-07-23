import { describe, expect, it, vi } from 'vitest';

import {
  RestoreConflictError,
  SandboxSessionNotFoundError,
  SessionLifecycleService,
  type SessionLifecycleServiceDeps,
} from '../session-lifecycle-service.js';
import type { SandboxSessionRow } from '../../../database/repository.js';
import type { AgentDefinition } from '@ctxmill/sandbox-daemon';
import type { SessionRecord } from '../types.js';

function makeAgentDef(): AgentDefinition {
  return {
    name: 'agent-1',
    harness: 'langgraph',
    systemPrompt: 'sys',
    tools: [],
    harnessConfig: {},
  } as unknown as AgentDefinition;
}

function makeRow(overrides: Partial<SandboxSessionRow> = {}): SandboxSessionRow {
  return {
    id: 'sandbox-1',
    conversationId: 'conv-1',
    agentId: 'agent-1',
    containerName: null,
    containerId: null,
    status: 'CHECKPOINTED',
    harnessName: 'langgraph',
    checkpointRef: null,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    restoreAttempts: 3,
    lastRestoreError: 'budget exhausted',
    restoreOwnerId: null,
    restoreFenceToken: 0,
    restoreLeaseExpiresAt: null,
    runtimeDefinitionHash: 'runtime-1',
    ...overrides,
  };
}

function makeRecord(row = makeRow()): SessionRecord {
  return {
    sessionId: row.id,
    conversationId: row.conversationId,
    agentId: row.agentId,
    containerName: row.containerName ?? 'ctxmill-sandbox-sandbox-1',
    containerId: row.containerId ?? 'container-1',
    restoreFenceToken: row.restoreFenceToken,
    runtimeDefinitionHash: row.runtimeDefinitionHash ?? '',
    status: 'ACTIVE',
    harnessName: row.harnessName,
  };
}

function createHarness(rows: SandboxSessionRow[] = [makeRow(), makeRow()]) {
  const agentDef = makeAgentDef();
  const record = makeRecord(rows[rows.length - 1]);
  const getSandboxSession = vi.fn(async () => rows.shift() ?? null);
  const getSandboxSessionByConversation = vi.fn(async () =>
    rows[rows.length - 1] ?? null
  );
  const transition = vi.fn().mockResolvedValue(undefined);
  const recoverOrReconnect = vi.fn().mockResolvedValue(record);
  const createFreshSession = vi.fn().mockResolvedValue({
    ...record,
    sessionId: 'sandbox-replacement',
    runtimeDefinitionHash: 'runtime-1',
  });
  const stateStore = {
    withConversationLock: vi.fn(async (_conversationId: string, fn: () => Promise<unknown>) => fn()),
    setAgentDef: vi.fn(),
    setSession: vi.fn(),
    getSessionByConversation: vi.fn(),
    getSessionById: vi.fn(),
    getActiveTurnId: vi.fn(),
    cleanupSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteQueue: vi.fn(),
    markTurnInactive: vi.fn(),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const deps: SessionLifecycleServiceDeps = {
    stateStore: stateStore as never,
    recoveryCoordinator: { recoverOrReconnect } as never,
    createFreshSession,
    resolveRuntimeDefinitionHash: vi.fn().mockResolvedValue('runtime-1'),
    db: {
      getSandboxSession,
      getSandboxSessionByConversation,
    } as never,
    statusCoordinator: { transition } as never,
    containerManager: {} as never,
    lifecyclePolicy: {} as never,
    workspaceDiffService: {} as never,
    logger,
    parsePendingRequestPayload: vi.fn(),
  };

  return {
    service: new SessionLifecycleService(deps),
    agentDef,
    getSandboxSession,
    getSandboxSessionByConversation,
    transition,
    recoverOrReconnect,
    createFreshSession,
    stateStore,
    record,
    logger,
  };
}

describe('SessionLifecycleService.ensureSession generation validation', () => {
  it('returns a cached ACTIVE runtime only while its exact generation is current', async () => {
    const current = makeRow({
      status: 'ACTIVE',
      containerName: 'generation-one',
      containerId: 'container-generation-one',
      restoreFenceToken: 3,
    });
    const harness = createHarness([current]);
    const cached = makeRecord(current);
    harness.stateStore.getSessionByConversation.mockReturnValue(cached);

    await expect(harness.service.ensureSession(
      current.conversationId,
      harness.agentDef,
      current.agentId,
    )).resolves.toBe(cached);

    expect(harness.getSandboxSession).toHaveBeenCalledWith(current.id);
    expect(harness.getSandboxSessionByConversation).not.toHaveBeenCalled();
    expect(harness.recoverOrReconnect).not.toHaveBeenCalled();
    expect(harness.stateStore.deleteSession).not.toHaveBeenCalled();
  });

  it('discards a stale cached generation and recovers the persisted successor', async () => {
    const stale = makeRow({
      status: 'ACTIVE',
      containerName: 'generation-one',
      containerId: 'container-generation-one',
      restoreFenceToken: 3,
    });
    const successor = makeRow({
      status: 'ACTIVE',
      containerName: 'generation-two',
      containerId: 'container-generation-two',
      restoreFenceToken: 4,
    });
    const harness = createHarness([successor]);
    const cached = makeRecord(stale);
    const successorRecord = makeRecord(successor);
    harness.stateStore.getSessionByConversation.mockReturnValue(cached);
    harness.getSandboxSessionByConversation.mockResolvedValue(successor);
    harness.recoverOrReconnect.mockResolvedValue(successorRecord);

    await expect(harness.service.ensureSession(
      successor.conversationId,
      harness.agentDef,
      successor.agentId,
    )).resolves.toBe(successorRecord);

    expect(harness.stateStore.deleteSession).toHaveBeenCalledWith(
      successor.conversationId,
    );
    expect(harness.recoverOrReconnect).toHaveBeenCalledWith(
      successor.conversationId,
      harness.agentDef,
      successor.agentId,
      successor,
      undefined,
    );
  });

  it('opens a fresh runtime instead of restoring an incompatible checkpoint', async () => {
    const checkpoint = makeRow({
      status: 'CHECKPOINTED',
      runtimeDefinitionHash: 'runtime-before-edit',
    });
    const harness = createHarness([checkpoint]);

    await expect(harness.service.ensureSession(
      checkpoint.conversationId,
      harness.agentDef,
      checkpoint.agentId,
    )).resolves.toMatchObject({
      sessionId: 'sandbox-replacement',
      runtimeDefinitionHash: 'runtime-1',
    });

    expect(harness.recoverOrReconnect).not.toHaveBeenCalled();
    expect(harness.createFreshSession).toHaveBeenCalledWith(
      checkpoint.conversationId,
      harness.agentDef,
      checkpoint.agentId,
      { runtimeDefinitionHash: 'runtime-1' },
    );
    expect(harness.stateStore.setSession).toHaveBeenCalledWith(
      checkpoint.conversationId,
      expect.objectContaining({ sessionId: 'sandbox-replacement' }),
    );
  });

  it('drains and replaces an idle warm runtime after its definition changes', async () => {
    const current = makeRow({
      status: 'ACTIVE',
      containerName: 'warm-container',
      containerId: 'warm-container-id',
      runtimeDefinitionHash: 'runtime-before-edit',
    });
    const harness = createHarness([current]);
    harness.stateStore.getSessionByConversation.mockReturnValue(
      makeRecord(current),
    );
    const internals = harness.service as unknown as {
      terminateSession(
        sessionId: string,
        operation: 'terminate' | 'reset',
        options: Record<string, never>,
      ): Promise<void>;
    };
    const terminate = vi.spyOn(internals, 'terminateSession')
      .mockResolvedValue(undefined);

    await expect(harness.service.ensureSession(
      current.conversationId,
      harness.agentDef,
      current.agentId,
    )).resolves.toMatchObject({
      sessionId: 'sandbox-replacement',
      runtimeDefinitionHash: 'runtime-1',
    });

    expect(terminate).toHaveBeenCalledWith(current.id, 'reset', {});
    expect(harness.createFreshSession).toHaveBeenCalledWith(
      current.conversationId,
      harness.agentDef,
      current.agentId,
      { runtimeDefinitionHash: 'runtime-1' },
    );
  });

  it('does not destroy an in-flight runtime when its definition changes', async () => {
    const current = makeRow({
      status: 'ACTIVE',
      containerName: 'busy-container',
      containerId: 'busy-container-id',
      runtimeDefinitionHash: 'runtime-before-edit',
    });
    const harness = createHarness([current]);
    harness.stateStore.getSessionByConversation.mockReturnValue(
      makeRecord(current),
    );
    harness.stateStore.getActiveTurnId.mockReturnValue('turn-in-flight');

    await expect(harness.service.ensureSession(
      current.conversationId,
      harness.agentDef,
      current.agentId,
    )).rejects.toThrow('retry after it drains');

    expect(harness.createFreshSession).not.toHaveBeenCalled();
  });
});

describe('SessionLifecycleService.restoreSession', () => {
  it('resets exhausted restore attempts inside the conversation lock before recovery', async () => {
    const row = makeRow({ restoreAttempts: 3, lastRestoreError: 'exhausted' });
    const harness = createHarness([row, row]);

    await expect(harness.service.restoreSession(row.id, harness.agentDef, row.agentId))
      .resolves.toEqual(harness.record);

    expect(harness.stateStore.withConversationLock).toHaveBeenCalledWith(row.conversationId, expect.any(Function));
    expect(harness.stateStore.setAgentDef).toHaveBeenCalledWith(row.conversationId, harness.agentDef);
    expect(harness.transition).toHaveBeenCalledWith({
      sessionId: row.id,
      fromStatus: 'CHECKPOINTED',
      toStatus: 'CHECKPOINTED',
      extra: { restoreAttempts: 0, lastRestoreError: null },
    });
    expect(harness.recoverOrReconnect).toHaveBeenCalledWith(
      row.conversationId,
      harness.agentDef,
      row.agentId,
      expect.objectContaining({ id: row.id, restoreAttempts: 0, lastRestoreError: null }),
    );
  });

  it('starts async restore after resetting budget and clearing the visible error', async () => {
    const row = makeRow({ restoreAttempts: 3, lastRestoreError: 'exhausted' });
    const harness = createHarness([row, row]);
    harness.recoverOrReconnect.mockReturnValue(new Promise<SessionRecord>(() => {}));

    await expect(harness.service.restoreSession(
      row.id,
      harness.agentDef,
      row.agentId,
      { background: true },
    ))
      .resolves.toEqual({ sandboxSessionId: row.id, status: 'RESTORING', restoreAttempts: 0 });

    expect(harness.transition).toHaveBeenCalledWith({
      sessionId: row.id,
      fromStatus: 'CHECKPOINTED',
      toStatus: 'CHECKPOINTED',
      extra: { restoreAttempts: 0, lastRestoreError: null },
    });
    expect(harness.recoverOrReconnect).toHaveBeenCalledWith(
      row.conversationId,
      harness.agentDef,
      row.agentId,
      expect.objectContaining({ id: row.id, restoreAttempts: 0, lastRestoreError: null }),
    );
  });

  it('logs background restore failures without rejecting the start response', async () => {
    const row = makeRow();
    const harness = createHarness([row, row]);
    const failure = new Error('restore failed');
    harness.recoverOrReconnect.mockRejectedValue(failure);

    await expect(harness.service.restoreSession(
      row.id,
      harness.agentDef,
      row.agentId,
      { background: true },
    )).resolves.toEqual({ sandboxSessionId: row.id, status: 'RESTORING', restoreAttempts: 0 });
    await vi.waitFor(() => {
      expect(harness.logger.warn).toHaveBeenCalledWith(
        `[SandboxSessionManager] background restore failed for session ${row.id}:`,
        failure,
      );
    });
  });

  it('throws SandboxSessionNotFoundError when the session row is missing before the lock', async () => {
    const harness = createHarness([]);

    await expect(harness.service.restoreSession('missing-session', harness.agentDef, 'agent-1'))
      .rejects.toBeInstanceOf(SandboxSessionNotFoundError);

    expect(harness.stateStore.withConversationLock).not.toHaveBeenCalled();
    expect(harness.recoverOrReconnect).not.toHaveBeenCalled();
  });

  it('throws RestoreConflictError when the row is no longer CHECKPOINTED inside the lock', async () => {
    const checkpointed = makeRow();
    const active = makeRow({ status: 'ACTIVE' });
    const harness = createHarness([checkpointed, active]);

    await expect(harness.service.restoreSession(checkpointed.id, harness.agentDef, checkpointed.agentId))
      .rejects.toBeInstanceOf(RestoreConflictError);

    expect(harness.transition).not.toHaveBeenCalled();
    expect(harness.recoverOrReconnect).not.toHaveBeenCalled();
  });
});
