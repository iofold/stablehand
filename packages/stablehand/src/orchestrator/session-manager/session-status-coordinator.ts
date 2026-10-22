import {
  SandboxSessionStatusConflictError,
  type DatabaseRepository,
  type SandboxSessionActiveGeneration,
  type SandboxSessionLifecycleFence,
} from '../../database/repository.js';
import { assertTransition } from './session-status-machine.js';
import type { SessionStatePort } from './ports.js';
import type { Logger, SessionStatus } from './types.js';

interface StatusExtra {
  containerName?: string | null;
  containerId?: string | null;
  restoreAttempts?: number | null;
  lastRestoreError?: string | null;
}

export interface SessionStatusCoordinatorDeps {
  db: Pick<
    DatabaseRepository,
    | 'updateSandboxSessionMetadata'
    | 'completeSandboxSessionLifecycleOperation'
  >;
  logger: Logger;
  stateStore?: Pick<SessionStatePort, 'getSessionById'>;
  /**
   * Called after a session leaves its runtime behind (CHECKPOINTED or
   * TERMINATED), e.g. to revoke its gateway key. Fire-and-forget; the
   * callback owns its own error handling.
   */
  onRuntimeReleased?: (sessionId: string, toStatus: SessionStatus) => void;
}

export interface SessionStatusTransition {
  sessionId: string;
  fromStatus?: SessionStatus;
  toStatus: SessionStatus;
  extra?: StatusExtra;
  clearRuntime?: boolean;
  lifecycleOperation?: SandboxSessionLifecycleFence;
  expectedActiveGeneration?: SandboxSessionActiveGeneration;
}

export class StaleTransitionError extends Error {
  constructor(
    readonly sessionId: string,
    readonly expectedFrom: SessionStatus,
    readonly toStatus: SessionStatus,
  ) {
    super(`Stale status transition for session ${sessionId}: expected ${expectedFrom}, wanted ${toStatus}`);
    this.name = 'StaleTransitionError';
  }
}

export class StaleLifecycleOperationError extends Error {
  constructor(
    readonly sessionId: string,
    readonly toStatus: SessionStatus,
  ) {
    super(
      `Lost lifecycle ownership for session ${sessionId}; could not transition to ${toStatus}`,
    );
    this.name = 'StaleLifecycleOperationError';
  }
}

export class SessionStatusCoordinator {
  constructor(private readonly deps: SessionStatusCoordinatorDeps) {}

  async transition({
    sessionId,
    fromStatus,
    toStatus,
    extra,
    clearRuntime = false,
    lifecycleOperation,
    expectedActiveGeneration,
  }: SessionStatusTransition): Promise<void> {
    const record = this.deps.stateStore?.getSessionById(sessionId);
    const currentStatus = record?.status ?? fromStatus;

    if (!currentStatus) {
      throw new Error(`SessionStatusCoordinator requires fromStatus when session ${sessionId} is not cached`);
    }

    if (currentStatus === 'RESTORING' || toStatus === 'RESTORING') {
      throw new Error(
        `Session ${sessionId} RESTORING transitions require the restore-fenced repository methods`,
      );
    }

    if (currentStatus === toStatus && !extra && !clearRuntime) {
      this.deps.logger.debug(
        `[SessionStatusCoordinator] session ${sessionId}: ${currentStatus} unchanged`,
      );
      return;
    }

    if (currentStatus !== toStatus) {
      assertTransition(currentStatus, toStatus);
      if (!lifecycleOperation) {
        throw new Error(
          `Session ${sessionId} ${currentStatus} -> ${toStatus} requires its canonical fenced lifecycle owner`,
        );
      }
    }

    const normalizedExtra = normalizeStatusExtra(toStatus, extra, clearRuntime);

    try {
      if (lifecycleOperation) {
        const completed = await this.deps.db.completeSandboxSessionLifecycleOperation({
          sandboxSessionId: sessionId,
          ownerId: lifecycleOperation.ownerId,
          fenceToken: lifecycleOperation.fenceToken,
          fromStatus: currentStatus,
          toStatus,
          ...(normalizedExtra ? { extra: normalizedExtra } : {}),
        });
        if (!completed) {
          throw new StaleLifecycleOperationError(sessionId, toStatus);
        }
      } else if (normalizedExtra !== undefined) {
        if (currentStatus === 'ACTIVE' && !expectedActiveGeneration) {
          throw new Error(
            `Session ${sessionId} ACTIVE metadata requires its expected active generation`,
          );
        }
        await this.deps.db.updateSandboxSessionMetadata(
          sessionId,
          currentStatus,
          normalizedExtra,
          currentStatus === 'ACTIVE' ? expectedActiveGeneration : undefined,
        );
      }
    } catch (error) {
      if (error instanceof SandboxSessionStatusConflictError) {
        throw new StaleTransitionError(sessionId, currentStatus, toStatus);
      }
      throw error;
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

    if (
      currentStatus !== toStatus
      && (toStatus === 'CHECKPOINTED' || toStatus === 'TERMINATED')
    ) {
      this.deps.onRuntimeReleased?.(sessionId, toStatus);
    }
  }
}

function normalizeStatusExtra(
  toStatus: SessionStatus,
  extra: StatusExtra | undefined,
  clearRuntime: boolean,
): StatusExtra | undefined {
  const normalized: StatusExtra = extra ? { ...extra } : {};

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
