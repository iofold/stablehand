import { describe, expect, it, vi } from 'vitest';

import {
  RestoreConflictError,
  SandboxSessionNotFoundError,
  SessionLifecycleService,
  type SessionLifecycleServiceDeps,
} from '../session-lifecycle-service.js';
import type { SandboxSessionRow } from '../../../database/repository.js';
import type { AgentDefinition } from '../../../types.js';
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
    checkpointRef: 'ckpt-1',
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    restoreAttempts: 3,
    lastRestoreError: 'budget exhausted',
    ...overrides,
  };
}

function makeRecord(row = makeRow()): SessionRecord {
  return {
    sessionId: row.id,
    conversationId: row.conversationId,
    agentId: row.agentId,
    containerName: 'ctxmill-run-sandbox-1',
    containerId: 'container-1',
    status: 'ACTIVE',
    harnessName: row.harnessName,
  };
}

function createHarness(rows: SandboxSessionRow[] = [makeRow(), makeRow()]) {
  const agentDef = makeAgentDef();
  const record = makeRecord(rows[rows.length - 1]);
  const getSandboxSession = vi.fn(async () => rows.shift() ?? null);
  const transition = vi.fn().mockResolvedValue(undefined);
  const recoverOrReconnect = vi.fn().mockResolvedValue(record);
  const stateStore = {
    withConversationLock: vi.fn(async (_conversationId: string, fn: () => Promise<unknown>) => fn()),
    setAgentDef: vi.fn(),
    getSessionByConversation: vi.fn(),
    getSessionById: vi.fn(),
    getActiveTurnId: vi.fn(),
    cleanupSession: vi.fn(),
    deleteQueue: vi.fn(),
    markTurnInactive: vi.fn(),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const deps: SessionLifecycleServiceDeps = {
    stateStore: stateStore as never,
    recoveryCoordinator: { recoverOrReconnect } as never,
    createFreshSession: vi.fn(),
    db: { getSandboxSession } as never,
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
    transition,
    recoverOrReconnect,
    stateStore,
    record,
  };
}

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

    await expect(harness.service.startRestoreSession(row.id, harness.agentDef, row.agentId))
      .resolves.toEqual({ sessionId: row.id, status: 'RESTORING', restoreAttempts: 0 });

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
