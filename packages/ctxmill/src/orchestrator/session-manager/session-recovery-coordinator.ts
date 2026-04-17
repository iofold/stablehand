import { create } from '@bufbuild/protobuf';
import type { JsonObject } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  OpenSessionRequestSchema,
  ToolMetadataSchema,
} from '@ctxmill/proto/sandbox/v1';
import { createHash } from 'node:crypto';

import type { ContainerInfo, ContainerManager } from '../../sandbox/container-manager.js';
import { WorkspaceDiffService } from '../../sandbox/workspace-diff.js';
import type { DatabaseRepository, SandboxSessionRow } from '../../database/repository.js';
import type { AgentDefinition } from '../../types.js';
import type { SessionReconciler, SessionStatePort } from './ports.js';
import {
  retryGrpcCall,
  waitForContainerReady,
} from './grpc-session-client.js';
import { SessionStatusCoordinator } from './session-status-coordinator.js';
import type {
  HarnessGrpcClient,
  Logger,
  SessionRecord,
  ToolMetadata,
} from './types.js';

const TAG = '[SandboxSessionManager]';
const GRPC_PORT = 50051;

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function sessionContainerName(conversationId: string): string {
  return `ctxmill-session-${shortHash(conversationId)}`;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === 'string');
  return strings.length > 0 ? strings : undefined;
}

export interface SessionRecoveryCoordinatorDeps {
  containerManager: Pick<ContainerManager, 'createContainer' | 'startContainer' | 'stopContainer' | 'removeContainer'>;
  db: Pick<DatabaseRepository, 'getCheckpointV2'>;
  statusCoordinator: SessionStatusCoordinator;
  stateStore: SessionStatePort;
  buildSandboxSecrets: (agentId: string) => Readonly<Record<string, string>>;
  resolveToolsForAgent: (toolNames: string[], excludeBuiltins?: string[]) => ToolMetadata[];
  workspaceDiffService: WorkspaceDiffService;
  logger: Logger;
  createFreshSession: (
    conversationId: string,
    agentDef: AgentDefinition,
    agentId?: string,
  ) => Promise<SessionRecord>;
  getExistingSessionWorkspaceDir: (agentId: string, sessionId: string) => Promise<string | undefined>;
}

export class SessionRecoveryCoordinator implements SessionReconciler {
  private readonly activeRecoveries = new Map<string, Promise<SessionRecord>>();

  constructor(private readonly deps: SessionRecoveryCoordinatorDeps) {}

  async recoverOrReconnect(
    conversationId: string,
    agentDef: AgentDefinition,
    agentId: string | undefined,
    dbSession: SandboxSessionRow,
  ): Promise<SessionRecord> {
    const existing = this.activeRecoveries.get(conversationId);
    if (existing) {
      return existing;
    }

    const recovery = this.doRecover(conversationId, agentDef, agentId, dbSession);
    this.activeRecoveries.set(conversationId, recovery);

    try {
      const record = await recovery;
      this.deps.stateStore.setSession(conversationId, record);
      return record;
    } finally {
      if (this.activeRecoveries.get(conversationId) === recovery) {
        this.activeRecoveries.delete(conversationId);
      }
    }
  }

  public onSessionReconnected(session: SandboxSessionRow, grpcClient?: HarnessGrpcClient): void;
  public onSessionReconnected(conversationId: string, record: SessionRecord): void;
  public onSessionReconnected(
    sessionOrConversationId: SandboxSessionRow | string,
    grpcClientOrRecord?: HarnessGrpcClient | SessionRecord,
  ): void {
    if (typeof sessionOrConversationId === 'string') {
      if (!this.isSessionRecord(grpcClientOrRecord)) {
        throw new Error('onSessionReconnected requires a SessionRecord when called with a conversationId');
      }
       this.deps.stateStore.setSession(sessionOrConversationId, grpcClientOrRecord);
       return;
     }

    const record = this.dbSessionToRecord(
      sessionOrConversationId,
      this.isSessionRecord(grpcClientOrRecord) ? undefined : grpcClientOrRecord,
    );
    this.deps.stateStore.setSession(sessionOrConversationId.conversationId, record);
  }

  async onSessionEvicted(sessionId: string, conversationId: string): Promise<void> {
    await this.deps.stateStore.withConversationLock(conversationId, async () => {
      if (this.deps.stateStore.isActiveTurn(sessionId)) {
        this.deps.logger.warn(
          `${TAG} skipping eviction of session ${sessionId}: turn still active, reconciliation will retry`,
        );
        return;
      }

      this.deps.stateStore.cleanupSession(sessionId, conversationId);
    });
  }

  async reconnectToContainer(dbSession: SandboxSessionRow): Promise<SessionRecord> {
    const containerName = dbSession.containerName ?? sessionContainerName(dbSession.conversationId);
    const baseUrl = `http://${containerName}:${GRPC_PORT}`;

    this.deps.logger.info(
      `${TAG} reconnecting to container ${containerName} for session ${dbSession.id}`,
    );

    const { grpcClient } = await waitForContainerReady(baseUrl);
    const sessionWorkspaceDir = await this.deps.getExistingSessionWorkspaceDir(dbSession.agentId, dbSession.id);

    return {
      sessionId: dbSession.id,
      conversationId: dbSession.conversationId,
      agentId: dbSession.agentId,
      containerName,
      containerId: dbSession.containerId ?? '',
      status: 'ACTIVE',
      harnessName: dbSession.harnessName,
      grpcClient,
      sessionWorkspaceDir,
    };
  }

  async restoreFromCheckpoint(
    dbSession: SandboxSessionRow,
    agentDef: AgentDefinition,
  ): Promise<SessionRecord> {
    const harnessName = dbSession.harnessName;
    const sessionId = dbSession.id;

    this.deps.logger.info(`${TAG} restoring session ${sessionId} from checkpoint`);
    await this.deps.statusCoordinator.transition({
      sessionId,
      fromStatus: dbSession.status as SessionRecord['status'],
      toStatus: 'RESTORING',
    });

    let createdContainer: ContainerInfo | undefined;

    try {
      const checkpoint = await this.deps.db.getCheckpointV2(sessionId);
      if (!checkpoint) {
        throw new Error(`No checkpoint found for session ${sessionId}`);
      }

      const sessionWorkspaceDir = agentDef.workspaceDir
        ? await this.deps.getExistingSessionWorkspaceDir(dbSession.agentId, sessionId)
        : undefined;
      if (agentDef.workspaceDir && !sessionWorkspaceDir) {
        throw new Error(
          `Missing persisted session workspace for checkpointed session ${sessionId}`,
        );
      }

      const workspaceDir = sessionWorkspaceDir ?? agentDef.workspaceDir;
      const sandboxSecrets = this.deps.buildSandboxSecrets(dbSession.agentId);
      const secretKeys = Object.keys(sandboxSecrets);
      this.deps.logger.info(`${TAG} injecting ${secretKeys.length} secrets: [${secretKeys.join(', ')}]`);

      const containerInfo = await this.deps.containerManager.createContainer({
        sessionId,
        agentId: agentDef.name,
        harnessName,
        workspaceDir,
        cpus: agentDef.resourceLimits?.cpus,
        memoryMb: agentDef.resourceLimits?.memoryMb,
        pidsLimit: agentDef.resourceLimits?.pidsLimit,
        timeoutSec: agentDef.resourceLimits?.timeoutSec,
        secrets: sandboxSecrets,
      });
      createdContainer = containerInfo;

      await this.deps.containerManager.startContainer(containerInfo.containerId);

      if (!sessionWorkspaceDir) {
        await this.deps.workspaceDiffService.restore(sessionId, containerInfo.containerId);
        this.deps.logger.info(`${TAG} workspace restored for session ${sessionId}`);
      } else {
        this.deps.logger.info(
          `${TAG} reusing persisted session workspace for session ${sessionId}: ${sessionWorkspaceDir}`,
        );
      }

      const baseUrl = `http://${containerInfo.containerName}:${GRPC_PORT}`;
      const { grpcClient } = await waitForContainerReady(baseUrl);

      const restoreTools = this.deps.resolveToolsForAgent(
        agentDef.tools ?? [],
        asStringArray(agentDef.metadata?.excludeBuiltinTools),
      );
      const openReq = create(OpenSessionRequestSchema, {
        bootstrap: {
          case: 'restore',
          value: {
            sessionCheckpoint: {
              checkpointVersion: checkpoint.checkpointVersion,
              sessionId,
              conversationId: dbSession.conversationId,
              harnessName,
              harnessState: (checkpoint.harnessState ?? {}) as JsonObject,
            },
            agentId: agentDef.name,
            harnessConfigJson: JSON.stringify(agentDef.harnessConfig),
            systemPrompt: agentDef.systemPrompt,
            tools: restoreTools.map((tool) => create(ToolMetadataSchema, {
              name: tool.name,
              description: tool.description,
              inputSchemaJson: tool.inputSchemaJson,
              location: tool.location,
              programmatic: tool.programmatic ?? false,
            })),
          },
        },
      });

      await retryGrpcCall(() => grpcClient.openSession(openReq), 5, 1000);

      await this.deps.statusCoordinator.transition({
        sessionId,
        fromStatus: 'RESTORING',
        toStatus: 'ACTIVE',
        extra: {
          containerName: containerInfo.containerName,
          containerId: containerInfo.containerId,
          checkpointRef: null,
        },
      });
      createdContainer = undefined;

      const record: SessionRecord = {
        sessionId,
        conversationId: dbSession.conversationId,
        agentId: dbSession.agentId,
        containerName: containerInfo.containerName,
        containerId: containerInfo.containerId,
        status: 'ACTIVE',
        harnessName,
        grpcClient,
        sessionWorkspaceDir,
      };

      this.deps.logger.info(`${TAG} session ${sessionId} restored from checkpoint`);
      return record;
    } catch (err) {
      if (createdContainer) {
        await this.rollbackCreatedContainer(sessionId, createdContainer);
      }

      await this.deps.statusCoordinator.transition({
        sessionId,
        fromStatus: 'RESTORING',
        toStatus: 'CHECKPOINTED',
        clearRuntime: true,
      });
      throw err;
    }
  }

  private async rollbackCreatedContainer(
    sessionId: string,
    container: ContainerInfo,
  ): Promise<void> {
    try {
      await this.deps.containerManager.stopContainer(container.containerId, 10);
    } catch (stopErr) {
      this.deps.logger.warn(
        `${TAG} rollback stop failed for newly-created container ${container.containerId} (session ${sessionId}):`,
        stopErr,
      );
    }

    try {
      await this.deps.containerManager.removeContainer(container.containerId, true);
    } catch (removeErr) {
      this.deps.logger.warn(
        `${TAG} rollback removal failed for newly-created container ${container.containerId} (session ${sessionId}):`,
        removeErr,
      );
    }
  }

  async recoverDeadSession(
    dbSession: SandboxSessionRow,
    conversationId: string,
    agentDef: AgentDefinition,
    agentId: string | undefined,
    failedOp: string,
    err: unknown,
  ): Promise<SessionRecord> {
    this.deps.logger.warn(
      `${TAG} ${failedOp} failed for session ${dbSession.id}, attempting recovery`,
      err instanceof Error ? err.message : err,
    );

    const checkpoint = await this.deps.db.getCheckpointV2(dbSession.id);
    if (checkpoint) {
      this.deps.logger.info(
        `${TAG} checkpoint found for session ${dbSession.id}, restoring from checkpoint`,
      );
      await this.deps.statusCoordinator.transition({
        sessionId: dbSession.id,
        fromStatus: dbSession.status as SessionRecord['status'],
        toStatus: 'CHECKPOINTED',
        clearRuntime: true,
      });
      const record = await this.restoreFromCheckpoint({
        ...dbSession,
        status: 'CHECKPOINTED',
      }, agentDef);
      this.deps.stateStore.setSession(conversationId, record);
      return record;
    }

    this.deps.logger.warn(
      `${TAG} no checkpoint for session ${dbSession.id}, creating fresh session`,
    );
    return this.deps.createFreshSession(conversationId, agentDef, agentId);
  }

  isStaleContainerError(err: unknown): boolean {
    return SessionRecoveryCoordinator.isStaleContainerError(err);
  }

  static isStaleContainerError(err: unknown): boolean {
    if (err instanceof ConnectError && (err.code === Code.Unavailable || err.code === Code.Internal)) {
      return true;
    }
    if (err instanceof Error && /ENOTFOUND|ECONNREFUSED|ECONNRESET/.test(err.message)) {
      return true;
    }
    return false;
  }

  private async doRecover(
    conversationId: string,
    agentDef: AgentDefinition,
    agentId: string | undefined,
    dbSession: SandboxSessionRow,
  ): Promise<SessionRecord> {
    switch (dbSession.status) {
      case 'ACTIVE': {
        try {
          return await this.reconnectToContainer(dbSession);
        } catch (err) {
          return this.recoverDeadSession(dbSession, conversationId, agentDef, agentId, 'reconnect', err);
        }
      }
      case 'PAUSED': {
        this.deps.logger.warn('Found legacy PAUSED session, recovering via checkpoint', {
          sessionId: dbSession.id,
          conversationId,
        });
        return this.recoverDeadSession(
          dbSession,
          conversationId,
          agentDef,
          agentId,
          'legacy-paused',
          new Error('Legacy PAUSED session requires checkpoint recovery'),
        );
      }
      case 'CHECKPOINTED':
        return this.restoreFromCheckpoint(dbSession, agentDef);
      case 'RESTORING':
        throw new Error(
          `Session ${dbSession.id} for conversation ${conversationId} is currently being restored. Try again shortly.`,
        );
      case 'TERMINATED':
        this.deps.logger.info(
          `${TAG} session ${dbSession.id} for conversation ${conversationId} is terminated, creating fresh session`,
        );
        return this.deps.createFreshSession(conversationId, agentDef, agentId);
      default:
        this.deps.logger.warn(
          `${TAG} unknown status '${dbSession.status}' for session ${dbSession.id}, creating fresh session`,
        );
        return this.deps.createFreshSession(conversationId, agentDef, agentId);
    }
  }

  private dbSessionToRecord(
    row: SandboxSessionRow,
    grpcClient?: HarnessGrpcClient,
  ): SessionRecord {
    return {
      sessionId: row.id,
      conversationId: row.conversationId,
      agentId: row.agentId,
      containerName: row.containerName ?? '',
      containerId: row.containerId ?? '',
      status: (row.status as SessionRecord['status']) ?? 'ACTIVE',
      harnessName: row.harnessName,
      ...(grpcClient ? { grpcClient } : {}),
    };
  }

  private isSessionRecord(value: HarnessGrpcClient | SessionRecord | undefined): value is SessionRecord {
    return typeof value === 'object'
      && value !== null
      && 'sessionId' in value
      && typeof value.sessionId === 'string';
  }
}
