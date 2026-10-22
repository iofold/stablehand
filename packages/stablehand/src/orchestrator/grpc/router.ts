/**
 * ConnectRPC router setup for the orchestrator's gRPC services.
 *
 * Creates a ConnectRPC route configuration that registers the OrchestratorService
 * and can be plugged into Fastify via fastifyConnectPlugin.
 */

import type { ConnectRouter } from '@connectrpc/connect';
import { OrchestratorService } from '@stablehand/proto/sandbox/v1';
import type { TypedEventBus } from '../../events/bus.js';
import type { InterruptManager } from '../interrupt.js';
import type { LocalFunctionExecutor } from '../../tool/executor.js';
import type { DefaultToolRegistry } from '../../tool/registry.js';
import type { ToolContext } from '@stablehand/sandbox-daemon';
import type { DatabaseRepository } from '../../database/repository.js';
import type { GrpcCallbackAuthConfig } from './callback-auth.js';
import type { ArtifactRegistrationService } from '../../artifact/registration-service.js';
import {
  createOrchestratorServiceImpl,
  DefaultOrchestratorToolRegistry,
  registerDefaultToolHandlers,
  type OrchestratorToolHandler,
  type OrchestratorToolRegistry,
  type ToolHandlerContext,
} from './orchestrator-service.js';
import { createToolApprovalGate } from '../tool-approval-gate.js';

export interface GrpcRouterOptions {
  eventBus: TypedEventBus;
  toolRegistry?: OrchestratorToolRegistry;
  interruptManager?: InterruptManager;
  toolExecutor?: LocalFunctionExecutor;
  toolDefinitionRegistry?: DefaultToolRegistry;
  repository: DatabaseRepository;
  callbackAuthConfig?: GrpcCallbackAuthConfig;
  artifactRegistration?: ArtifactRegistrationService;
}

export function createGrpcRoutes(opts: GrpcRouterOptions): (router: ConnectRouter) => void {
  const { eventBus, interruptManager } = opts;

  const makeToolContext = (grpcCtx: ToolHandlerContext): ToolContext => ({
    agentId: grpcCtx.agentId,
    conversationId: grpcCtx.conversationId ?? '',
    turnId: grpcCtx.turnId,
    ...(grpcCtx.sandboxSessionId
      ? { sandboxSessionId: grpcCtx.sandboxSessionId }
      : {}),
    requestId: grpcCtx.requestId,
    workspaceDir: '/workspace',
    eventBus,
  });

  const approvalGate = interruptManager
    ? createToolApprovalGate({ interruptManager, eventBus })
    : undefined;
  const toolRegistry = opts.toolRegistry
    ?? new DefaultOrchestratorToolRegistry(
      opts.toolDefinitionRegistry,
      makeToolContext,
      approvalGate ? { approvalGate } : {},
    );
  if (approvalGate && toolRegistry instanceof DefaultOrchestratorToolRegistry) {
    toolRegistry.setApprovalGate(approvalGate);
  }
  registerDefaultToolHandlers(toolRegistry, { eventBus, interruptManager, repository: opts.repository });

  if (opts.toolExecutor) {
    for (const tool of opts.toolExecutor.list()) {
      if (!toolRegistry.has(tool.name)) {
        const run: OrchestratorToolHandler = async (args, ctx) => tool.handler(args, makeToolContext(ctx));
        toolRegistry.set(
          tool.name,
          tool.requiresApproval && approvalGate ? approvalGate(tool.name, run) : run,
        );
      }
    }
  }

  const serviceImpl = createOrchestratorServiceImpl({
    eventBus,
    toolRegistry,
    repository: opts.repository,
    callbackAuthConfig: opts.callbackAuthConfig,
    artifactRegistration: opts.artifactRegistration,
  });

  return (router: ConnectRouter) => {
    router.service(OrchestratorService, serviceImpl);
  };
}
