import { create } from '@bufbuild/protobuf';
import {
  KillSessionRequestSchema,
  SuspendSessionRequestSchema,
  type SessionCheckpoint,
} from '@ctxmill/proto/sandbox/v1';
import { resolve } from 'node:path';

import type { DatabaseRepository, SandboxSessionRow } from '../../database/repository.js';
import type { ContainerManager } from '../../sandbox/container-manager.js';
import type { WorkspaceDiffService } from '../../sandbox/workspace-diff.js';
import { cleanupSession } from '../../workspace/session-workspace.js';
import type { AgentDefinition } from '../../types.js';
import type { ContainerLifecyclePolicy } from '../container-lifecycle-policy.js';
import type { SessionReconciler } from './ports.js';
import { SessionRecoveryCoordinator } from './session-recovery-coordinator.js';
import type { SessionStateStore } from './session-state-store.js';
import type {
  Logger,
  SessionRecord,
} from './types.js';

const TAG = '[SandboxSessionManager]';

export interface SessionLifecycleServiceDeps {
  stateStore: SessionStateStore;
  recoveryCoordinator: SessionRecoveryCoordinator;
  createFreshSession: (
    conversationId: string,
    agentDef: AgentDefinition,
    agentId?: string,
  ) => Promise<SessionRecord>;
  db: Pick<
    DatabaseRepository,
    | 'createCheckpointV2'
    | 'getActiveSandboxSessions'
    | 'getSandboxSessionByConversation'
    | 'getSandboxSessionsByAgent'
    | 'updateSandboxSessionStatus'
  >;
  containerManager: Pick<ContainerManager, 'removeContainer' | 'stopContainer'>;
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
  ): Promise<SessionRecord> {
    return this.deps.stateStore.withConversationLock(conversationId, async () => {
      this.deps.stateStore.setAgentDef(conversationId, agentDef);

      const cached = this.deps.stateStore.getSessionByConversation(conversationId);
      if (cached && cached.status === 'ACTIVE') {
        return cached;
      }

      const dbSession = await this.deps.db.getSandboxSessionByConversation(conversationId);
      if (!dbSession) {
        const fresh = await this.deps.createFreshSession(conversationId, agentDef, agentId);
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

  async onSessionEvicted(sessionId: string, conversationId: string): Promise<void> {
    await this.deps.recoveryCoordinator.onSessionEvicted(sessionId, conversationId);
  }

  findSessionById(sessionId: string): SessionRecord | undefined {
    return this.deps.stateStore.getSessionById(sessionId);
  }

  async suspendSession(sessionId: string, reason: string): Promise<SessionCheckpoint> {
    const record = this.findSessionById(sessionId);
    if (!record) {
      throw new Error(`Session ${sessionId} not found in active sessions`);
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

    let workspaceRef = 'none';
    try {
      workspaceRef = await this.deps.workspaceDiffService.capture(sessionId, record.containerId);
      this.deps.logger.info(`${TAG} workspace captured for session ${sessionId}: ${workspaceRef}`);
    } catch (err) {
      this.deps.logger.warn(
        `${TAG} workspace capture failed for session ${sessionId}, continuing without workspace snapshot:`,
        err,
      );
    }

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

    await this.deps.db.updateSandboxSessionStatus(sessionId, 'CHECKPOINTED');
    record.status = 'CHECKPOINTED';

    await this.deps.lifecyclePolicy.cancelIdleTimeout(sessionId);
    await this.cleanupRuntime(record, sessionId, false);

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
    await this.deps.db.updateSandboxSessionStatus(sessionId, 'TERMINATED');

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
    return dbSession ? this.dbSessionToRecord(dbSession) : null;
  }

  async getActiveSessions(): Promise<SessionRecord[]> {
    const rows = await this.deps.db.getActiveSandboxSessions();
    return rows.map((row) => this.dbSessionToRecord(row));
  }

  async getSessionsByAgent(agentId: string): Promise<SessionRecord[]> {
    const rows = await this.deps.db.getSandboxSessionsByAgent(agentId);
    return rows.map((row) => this.dbSessionToRecord(row));
  }

  private async cleanupRuntime(
    record: SessionRecord | undefined,
    sessionId: string,
    cleanupWorkspace: boolean,
  ): Promise<void> {
    if (record?.containerId) {
      try {
        await this.deps.containerManager.stopContainer(record.containerId, 10);
        await this.deps.containerManager.removeContainer(record.containerId, true);
      } catch (err) {
        this.deps.logger.warn(`${TAG} container cleanup failed for session ${sessionId}:`, err);
      }
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

  private dbSessionToRecord(row: SandboxSessionRow): SessionRecord {
    return {
      sessionId: row.id,
      conversationId: row.conversationId,
      agentId: row.agentId,
      containerName: row.containerName ?? '',
      containerId: row.containerId ?? '',
      status: (row.status as SessionRecord['status']) ?? 'ACTIVE',
      harnessName: row.harnessName,
    };
  }
}
