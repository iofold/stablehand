import { create } from '@bufbuild/protobuf';
import {
  KillSessionRequestSchema,
  SuspendSessionRequestSchema,
  type SessionCheckpoint,
} from '@ctxmill/proto/sandbox/v1';
import { resolve } from 'node:path';

import type { DatabaseRepository } from '../../database/repository.js';
import type { SandboxContainerManager } from '../../sandbox/container-manager.js';
import type { WorkspaceDiffService } from '../../sandbox/workspace-diff.js';
import { cleanupSession } from '../../workspace/session-workspace.js';
import type { AgentDefinition } from '../../types.js';
import type { ContainerLifecyclePolicy } from '../container-lifecycle-policy.js';
import { stopAndRemoveContainer } from '../container-cleanup.js';
import type { SessionReconciler } from './ports.js';
import { SessionRecoveryCoordinator } from './session-recovery-coordinator.js';
import { SessionStatusCoordinator } from './session-status-coordinator.js';
import type { SessionStateStore } from './session-state-store.js';
import type {
  Logger,
  SessionRecord,
} from './types.js';
import { dbSessionToRecord } from './types.js';

const TAG = '[SandboxSessionManager]';

export interface SuspendSessionOptions {
  allowActiveTurn?: boolean;
}

export interface RestoreSessionStart {
  sessionId: string;
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

export interface SessionLifecycleServiceDeps {
  stateStore: SessionStateStore;
  recoveryCoordinator: SessionRecoveryCoordinator;
  createFreshSession: (
    conversationId: string,
    agentDef: AgentDefinition,
    agentId?: string,
    options?: { concurrencyReservationId?: string },
  ) => Promise<SessionRecord>;
  db: Pick<
    DatabaseRepository,
    | 'createCheckpointV2'
    | 'getActiveSandboxSessions'
    | 'getSandboxSession'
    | 'getSandboxSessionByConversation'
    | 'getSandboxSessionsByAgent'
  >;
  statusCoordinator: SessionStatusCoordinator;
  containerManager: Pick<SandboxContainerManager, 'getContainer' | 'removeContainer' | 'stopContainer'>;
  lifecyclePolicy: Pick<ContainerLifecyclePolicy, 'cancelIdleTimeout'>;
  workspaceDiffService: WorkspaceDiffService;
  logger: Logger;
  parsePendingRequestPayload: (payloadJson: string) => Record<string, unknown>;
}

export class SessionLifecycleService {
  constructor(private readonly deps: SessionLifecycleServiceDeps) {}

  async ensureSession(
    conversationId: string,
    agentDef: AgentDefinition,
    agentId?: string,
    options?: { concurrencyReservationId?: string },
  ): Promise<SessionRecord> {
    return this.deps.stateStore.withConversationLock(conversationId, async () => {
      this.deps.stateStore.setAgentDef(conversationId, agentDef);

      const cached = this.deps.stateStore.getSessionByConversation(conversationId);
      if (cached && cached.status === 'ACTIVE') {
        return cached;
      }

      const dbSession = await this.deps.db.getSandboxSessionByConversation(conversationId);
      if (!dbSession) {
        const fresh = await this.deps.createFreshSession(conversationId, agentDef, agentId, options);
        this.deps.stateStore.setSession(conversationId, fresh);
        return fresh;
      }

      return this.deps.recoveryCoordinator.recoverOrReconnect(conversationId, agentDef, agentId, dbSession);
    });
  }

  getSessionReconciler(): SessionReconciler {
    return this.deps.recoveryCoordinator;
  }

  onSessionReconnected(conversationId: string, record: SessionRecord): void {
    this.deps.recoveryCoordinator.onSessionReconnected(conversationId, record);
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

      return { sessionId, status: 'RESTORING', restoreAttempts: 0 };
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

  async suspendSession(
    sessionId: string,
    reason: string,
    options: SuspendSessionOptions = {},
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

    const response = await record.grpcClient!.suspendSession(
      create(SuspendSessionRequestSchema, { sessionId, reason }),
    );

    const checkpoint = response.sessionCheckpoint;
    if (!checkpoint) {
      throw new Error(`SuspendSession response missing sessionCheckpoint for session ${sessionId}`);
    }

    const pendingRequests = (checkpoint.runnerState?.pendingRequests ?? []).map((request) => ({
      type: request.type,
      id: request.id,
      payload: this.deps.parsePendingRequestPayload(request.payloadJson),
    }));

    const workspaceRef = await this.deps.workspaceDiffService.capture(sessionId, record.containerId);
    this.deps.logger.info(`${TAG} workspace captured for session ${sessionId}: ${workspaceRef}`);

    await this.deps.db.createCheckpointV2({
      sessionId,
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
    });

    await this.deps.lifecyclePolicy.cancelIdleTimeout(sessionId);
    await this.cleanupRuntime(record, sessionId, false);

    await this.deps.statusCoordinator.transition({
      sessionId,
      fromStatus: record.status,
      toStatus: 'CHECKPOINTED',
      clearRuntime: true,
    });

    this.deps.stateStore.cleanupSession(sessionId, record.conversationId);
    this.deps.logger.info(`${TAG} session ${sessionId} suspended`);
    return checkpoint;
  }

  async killSession(sessionId: string): Promise<void> {
    const record = this.findSessionById(sessionId);
    this.deps.logger.info(`${TAG} killing session ${sessionId}`);

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

    await this.cleanupRuntime(record, sessionId, false);
    await this.deps.statusCoordinator.transition({
      sessionId,
      fromStatus: record?.status ?? 'ACTIVE',
      toStatus: 'TERMINATED',
      clearRuntime: true,
    });

    if (record) {
      this.deps.stateStore.cleanupSession(sessionId, record.conversationId);
    } else {
      this.deps.stateStore.deleteQueue(sessionId);
      this.deps.stateStore.markTurnInactive(sessionId);
    }

    this.deps.logger.info(`${TAG} session ${sessionId} killed`);
  }

  async getSession(conversationId: string): Promise<SessionRecord | null> {
    const cached = this.deps.stateStore.getSessionByConversation(conversationId);
    if (cached) {
      return cached;
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
