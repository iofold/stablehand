import { describe, expect, it, vi } from 'vitest';

import { SandboxSessionStatusConflictError } from '../../../database/repository.js';
import { SessionStatusCoordinator, StaleTransitionError } from '../session-status-coordinator.js';
import { SessionStateStore } from '../session-state-store.js';
import type { SessionRecord } from '../types.js';

function createCoordinator() {
  const updateSandboxSessionMetadata = vi.fn().mockResolvedValue(undefined);
  const completeSandboxSessionLifecycleOperation = vi.fn().mockResolvedValue(true);
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const stateStore = new SessionStateStore();
  const coordinator = new SessionStatusCoordinator({
    db: {
      updateSandboxSessionMetadata,
      completeSandboxSessionLifecycleOperation,
    },
    logger,
    stateStore,
  });

  return {
    coordinator,
    updateSandboxSessionMetadata,
    completeSandboxSessionLifecycleOperation,
    logger,
    stateStore,
  };
}

function seedSession(stateStore: SessionStateStore, overrides: Partial<SessionRecord> = {}): SessionRecord {
  const record: SessionRecord = {
    sessionId: overrides.sessionId ?? 'sess-1',
    conversationId: overrides.conversationId ?? 'conv-1',
    agentId: overrides.agentId ?? 'agent-1',
    containerName: overrides.containerName ?? 'ctxmill-session-1',
    containerId: overrides.containerId ?? 'container-1',
    restoreFenceToken: overrides.restoreFenceToken ?? 0,
    status: overrides.status ?? 'ACTIVE',
    harnessName: overrides.harnessName ?? 'langgraph',
    grpcClient: overrides.grpcClient,
    sessionWorkspaceDir: overrides.sessionWorkspaceDir,
  };

  stateStore.setSession(record.conversationId, record);
  return record;
}

describe('SessionStatusCoordinator', () => {
  it('prefers the cached session status over a stale caller hint', async () => {
    const { coordinator, updateSandboxSessionMetadata, stateStore } = createCoordinator();
    const record = seedSession(stateStore, { status: 'ACTIVE' });

    await coordinator.transition({
      sessionId: record.sessionId,
      fromStatus: 'CHECKPOINTED',
      toStatus: 'ACTIVE',
      extra: { containerName: 'ctxmill-session-rebound' },
      expectedActiveGeneration: {
        restoreFenceToken: 0,
        containerId: 'container-1',
      },
    });

    expect(updateSandboxSessionMetadata).toHaveBeenCalledWith(
      record.sessionId,
      'ACTIVE',
      { containerName: 'ctxmill-session-rebound' },
      {
        restoreFenceToken: 0,
        containerId: 'container-1',
      },
    );
    expect(record.containerName).toBe('ctxmill-session-rebound');
    expect(record.status).toBe('ACTIVE');
  });

  it('rejects generic admission to and completion from RESTORING', async () => {
    const {
      coordinator,
      updateSandboxSessionMetadata,
      stateStore,
    } = createCoordinator();
    const checkpointed = seedSession(stateStore, {
      sessionId: 'checkpointed-session',
      conversationId: 'checkpointed-conversation',
      status: 'CHECKPOINTED',
    });

    await expect(coordinator.transition({
      sessionId: checkpointed.sessionId,
      toStatus: 'RESTORING',
    })).rejects.toThrow(/restore-fenced repository methods/);

    const restoring = seedSession(stateStore, {
      sessionId: 'restoring-session',
      conversationId: 'restoring-conversation',
      status: 'RESTORING',
    });
    await expect(coordinator.transition({
      sessionId: restoring.sessionId,
      toStatus: 'ACTIVE',
    })).rejects.toThrow(/restore-fenced repository methods/);

    expect(updateSandboxSessionMetadata).not.toHaveBeenCalled();
  });

  it('rejects a destructive transition without lifecycle ownership', async () => {
    const { coordinator, updateSandboxSessionMetadata, stateStore } = createCoordinator();
    const record = seedSession(stateStore, {
      status: 'ACTIVE',
      containerName: 'ctxmill-session-live',
      containerId: 'container-live',
    });

    await expect(coordinator.transition({
      sessionId: record.sessionId,
      toStatus: 'TERMINATED',
      clearRuntime: true,
    })).rejects.toThrow(/canonical fenced lifecycle owner/);

    expect(updateSandboxSessionMetadata).not.toHaveBeenCalled();
    expect(record.containerName).toBe('ctxmill-session-live');
    expect(record.containerId).toBe('container-live');
    expect(record.status).toBe('ACTIVE');
  });

  it('completes lifecycle ownership atomically with a destructive transition', async () => {
    const {
      coordinator,
      updateSandboxSessionMetadata,
      completeSandboxSessionLifecycleOperation,
      stateStore,
    } = createCoordinator();
    const record = seedSession(stateStore, { status: 'ACTIVE' });

    await coordinator.transition({
      sessionId: record.sessionId,
      toStatus: 'CHECKPOINTED',
      clearRuntime: true,
      lifecycleOperation: {
        ownerId: 'lifecycle-owner',
        fenceToken: 7,
      },
    });

    expect(completeSandboxSessionLifecycleOperation).toHaveBeenCalledWith({
      sandboxSessionId: record.sessionId,
      ownerId: 'lifecycle-owner',
      fenceToken: 7,
      fromStatus: 'ACTIVE',
      toStatus: 'CHECKPOINTED',
      extra: expect.objectContaining({
        containerName: null,
        containerId: null,
      }),
    });
    expect(updateSandboxSessionMetadata).not.toHaveBeenCalled();
    expect(record.status).toBe('CHECKPOINTED');
  });

  it('does not write or log a transition for unchanged status', async () => {
    const { coordinator, updateSandboxSessionMetadata, logger, stateStore } = createCoordinator();
    const record = seedSession(stateStore, { status: 'ACTIVE' });

    await coordinator.transition({
      sessionId: record.sessionId,
      toStatus: 'ACTIVE',
    });

    expect(updateSandboxSessionMetadata).not.toHaveBeenCalled();
    expect(record.status).toBe('ACTIVE');
    expect(logger.debug).toHaveBeenCalledWith(
      `[SessionStatusCoordinator] session ${record.sessionId}: ACTIVE unchanged`,
    );
  });

  it('requires a status hint when the session is not cached', async () => {
    const { coordinator } = createCoordinator();

    await expect(coordinator.transition({
      sessionId: 'missing-session',
      toStatus: 'ACTIVE',
    })).rejects.toThrow('requires fromStatus');
  });

  it('surfaces stale metadata writes and leaves the memory mirror untouched', async () => {
    const { coordinator, updateSandboxSessionMetadata, stateStore } = createCoordinator();
    const record = seedSession(stateStore, { status: 'ACTIVE' });
    updateSandboxSessionMetadata.mockRejectedValueOnce(
      new SandboxSessionStatusConflictError(record.sessionId, 'ACTIVE', 'ACTIVE'),
    );

    await expect(coordinator.transition({
      sessionId: record.sessionId,
      toStatus: 'ACTIVE',
      extra: { containerName: 'ctxmill-session-rebound' },
      expectedActiveGeneration: {
        restoreFenceToken: 0,
        containerId: 'container-1',
      },
    })).rejects.toBeInstanceOf(StaleTransitionError);

    expect(record.status).toBe('ACTIVE');
    expect(record.containerName).toBe('ctxmill-session-1');
    expect(updateSandboxSessionMetadata).toHaveBeenCalledWith(
      record.sessionId,
      'ACTIVE',
      { containerName: 'ctxmill-session-rebound' },
      {
        restoreFenceToken: 0,
        containerId: 'container-1',
      },
    );
  });
});
