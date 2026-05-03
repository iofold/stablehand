import type { DatabaseRepository } from '../../database/repository.js';
import { assertTransition } from './session-status-machine.js';
import type { SessionStatePort } from './ports.js';
import type { Logger, SessionStatus } from './types.js';

interface StatusExtra {
  containerName?: string | null;
  containerId?: string | null;
  checkpointRef?: string | null;
  pausedAt?: number | null;
  pausedReason?: string | null;
  restoreAttempts?: number | null;
  lastRestoreError?: string | null;
}

export interface SessionStatusCoordinatorDeps {
  db: Pick<DatabaseRepository, 'updateSandboxSessionStatus'>;
  logger: Logger;
  stateStore?: Pick<SessionStatePort, 'getSessionById'>;
}

export interface SessionStatusTransition {
  sessionId: string;
  fromStatus?: SessionStatus;
  toStatus: SessionStatus;
  extra?: StatusExtra;
  clearRuntime?: boolean;
}

export class SessionStatusCoordinator {
  constructor(private readonly deps: SessionStatusCoordinatorDeps) {}

  async transition({
    sessionId,
    fromStatus,
    toStatus,
    extra,
    clearRuntime = false,
  }: SessionStatusTransition): Promise<void> {
    const record = this.deps.stateStore?.getSessionById(sessionId);
    const currentStatus = record?.status ?? fromStatus;

    if (!currentStatus) {
      throw new Error(`SessionStatusCoordinator requires fromStatus when session ${sessionId} is not cached`);
    }

    if (currentStatus === toStatus && !extra && !clearRuntime) {
      this.deps.logger.debug(
        `[SessionStatusCoordinator] session ${sessionId}: ${currentStatus} unchanged`,
      );
      return;
    }

    if (currentStatus !== toStatus) {
      assertTransition(currentStatus, toStatus);
    }

    const normalizedExtra = normalizeStatusExtra(toStatus, extra, clearRuntime);

    if (normalizedExtra === undefined) {
      await this.deps.db.updateSandboxSessionStatus(sessionId, toStatus);
    } else {
      await this.deps.db.updateSandboxSessionStatus(sessionId, toStatus, normalizedExtra);
    }

    if (record) {
      record.status = toStatus;
      if (normalizedExtra?.containerName !== undefined) {
        record.containerName = normalizedExtra.containerName ?? '';
      }
      if (normalizedExtra?.containerId !== undefined) {
        record.containerId = normalizedExtra.containerId ?? '';
      }
    }

    this.deps.logger.debug(
      `[SessionStatusCoordinator] session ${sessionId}: ${currentStatus} -> ${toStatus}`,
    );
  }
}

function normalizeStatusExtra(
  toStatus: SessionStatus,
  extra: StatusExtra | undefined,
  clearRuntime: boolean,
): StatusExtra | undefined {
  const normalized: StatusExtra = extra ? { ...extra } : {};

  if (toStatus !== 'PAUSED') {
    if (normalized.pausedAt === undefined) {
      normalized.pausedAt = null;
    }
    if (normalized.pausedReason === undefined) {
      normalized.pausedReason = null;
    }
  }

  if (clearRuntime) {
    if (normalized.containerName === undefined) {
      normalized.containerName = null;
    }
    if (normalized.containerId === undefined) {
      normalized.containerId = null;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
