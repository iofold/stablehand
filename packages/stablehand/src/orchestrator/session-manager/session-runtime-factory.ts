import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { create } from '@bufbuild/protobuf';
import {
  OpenSessionRequestSchema,
  ToolMetadataSchema,
} from '@stablehand/proto/sandbox/v1';

import type { DatabaseRepository } from '../../database/repository.js';
import type { SandboxContainerManager } from '../../sandbox/container-manager.js';
import { prepareWorkspace } from '../../sandbox/workspace-preparation.js';
import type { AgentDefinition } from '@stablehand/sandbox-daemon';
import { stopAndRemoveContainer } from '../container-cleanup.js';
import {
  cleanupSession,
  ensureConversationWorkspace,
  getConversationDir,
  getConversationWorkspacePath,
} from '../../workspace/session-workspace.js';
import {
  createRuntimeInstanceToken,
  retryGrpcCall,
  waitForContainerReady,
} from './grpc-session-client.js';
import { RUNTIME_INSTANCE_TOKEN_ENV } from '@stablehand/shared';
import { getGrpcCallbackSandboxSecrets } from '../grpc/callback-auth.js';
import { mintEgressLeaseToken } from '../egress-lease.js';
import { sandboxGrpcBaseUrl } from './sandbox-endpoint.js';
import { applyWorkspaceSetup } from './workspace-setup.js';
import { nativeToolPolicyToProto } from './native-tool-policy-proto.js';
import { resolveAgentToolNames } from '../agent-definition.js';
import type { BuiltinToolPolicy } from '@stablehand/contracts';
import type {
  BuildSandboxSecrets,
  Logger,
  SessionRecord,
  ToolMetadata,
} from './types.js';
import {
  performanceInstrumentation,
  type PerformanceRecorder,
} from '../../observability/performance.js';

const TAG = '[SandboxSessionManager]';

export interface SessionRuntimeFactoryDeps {
  containerManager: Pick<SandboxContainerManager, 'createContainer' | 'startContainer' | 'stopContainer' | 'removeContainer'>;
  db: Pick<DatabaseRepository, 'createSandboxSession'>;
  buildSandboxSecrets: BuildSandboxSecrets;
  releaseSandboxCredentials?: (sessionId: string) => Promise<void>;
  resolveToolsForAgent: (
    toolNames: string[],
    builtinToolPolicy?: BuiltinToolPolicy,
    agentId?: string,
  ) => ToolMetadata[];
  checkConcurrencyLimit: (agentId: string, options?: { excludeReservationId?: string }) => void;
  resolveRuntimeDefinitionHash: (
    agentId: string,
    agentDef: AgentDefinition,
  ) => Promise<string>;
  logger: Logger;
  dataDir?: string;
  performance?: PerformanceRecorder;
}

export class SessionRuntimeFactory {
  constructor(private readonly deps: SessionRuntimeFactoryDeps) {}

  async createFreshSession(
    conversationId: string,
    agentDef: AgentDefinition,
    agentId?: string,
    options?: {
      concurrencyReservationId?: string;
      runtimeDefinitionHash?: string;
    },
  ): Promise<SessionRecord> {
    const harnessName = agentDef.harness ?? 'langgraph';
    const effectiveAgentId = agentId ?? agentDef.name;
    return (this.deps.performance ?? performanceInstrumentation).measure(
      'session.create',
      {
        'stablehand.harness': harnessName,
        'stablehand.agent.id': effectiveAgentId,
        'stablehand.conversation.id': conversationId,
        'stablehand.session.state': 'cold',
      },
      () => this.createFreshSessionMeasured(
        conversationId,
        agentDef,
        agentId,
        options,
      ),
    );
  }

  private async createFreshSessionMeasured(
    conversationId: string,
    agentDef: AgentDefinition,
    agentId?: string,
    options?: {
      concurrencyReservationId?: string;
      runtimeDefinitionHash?: string;
    },
  ): Promise<SessionRecord> {
    const harnessName = agentDef.harness ?? 'langgraph';
    const sessionId = randomUUID();
    const effectiveAgentId = agentId ?? agentDef.name;
    const performance = this.deps.performance ?? performanceInstrumentation;
    const performanceAttributes = {
      'stablehand.harness': harnessName,
      'stablehand.agent.id': effectiveAgentId,
      'stablehand.conversation.id': conversationId,
      'stablehand.session.id': sessionId,
      'stablehand.session.state': 'cold',
    };
    const runtimeDefinitionHash = options?.runtimeDefinitionHash
      ?? await this.deps.resolveRuntimeDefinitionHash(
        effectiveAgentId,
        agentDef,
      );

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
      await performance.measure(
        'workspace.prepare',
        performanceAttributes,
        async () => {
          if (this.deps.dataDir && agentDef.workspaceDir) {
            conversationDir = getConversationDir(this.deps.dataDir, effectiveAgentId, conversationId);
            const preparedWorkspace = await ensureConversationWorkspace(agentDef.workspaceDir, conversationDir);
            createdConversationWorkspace = preparedWorkspace.created;
            sessionWorkspaceDir = preparedWorkspace.workspaceDir;
            workspaceDir = preparedWorkspace.workspaceDir;

            this.deps.logger.debug(`${TAG} using conversation workspace at ${sessionWorkspaceDir}`);
          }

          // A server-managed workspace has already been materialized by the workspace
          // upload API and copied into the conversation directory above. The manifest
          // sources describe the original project checkout and are not runtime paths.
          if (workspaceDir && agentDef.workspaceContent && !this.deps.dataDir) {
            await prepareWorkspace({
              workspaceDir,
              projectDir: agentDef.projectDir,
              harnessName,
              workspaceContent: agentDef.workspaceContent,
            }, this.deps.logger);
          }

          await applyWorkspaceSetup(workspaceDir, agentDef.harnessConfig);
        },
      );

      const runtimeInstanceToken = createRuntimeInstanceToken();
      const stableSandboxSecrets = {
        ...(await this.deps.buildSandboxSecrets(effectiveAgentId, { sessionId })),
        ...getGrpcCallbackSandboxSecrets(sessionId, effectiveAgentId),
        [RUNTIME_INSTANCE_TOKEN_ENV]: runtimeInstanceToken,
      };
      const secretKeys = Object.keys(stableSandboxSecrets);
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
        secrets: stableSandboxSecrets,
        egressLeaseToken: mintEgressLeaseToken(sessionId, effectiveAgentId),
      });
      createdContainerId = containerInfo.containerId;

      const startedContainerInfo = await performance.measure(
        'sandbox.start',
        performanceAttributes,
        () => this.deps.containerManager.startContainer(containerInfo.containerId),
      );
      const reachableContainerInfo = startedContainerInfo?.containerName ? startedContainerInfo : containerInfo;

      const baseUrl = sandboxGrpcBaseUrl(reachableContainerInfo);
      this.deps.logger.debug(`${TAG} waiting for container at ${baseUrl}`);
      const { grpcClient } = await performance.measure(
        'sandbox.ready',
        performanceAttributes,
        () => waitForContainerReady(baseUrl, {
          runtimeInstanceToken,
        }),
      );

      const resolvedTools = this.deps.resolveToolsForAgent(
        resolveAgentToolNames(agentDef),
        agentDef.builtinToolPolicy,
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
            nativeToolPolicy: agentDef.nativeToolPolicy
              ? nativeToolPolicyToProto(agentDef.nativeToolPolicy)
              : undefined,
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
      await performance.measure(
        'harness.open',
        performanceAttributes,
        () => retryGrpcCall(() => grpcClient.openSession(openReq), 5, 1000),
      );

      const dbSession = await this.deps.db.createSandboxSession({
        id: sessionId,
        conversationId,
        agentId: effectiveAgentId,
        containerName: reachableContainerInfo.containerName,
        containerId: reachableContainerInfo.containerId,
        harnessName,
        status: 'ACTIVE',
        runtimeDefinitionHash,
      });

      return {
        sessionId: dbSession.id,
        conversationId,
        agentId: effectiveAgentId,
        containerName: reachableContainerInfo.containerName,
        containerId: reachableContainerInfo.containerId,
        restoreFenceToken: dbSession.restoreFenceToken,
        runtimeDefinitionHash,
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
    await this.deps.releaseSandboxCredentials?.(sessionId);
    if (containerId) {
      await stopAndRemoveContainer(
        this.deps.containerManager,
        containerId,
        this.deps.logger,
        `${TAG} startup rollback for session ${sessionId}`,
        10,
      );
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
