import { describe, expect, it, vi } from 'vitest';

import { SandboxSessionStatusConflictError } from '../../../database/repository.js';
import { SessionStatusCoordinator, StaleTransitionError } from '../session-status-coordinator.js';
import { SessionStateStore } from '../session-state-store.js';
import type { SessionRecord } from '../types.js';

function createCoordinator() {
  const updateSandboxSessionStatus = vi.fn().mockResolvedValue(undefined);
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const stateStore = new SessionStateStore();
  const coordinator = new SessionStatusCoordinator({
    db: { updateSandboxSessionStatus },
    logger,
    stateStore,
  });

  return { coordinator, updateSandboxSessionStatus, logger, stateStore };
}

function seedSession(stateStore: SessionStateStore, overrides: Partial<SessionRecord> = {}): SessionRecord {
  const record: SessionRecord = {
    sessionId: overrides.sessionId ?? 'sess-1',
    conversationId: overrides.conversationId ?? 'conv-1',
    agentId: overrides.agentId ?? 'agent-1',
    containerName: overrides.containerName ?? 'ctxmill-session-1',
    containerId: overrides.containerId ?? 'container-1',
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
    const { coordinator, updateSandboxSessionStatus, stateStore } = createCoordinator();
    const record = seedSession(stateStore, { status: 'RESTORING' });

    await coordinator.transition({
      sessionId: record.sessionId,
      fromStatus: 'CHECKPOINTED',
      toStatus: 'ACTIVE',
      extra: { checkpointRef: null },
    });

    expect(updateSandboxSessionStatus).toHaveBeenCalledWith(
      record.sessionId,
      'ACTIVE',
      expect.objectContaining({
        checkpointRef: null,
      }),
      { expectedFrom: 'RESTORING' },
    );
    expect(record.status).toBe('ACTIVE');
  });

  it('clears runtime container metadata when requested', async () => {
    const { coordinator, updateSandboxSessionStatus, stateStore } = createCoordinator();
    const record = seedSession(stateStore, {
      status: 'ACTIVE',
      containerName: 'ctxmill-session-live',
      containerId: 'container-live',
    });

    await coordinator.transition({
      sessionId: record.sessionId,
      toStatus: 'TERMINATED',
      clearRuntime: true,
    });

    expect(updateSandboxSessionStatus).toHaveBeenCalledWith(
      record.sessionId,
      'TERMINATED',
      expect.objectContaining({
        containerName: null,
        containerId: null,
      }),
      { expectedFrom: 'ACTIVE' },
    );
    expect(record.containerName).toBe('');
    expect(record.containerId).toBe('');
    expect(record.status).toBe('TERMINATED');
  });

  it('does not write or log a transition for unchanged status', async () => {
    const { coordinator, updateSandboxSessionStatus, logger, stateStore } = createCoordinator();
    const record = seedSession(stateStore, { status: 'ACTIVE' });

    await coordinator.transition({
      sessionId: record.sessionId,
      toStatus: 'ACTIVE',
    });

    expect(updateSandboxSessionStatus).not.toHaveBeenCalled();
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

  it('surfaces stale DB transitions and leaves the memory mirror untouched', async () => {
    const { coordinator, updateSandboxSessionStatus, stateStore } = createCoordinator();
    const record = seedSession(stateStore, { status: 'ACTIVE' });
    updateSandboxSessionStatus.mockRejectedValueOnce(
      new SandboxSessionStatusConflictError(record.sessionId, 'ACTIVE', 'CHECKPOINTED'),
    );

    await expect(coordinator.transition({
      sessionId: record.sessionId,
      toStatus: 'CHECKPOINTED',
      clearRuntime: true,
    })).rejects.toBeInstanceOf(StaleTransitionError);

    expect(record.status).toBe('ACTIVE');
    expect(updateSandboxSessionStatus).toHaveBeenCalledWith(
      record.sessionId,
      'CHECKPOINTED',
      expect.objectContaining({
        containerName: null,
        containerId: null,
      }),
      { expectedFrom: 'ACTIVE' },
    );
  });
});
