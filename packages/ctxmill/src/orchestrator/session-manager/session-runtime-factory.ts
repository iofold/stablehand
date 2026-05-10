import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { create } from '@bufbuild/protobuf';
import {
  OpenSessionRequestSchema,
  ToolMetadataSchema,
} from '@ctxmill/proto/sandbox/v1';

import type { DatabaseRepository } from '../../database/repository.js';
import type { SandboxContainerManager } from '../../sandbox/container-manager.js';
import { WorkspacePreparationService } from '../../sandbox/workspace-preparation.js';
import type { AgentDefinition } from '../../types.js';
import {
  cleanupSession,
  ensureConversationWorkspace,
  getConversationDir,
  getConversationWorkspacePath,
} from '../../workspace/session-workspace.js';
import {
  retryGrpcCall,
  waitForContainerReady,
} from './grpc-session-client.js';
import { getRuntimeSandboxSecrets } from './runtime-sandbox-secrets.js';
import { sandboxGrpcBaseUrl } from './sandbox-endpoint.js';
import type {
  Logger,
  SessionRecord,
  ToolMetadata,
} from './types.js';

const TAG = '[SandboxSessionManager]';

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === 'string');
  return strings.length > 0 ? strings : undefined;
}

export interface SessionRuntimeFactoryDeps {
  containerManager: Pick<SandboxContainerManager, 'createContainer' | 'startContainer' | 'stopContainer' | 'removeContainer'>;
  db: Pick<DatabaseRepository, 'createSandboxSession'>;
  buildSandboxSecrets: (agentId: string) => Promise<Readonly<Record<string, string>>>;
  resolveToolsForAgent: (toolNames: string[], excludeBuiltins?: string[], agentId?: string) => ToolMetadata[];
  checkConcurrencyLimit: (agentId: string, options?: { excludeReservationId?: string }) => void;
  logger: Logger;
  dataDir?: string;
}

export class SessionRuntimeFactory {
  constructor(private readonly deps: SessionRuntimeFactoryDeps) {}

  async createFreshSession(
    conversationId: string,
    agentDef: AgentDefinition,
    agentId?: string,
    options?: { concurrencyReservationId?: string },
  ): Promise<SessionRecord> {
    const harnessName = agentDef.harness ?? 'langgraph';
    const sessionId = randomUUID();
    const effectiveAgentId = agentId ?? agentDef.name;

    this.deps.checkConcurrencyLimit(effectiveAgentId, {
      excludeReservationId: options?.concurrencyReservationId,
    });

    this.deps.logger.info(
      `${TAG} creating fresh session ${sessionId} for conversation ${conversationId} (harness=${harnessName})`,
    );

    let workspaceDir = agentDef.workspaceDir;
    let sessionWorkspaceDir: string | undefined;
    let conversationDir: string | undefined;
    let createdConversationWorkspace = false;
    let createdContainerId: string | undefined;

    try {
      if (this.deps.dataDir && agentDef.workspaceDir) {
        conversationDir = getConversationDir(this.deps.dataDir, effectiveAgentId, conversationId);
        const preparedWorkspace = await ensureConversationWorkspace(agentDef.workspaceDir, conversationDir);
        createdConversationWorkspace = preparedWorkspace.created;
        sessionWorkspaceDir = preparedWorkspace.workspaceDir;
        workspaceDir = preparedWorkspace.workspaceDir;

        this.deps.logger.debug(`${TAG} using conversation workspace at ${sessionWorkspaceDir}`);
      }

      if (workspaceDir && agentDef.workspaceContent && (!this.deps.dataDir || createdConversationWorkspace)) {
        const workspacePreparation = new WorkspacePreparationService({ logger: this.deps.logger });
        await workspacePreparation.prepare({
          workspaceDir,
          projectDir: agentDef.projectDir,
          harnessName,
          workspaceContent: agentDef.workspaceContent,
        });
      }

      const setup = agentDef.harnessConfig['setup'];
      const symlinks =
        workspaceDir && typeof setup === 'object' && setup !== null && 'symlinks' in setup && Array.isArray(setup.symlinks)
          ? setup.symlinks
          : undefined;

      if (workspaceDir && symlinks) {
        for (const link of symlinks) {
          const srcPath = join(workspaceDir, link.src);
          const destPath = join(workspaceDir, link.dest);
          await fs.mkdir(dirname(destPath), { recursive: true });
          try {
            await fs.symlink(srcPath, destPath);
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
              throw err;
            }
          }
        }
      }

      const sandboxSecrets = {
        ...(await this.deps.buildSandboxSecrets(effectiveAgentId)),
        ...getRuntimeSandboxSecrets(agentDef),
      };
      const secretKeys = Object.keys(sandboxSecrets);
      this.deps.logger.info(`${TAG} injecting ${secretKeys.length} secrets: [${secretKeys.join(', ')}]`);

      const containerInfo = await this.deps.containerManager.createContainer({
        sessionId,
        conversationId,
        agentId: effectiveAgentId,
        harnessName,
        workspaceDir,
        cpus: agentDef.resourceLimits?.cpus,
        memoryMb: agentDef.resourceLimits?.memoryMb,
        pidsLimit: agentDef.resourceLimits?.pidsLimit,
        timeoutSec: agentDef.resourceLimits?.timeoutSec,
        secrets: sandboxSecrets,
      });
      createdContainerId = containerInfo.containerId;

      const startedContainerInfo = await this.deps.containerManager.startContainer(containerInfo.containerId);
      const reachableContainerInfo = startedContainerInfo?.containerName ? startedContainerInfo : containerInfo;

      const baseUrl = sandboxGrpcBaseUrl(reachableContainerInfo);
      this.deps.logger.debug(`${TAG} waiting for container at ${baseUrl}`);
      const { grpcClient } = await waitForContainerReady(baseUrl);

      const resolvedTools = this.deps.resolveToolsForAgent(
        agentDef.tools ?? [],
        asStringArray(agentDef.metadata?.excludeBuiltinTools),
        effectiveAgentId,
      );
      const openReq = create(OpenSessionRequestSchema, {
        bootstrap: {
          case: 'fresh',
          value: {
            agentId: effectiveAgentId,
            sessionId,
            conversationId,
            harnessName,
            harnessConfigJson: JSON.stringify(agentDef.harnessConfig),
            systemPrompt: agentDef.systemPrompt,
            workspaceDir: '/workspace',
            tools: resolvedTools.map((tool) => create(ToolMetadataSchema, {
              name: tool.name,
              description: tool.description,
              inputSchemaJson: tool.inputSchemaJson,
              location: tool.location,
              programmatic: tool.programmatic ?? false,
            })),
          },
        },
      });

      this.deps.logger.debug(`${TAG} opening session on container ${reachableContainerInfo.containerName}`);
      await retryGrpcCall(() => grpcClient.openSession(openReq), 5, 1000);

      const dbSession = await this.deps.db.createSandboxSession({
        id: sessionId,
        conversationId,
        agentId: effectiveAgentId,
        containerName: reachableContainerInfo.containerName,
        containerId: reachableContainerInfo.containerId,
        harnessName,
        status: 'ACTIVE',
      });

      return {
        sessionId: dbSession.id,
        conversationId,
        agentId: effectiveAgentId,
        containerName: reachableContainerInfo.containerName,
        containerId: reachableContainerInfo.containerId,
        status: 'ACTIVE',
        harnessName,
        grpcClient,
        sessionWorkspaceDir,
      };
    } catch (err) {
      await this.cleanupFreshSessionFailure(sessionId, createdContainerId, conversationDir, createdConversationWorkspace);
      throw err;
    }
  }

  private async cleanupFreshSessionFailure(
    sessionId: string,
    containerId: string | undefined,
    conversationDir: string | undefined,
    cleanupWorkspace: boolean,
  ): Promise<void> {
    if (containerId) {
      try {
        await this.deps.containerManager.stopContainer(containerId, 10);
      } catch (err) {
        this.deps.logger.warn(`${TAG} container stop failed during startup rollback for session ${sessionId}:`, err);
      }

      try {
        await this.deps.containerManager.removeContainer(containerId, true);
      } catch (err) {
        this.deps.logger.warn(`${TAG} container removal failed during startup rollback for session ${sessionId}:`, err);
      }
    }

    if (!conversationDir || !cleanupWorkspace) {
      return;
    }

    try {
      await cleanupSession(conversationDir);
    } catch (err) {
      this.deps.logger.warn(`${TAG} workspace cleanup failed during startup rollback for session ${sessionId}:`, err);
    }
  }

  async getExistingConversationWorkspaceDir(agentId: string, conversationId: string): Promise<string | undefined> {
    if (!this.deps.dataDir) {
      return undefined;
    }

    const candidatePath = getConversationWorkspacePath(this.deps.dataDir, agentId, conversationId);
    try {
      await fs.access(candidatePath);
      return candidatePath;
    } catch {
      return undefined;
    }
  }
}
