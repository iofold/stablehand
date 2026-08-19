import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  KillSessionRequestSchema,
  SuspendSessionRequestSchema,
  type SessionCheckpoint,
} from '@ctxmill/proto/sandbox/v1';
import { resolve } from 'node:path';

import {
  LiveSandboxSessionConflictError,
  type DatabaseRepository,
} from '../../database/repository.js';
import type { SandboxContainerManager } from '../../sandbox/container-manager.js';
import type { WorkspaceDiffService } from '../../sandbox/workspace-diff.js';
import { cleanupSession } from '../../workspace/session-workspace.js';
import type { AgentDefinition } from '@ctxmill/sandbox-daemon';
import type { ContainerLifecyclePolicy } from '../container-lifecycle-policy.js';
import { stopAndRemoveContainer } from '../container-cleanup.js';
import {
  hasStatusCode,
  statusCodeError,
} from '../../util/status-code-error.js';
import {
  acquireSandboxSessionLifecycleOperation,
  type SandboxSessionLifecycleOperationGuard,
} from '../sandbox-session-lifecycle-operation.js';
import type { TurnDeliveryFence } from '../turn-delivery-fence.js';
import type {
  SessionReconnectionRegistration,
  SessionReconciler,
} from './ports.js';
import { acquireSandboxSessionRestoreLease } from '../sandbox-session-restore-lease.js';
import { SessionRecoveryCoordinator } from './session-recovery-coordinator.js';
import { SessionStatusCoordinator } from './session-status-coordinator.js';
import type { SessionStateStore } from './session-state-store.js';
import type {
  Logger,
  SessionEnsureOptions,
  SessionRecord,
} from './types.js';
import { dbSessionToRecord } from './types.js';
import {
  performanceInstrumentation,
  type PerformanceRecorder,
} from '../../observability/performance.js';

const TAG = '[SandboxSessionManager]';

export interface SuspendSessionOptions {
  allowActiveTurn?: boolean;
  allowedTurnDelivery?: {
    turnId: string;
    fence: TurnDeliveryFence;
  };
  lifecycleOperation?: SandboxSessionLifecycleOperationGuard;
}

export interface KillSessionOptions {
  allowedTurnDelivery?: {
    turnId: string;
    fence: TurnDeliveryFence;
  };
  lifecycleOperation?: SandboxSessionLifecycleOperationGuard;
}

export interface RestoreSessionStart {
  sandboxSessionId: string;
  status: 'RESTORING';
  restoreAttempts: 0;
}

export interface RestoreSessionOptions {
  background?: boolean;
}

export class ActiveTurnSuspendError extends Error {
  readonly sessionId: string;
  readonly turnId: string;

  constructor(sessionId: string, turnId: string) {
    super(`Cannot suspend session ${sessionId} while turn ${turnId} is active`);
    this.name = 'ActiveTurnSuspendError';
    this.sessionId = sessionId;
    this.turnId = turnId;
  }
}

export class SandboxSessionNotFoundError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Sandbox session ${sessionId} not found`);
    this.name = 'SandboxSessionNotFoundError';
    this.sessionId = sessionId;
  }
}

export class RestoreConflictError extends Error {
  readonly sessionId: string;
  readonly status: string;

  constructor(sessionId: string, status: string) {
    super(`Sandbox session ${sessionId} is ${status}, not CHECKPOINTED`);
    this.name = 'RestoreConflictError';
    this.sessionId = sessionId;
    this.status = status;
  }
}

export class SandboxSessionLifecycleConflictError extends Error {
  constructor(
    readonly sessionId: string,
    readonly operation: 'checkpoint' | 'terminate' | 'reset',
  ) {
    super(
      `Sandbox session ${sessionId} cannot begin ${operation}; ` +
      'another turn or lifecycle worker owns it',
    );
    this.name = 'SandboxSessionLifecycleConflictError';
  }
}

export interface SessionLifecycleServiceDeps {
  stateStore: SessionStateStore;
  recoveryCoordinator: SessionRecoveryCoordinator;
  createFreshSession: (
    conversationId: string,
    agentDef: AgentDefinition,
    agentId?: string,
    options?: {
      concurrencyReservationId?: string;
      runtimeDefinitionHash?: string;
    },
  ) => Promise<SessionRecord>;
  resolveRuntimeDefinitionHash: (
    agentId: string,
    agentDef: AgentDefinition,
  ) => Promise<string>;
  db: Pick<
    DatabaseRepository,
    | 'createCheckpointV2'
    | 'getActiveSandboxSessions'
    | 'getSandboxSession'
    | 'getSandboxSessionByConversation'
    | 'getLiveSandboxSessionByConversation'
    | 'getSandboxSessionsByAgent'
    | 'claimSandboxSessionLifecycleOperation'
    | 'renewSandboxSessionLifecycleOperation'
    | 'markSandboxSessionLifecycleOperationExecuting'
    | 'cancelSandboxSessionLifecycleOperation'
    | 'claimSandboxSessionRestore'
    | 'renewSandboxSessionRestoreLease'
    | 'completeSandboxSessionRestore'
    | 'failSandboxSessionRestore'
  >;
  statusCoordinator: SessionStatusCoordinator;
  containerManager: Pick<SandboxContainerManager, 'getContainer' | 'removeContainer' | 'stopContainer'>;
  lifecyclePolicy: Pick<ContainerLifecyclePolicy, 'cancelIdleTimeout'>;
  workspaceDiffService: WorkspaceDiffService;
  logger: Logger;
  parsePendingRequestPayload: (payloadJson: string) => Record<string, unknown>;
  performance?: PerformanceRecorder;
}

export class SessionLifecycleService {
  constructor(private readonly deps: SessionLifecycleServiceDeps) {}

  async ensureSession(
    conversationId: string,
    agentDef: AgentDefinition,
    agentId?: string,
    options?: SessionEnsureOptions,
  ): Promise<SessionRecord> {
    return this.deps.stateStore.withConversationLock(conversationId, async () => {
      this.deps.stateStore.setAgentDef(conversationId, agentDef);
      const effectiveAgentId = agentId ?? agentDef.name;
      const runtimeDefinitionHash = options?.runtimeDefinitionHash
        ?? await this.deps.resolveRuntimeDefinitionHash(
          effectiveAgentId,
          agentDef,
        );
      const freshOptions = {
        ...(options?.concurrencyReservationId
          ? {
              concurrencyReservationId:
                options.concurrencyReservationId,
            }
          : {}),
        runtimeDefinitionHash,
      };
      const createFreshOrJoinLive = async (): Promise<SessionRecord> => {
        try {
          const fresh = await this.deps.createFreshSession(
            conversationId,
            agentDef,
            effectiveAgentId,
            freshOptions,
          );
          this.deps.stateStore.setSession(conversationId, fresh);
          return fresh;
        } catch (error) {
          if (!(error instanceof LiveSandboxSessionConflictError)) {
            throw error;
          }

          const winner =
            await this.deps.db.getLiveSandboxSessionByConversation(
              conversationId,
            );
          if (!winner) {
            throw error;
          }
          if (
            (winner.runtimeDefinitionHash ?? '')
            !== runtimeDefinitionHash
          ) {
            throw new Error(
              `Concurrent sandbox session ${winner.id} uses an incompatible runtime definition`,
              { cause: error },
            );
          }
          return this.deps.recoveryCoordinator.recoverOrReconnect(
            conversationId,
            agentDef,
            effectiveAgentId,
            winner,
            options?.recoveryAuthority,
          );
        }
      };

      const cached = this.deps.stateStore.getSessionByConversation(conversationId);
      if (
        cached
        && cached.status === 'ACTIVE'
        && !options?.recoveryAuthority
      ) {
        const persisted = await this.deps.db.getSandboxSession(
          cached.sessionId,
        );
        if (
          persisted?.status === 'ACTIVE'
          && persisted.restoreFenceToken === cached.restoreFenceToken
          && persisted.containerId === cached.containerId
        ) {
          if (
            (persisted.runtimeDefinitionHash ?? '')
            === runtimeDefinitionHash
          ) {
            return cached;
          }
          if (this.deps.stateStore.getActiveTurnId(cached.sessionId)) {
            throw new Error(
              `Sandbox session ${cached.sessionId} runtime definition changed during an active turn; retry after it drains`,
            );
          }
          await this.terminateSession(cached.sessionId, 'reset', {});
          return createFreshOrJoinLive();
        }
        this.deps.stateStore.deleteSession(conversationId);
        this.deps.logger.info(
          `[SessionLifecycleService] discarded stale cached generation for ` +
          `sandbox session ${cached.sessionId}`,
        );
      }

      const dbSession = await this.deps.db.getSandboxSessionByConversation(conversationId);
      if (!dbSession) {
        return createFreshOrJoinLive();
      }

      if (
        (dbSession.runtimeDefinitionHash ?? '')
        !== runtimeDefinitionHash
      ) {
        this.deps.logger.info(
          `${TAG} replacing sandbox session ${dbSession.id}: runtime definition changed`,
        );
        if (dbSession.status === 'ACTIVE') {
          if (this.deps.stateStore.getActiveTurnId(dbSession.id)) {
            throw new Error(
              `Sandbox session ${dbSession.id} runtime definition changed during an active turn; retry after it drains`,
            );
          }
          await this.terminateSession(dbSession.id, 'reset', {});
          return createFreshOrJoinLive();
        }
        if (
          dbSession.status === 'CHECKPOINTED'
          || dbSession.status === 'TERMINATED'
        ) {
          return createFreshOrJoinLive();
        }

        const recovered =
          await this.deps.recoveryCoordinator.recoverOrReconnect(
            conversationId,
            agentDef,
            effectiveAgentId,
            dbSession,
            options?.recoveryAuthority,
          );
        if (
          (recovered.runtimeDefinitionHash ?? '')
          === runtimeDefinitionHash
        ) {
          return recovered;
        }
        await this.terminateSession(recovered.sessionId, 'reset', {});
        return createFreshOrJoinLive();
      }

      return this.deps.recoveryCoordinator.recoverOrReconnect(
        conversationId,
        agentDef,
        effectiveAgentId,
        dbSession,
        options?.recoveryAuthority,
      );
    });
  }

  getSessionReconciler(): SessionReconciler {
    return this.deps.recoveryCoordinator;
  }

  onSessionReconnected(
    conversationId: string,
    record: SessionRecord,
  ): SessionReconnectionRegistration {
    return this.deps.recoveryCoordinator.onSessionReconnected(
      conversationId,
      record,
    );
  }

  async restoreSession(
    sessionId: string,
    agentDef: AgentDefinition,
    agentId?: string,
  ): Promise<SessionRecord>;
  async restoreSession(
    sessionId: string,
    agentDef: AgentDefinition,
    agentId: string | undefined,
    options: { background: true },
  ): Promise<RestoreSessionStart>;
  async restoreSession(
    sessionId: string,
    agentDef: AgentDefinition,
    agentId?: string,
    options: RestoreSessionOptions = {},
  ): Promise<SessionRecord | RestoreSessionStart> {
    const initial = await this.deps.db.getSandboxSession(sessionId);
    if (!initial) {
      throw new SandboxSessionNotFoundError(sessionId);
    }

    return this.deps.stateStore.withConversationLock(initial.conversationId, async () => {
      this.deps.stateStore.setAgentDef(initial.conversationId, agentDef);

      const current = await this.deps.db.getSandboxSession(sessionId);
      if (!current) {
        throw new SandboxSessionNotFoundError(sessionId);
      }

      if (current.status !== 'CHECKPOINTED') {
        throw new RestoreConflictError(sessionId, current.status);
      }

      await this.deps.statusCoordinator.transition({
        sessionId,
        fromStatus: 'CHECKPOINTED',
        toStatus: 'CHECKPOINTED',
        extra: { restoreAttempts: 0, lastRestoreError: null },
      });

      const recovery = this.deps.recoveryCoordinator.recoverOrReconnect(
        current.conversationId,
        agentDef,
        agentId ?? current.agentId,
        { ...current, restoreAttempts: 0, lastRestoreError: null },
      );

      if (!options.background) {
        return recovery;
      }

      void recovery.catch((err: unknown) => {
        this.deps.logger.warn(
          `${TAG} background restore failed for session ${sessionId}:`,
          err,
        );
      });

      return { sandboxSessionId: sessionId, status: 'RESTORING', restoreAttempts: 0 };
    });
  }

  async onSessionEvicted(sessionId: string, conversationId: string): Promise<void> {
    await this.deps.recoveryCoordinator.onSessionEvicted(sessionId, conversationId);
  }

  findSessionById(sessionId: string): SessionRecord | undefined {
    return this.deps.stateStore.getSessionById(sessionId);
  }

  getActiveTurnId(sessionId: string): string | undefined {
    return this.deps.stateStore.getActiveTurnId(sessionId);
  }

  private async acquireLifecycleOperation(
    sessionId: string,
    operation: 'checkpoint' | 'terminate' | 'reset',
    existing: SandboxSessionLifecycleOperationGuard | undefined,
    allowedTurnDelivery: {
      turnId: string;
      fence: TurnDeliveryFence;
    } | undefined,
  ): Promise<SandboxSessionLifecycleOperationGuard> {
    let guard = existing;
    if (!guard) {
      const observedSession = await this.deps.db.getSandboxSession(sessionId);
      const cachedSession = this.deps.stateStore.getSessionById(sessionId);
      if (
        !observedSession
        || observedSession.status !== 'ACTIVE'
        || (
          cachedSession
          && cachedSession.containerId !== observedSession.containerId
        )
      ) {
        throw new SandboxSessionLifecycleConflictError(sessionId, operation);
      }
      guard = await acquireSandboxSessionLifecycleOperation(
        { db: this.deps.db, logger: this.deps.logger },
        sessionId,
        operation,
        {
          expectedActiveGeneration: {
            restoreFenceToken: observedSession.restoreFenceToken,
            containerId: observedSession.containerId,
          },
          ...(allowedTurnDelivery ? { allowedTurnDelivery } : {}),
        },
      );
    }
    if (!guard) {
      throw new SandboxSessionLifecycleConflictError(sessionId, operation);
    }
    if (guard.operation !== operation) {
      await guard.stop();
      throw new SandboxSessionLifecycleConflictError(sessionId, operation);
    }
    return guard;
  }

  async suspendSession(
    sessionId: string,
    reason: string,
    options: SuspendSessionOptions = {},
  ): Promise<SessionCheckpoint> {
    return (this.deps.performance ?? performanceInstrumentation).measure(
      'checkpoint.suspend',
      {
        'ctxmill.session.id': sessionId,
        'ctxmill.checkpoint.reason': reason,
      },
      () => this.suspendSessionMeasured(sessionId, reason, options),
    );
  }

  private async suspendSessionMeasured(
    sessionId: string,
    reason: string,
    options: SuspendSessionOptions,
  ): Promise<SessionCheckpoint> {
    const record = this.findSessionById(sessionId);
    if (!record) {
      throw new Error(`Session ${sessionId} not found in active sessions`);
    }

    const activeTurnId = this.deps.stateStore.getActiveTurnId(sessionId);
    if (activeTurnId && !options.allowActiveTurn) {
      throw new ActiveTurnSuspendError(sessionId, activeTurnId);
    }

    this.deps.logger.info(`${TAG} suspending session ${sessionId} (reason=${reason})`);
    const lifecycleOperation = await this.acquireLifecycleOperation(
      sessionId,
      'checkpoint',
      options.lifecycleOperation,
      options.allowedTurnDelivery,
    );
    const executing = await lifecycleOperation.markExecuting();
    if (!executing) {
      await lifecycleOperation.cancel();
      throw new SandboxSessionLifecycleConflictError(sessionId, 'checkpoint');
    }

    try {
      lifecycleOperation.signal.throwIfAborted();
      let response;
      try {
        response = await record.grpcClient!.suspendSession(
          create(SuspendSessionRequestSchema, { sessionId, reason }),
        );
      } catch (error) {
        const missingSandboxSession = hasStatusCode(error, 404)
          || (error instanceof ConnectError && error.code === Code.NotFound);
        if (!missingSandboxSession) {
          throw error;
        }

        lifecycleOperation.signal.throwIfAborted();
        const runtimeRecord = { ...record };
        await this.deps.lifecyclePolicy.cancelIdleTimeout(sessionId);
        await this.deps.statusCoordinator.transition({
          sessionId,
          fromStatus: record.status,
          toStatus: 'TERMINATED',
          clearRuntime: true,
          lifecycleOperation: lifecycleOperation.fence,
        });
        this.deps.stateStore.cleanupSession(sessionId, record.conversationId);
        await this.cleanupRuntime(runtimeRecord, sessionId, false);
        this.deps.logger.warn(
          `${TAG} sandbox session ${sessionId} disappeared during checkpoint; ` +
          'completed lifecycle as TERMINATED',
        );
        throw statusCodeError(
          404,
          `Sandbox session ${sessionId} disappeared during checkpoint`,
        );
      }

      const checkpoint = response.sessionCheckpoint;
      if (!checkpoint) {
        throw new Error(`SuspendSession response missing sessionCheckpoint for session ${sessionId}`);
      }

      const pendingRequests = (checkpoint.runnerState?.pendingRequests ?? []).map((request) => ({
        type: request.type,
        id: request.id,
        payload: this.deps.parsePendingRequestPayload(request.payloadJson),
      }));

      lifecycleOperation.signal.throwIfAborted();
      const workspaceRef = await this.deps.workspaceDiffService.capture(
        sessionId,
        record.containerId,
      );
      this.deps.logger.info(`${TAG} workspace captured for session ${sessionId}: ${workspaceRef}`);
      lifecycleOperation.signal.throwIfAborted();

      const persistedCheckpoint = await this.deps.db.createCheckpointV2({
        sandboxSessionId: sessionId,
        agentId: record.agentId,
        checkpointData: {
          harnessName: record.harnessName,
          conversationId: record.conversationId,
          checkpointVersion: checkpoint.checkpointVersion,
          sessionId: checkpoint.sessionId,
          cursor: checkpoint.cursor,
          runnerState: {
            status: checkpoint.runnerState?.status ?? 'IDLE',
            pendingRequests,
          },
        },
        harnessState: checkpoint.harnessState as Record<string, unknown> | undefined,
        workspaceRef,
        suspendReason: reason,
      }, lifecycleOperation.fence);
      if (!persistedCheckpoint) {
        throw new SandboxSessionLifecycleConflictError(
          sessionId,
          'checkpoint',
        );
      }
      lifecycleOperation.signal.throwIfAborted();

      await this.deps.lifecyclePolicy.cancelIdleTimeout(sessionId);
      await this.cleanupRuntime(record, sessionId, false);

      lifecycleOperation.signal.throwIfAborted();
      await this.deps.statusCoordinator.transition({
        sessionId,
        fromStatus: record.status,
        toStatus: 'CHECKPOINTED',
        clearRuntime: true,
        lifecycleOperation: lifecycleOperation.fence,
      });

      this.deps.stateStore.cleanupSession(sessionId, record.conversationId);
      this.deps.logger.info(`${TAG} session ${sessionId} suspended`);
      return checkpoint;
    } finally {
      await lifecycleOperation.stop();
    }
  }

  async killSession(
    sessionId: string,
    options: KillSessionOptions = {},
  ): Promise<void> {
    await this.terminateSession(
      sessionId,
      options.lifecycleOperation ? 'reset' : 'terminate',
      options,
    );
  }

  async reserveSessionReset(
    sessionId: string,
    turnId: string,
    fence: TurnDeliveryFence,
  ): Promise<SandboxSessionLifecycleOperationGuard | undefined> {
    try {
      return await this.acquireLifecycleOperation(
        sessionId,
        'reset',
        undefined,
        { turnId, fence },
      );
    } catch (err) {
      if (err instanceof SandboxSessionLifecycleConflictError) {
        return undefined;
      }
      throw err;
    }
  }

  async executeReservedSessionReset(
    sessionId: string,
    lifecycleOperation: SandboxSessionLifecycleOperationGuard,
  ): Promise<void> {
    await this.terminateSession(sessionId, 'reset', { lifecycleOperation });
  }

  async resetSession(sessionId: string): Promise<void> {
    await this.terminateSession(sessionId, 'reset', {});
  }

  /**
   * ctx-cn9c: terminate a CHECKPOINTED session under the restore fence. A kill
   * must never be blocked by restore-attempt exhaustion (that is exactly when
   * killing a poisoned session matters), so the claim runs with an unbounded
   * attempt budget. No live restore owner -> the same conflict error the ACTIVE
   * path throws.
   */
  private async terminateCheckpointedSession(sessionId: string): Promise<void> {
    let lease;
    try {
      lease = await acquireSandboxSessionRestoreLease(
        { db: this.deps.db, logger: this.deps.logger },
        sessionId,
        Number.MAX_SAFE_INTEGER,
      );
    } catch (err) {
      if (err instanceof LiveSandboxSessionConflictError) {
        throw new SandboxSessionLifecycleConflictError(sessionId, 'terminate');
      }
      throw err;
    }
    if (!lease) {
      throw new SandboxSessionLifecycleConflictError(sessionId, 'terminate');
    }
    try {
      await this.deps.lifecyclePolicy.cancelIdleTimeout(sessionId);
      // Sets status=TERMINATED and clears container_id/container_name under the
      // fence, satisfying "clear session runtime resources" for free.
      await lease.fail('TERMINATED', 'killed by api request');
      this.deps.stateStore.deleteQueue(sessionId);
      this.deps.stateStore.markTurnInactive(sessionId);
      this.deps.logger.info(`${TAG} checkpointed session ${sessionId} killed`);
    } finally {
      await lease.stop();
    }
  }

  private async terminateSession(
    sessionId: string,
    operation: 'terminate' | 'reset',
    options: KillSessionOptions,
  ): Promise<void> {
    const record = this.findSessionById(sessionId);
    if (!record) {
      const persisted = await this.deps.db.getSandboxSession(sessionId);
      if (!persisted || persisted.status === 'TERMINATED') {
        return;
      }
      // ctx-cn9c: a CHECKPOINTED session has no ACTIVE lifecycle owner to
      // acquire, so the normal terminate path can never mint one and 500s
      // ("owned by another worker") though nothing owns it. The state machine
      // permits CHECKPOINTED -> TERMINATED; use the restore lease — the
      // canonical fenced owner of CHECKPOINTED transitions — to reach it.
      if (persisted.status === 'CHECKPOINTED') {
        return await this.terminateCheckpointedSession(sessionId);
      }
    }
    this.deps.logger.info(`${TAG} killing session ${sessionId}`);

    const lifecycleOperation = await this.acquireLifecycleOperation(
      sessionId,
      operation,
      options.lifecycleOperation,
      options.allowedTurnDelivery,
    );
    const executing = await lifecycleOperation.markExecuting();
    if (!executing) {
      try {
        await lifecycleOperation.cancel();
      } finally {
        await lifecycleOperation.stop();
      }
      throw new SandboxSessionLifecycleConflictError(
        sessionId,
        operation,
      );
    }

    try {
      await this.deps.lifecyclePolicy.cancelIdleTimeout(sessionId);

      if (record?.grpcClient) {
        try {
          await record.grpcClient.killSession(
            create(KillSessionRequestSchema, { sessionId, reason: 'killed' }),
          );
        } catch (err) {
          this.deps.logger.warn(`${TAG} KillSession RPC failed for session ${sessionId}:`, err);
        }
      }

      lifecycleOperation.signal.throwIfAborted();
      await this.cleanupRuntime(record, sessionId, false);
      lifecycleOperation.signal.throwIfAborted();
      await this.deps.statusCoordinator.transition({
        sessionId,
        fromStatus: record?.status ?? 'ACTIVE',
        toStatus: 'TERMINATED',
        clearRuntime: true,
        lifecycleOperation: lifecycleOperation.fence,
      });

      if (record) {
        this.deps.stateStore.cleanupSession(sessionId, record.conversationId);
      } else {
        this.deps.stateStore.deleteQueue(sessionId);
        this.deps.stateStore.markTurnInactive(sessionId);
      }

      this.deps.logger.info(`${TAG} session ${sessionId} killed`);
    } finally {
      await lifecycleOperation.stop();
    }
  }

  async getSession(conversationId: string): Promise<SessionRecord | null> {
    const cached = this.deps.stateStore.getSessionByConversation(conversationId);
    if (cached) {
      const persisted = await this.deps.db.getSandboxSession(cached.sessionId);
      if (
        persisted?.status === 'ACTIVE'
        && persisted.restoreFenceToken === cached.restoreFenceToken
        && persisted.containerId === cached.containerId
      ) {
        return cached;
      }
      this.deps.stateStore.deleteSession(conversationId);
    }

    const dbSession = await this.deps.db.getSandboxSessionByConversation(conversationId);
    return dbSession ? dbSessionToRecord(dbSession) : null;
  }

  async getActiveSessions(): Promise<SessionRecord[]> {
    const rows = await this.deps.db.getActiveSandboxSessions();
    return rows.map((row) => dbSessionToRecord(row));
  }

  async getSessionsByAgent(agentId: string): Promise<SessionRecord[]> {
    const rows = await this.deps.db.getSandboxSessionsByAgent(agentId);
    return rows.map((row) => dbSessionToRecord(row));
  }

  private async cleanupRuntime(
    record: SessionRecord | undefined,
    sessionId: string,
    cleanupWorkspace: boolean,
  ): Promise<void> {
    const runtimeContainer = record?.containerId
      ? { containerId: record.containerId }
      : await this.deps.containerManager.getContainer(sessionId);

    if (runtimeContainer?.containerId) {
      await stopAndRemoveContainer(
        this.deps.containerManager,
        runtimeContainer.containerId,
        this.deps.logger,
        `${TAG} cleanup for session ${sessionId}`,
        10,
      );
    }

    if (!cleanupWorkspace || !record?.sessionWorkspaceDir) {
      return;
    }

    try {
      const sessionDir = resolve(record.sessionWorkspaceDir, '..');
      await cleanupSession(sessionDir);
      this.deps.logger.debug(`${TAG} cleaned up session workspace for ${sessionId}`);
    } catch (err) {
      this.deps.logger.warn(`${TAG} session workspace cleanup failed for ${sessionId}:`, err);
    }
  }

}
