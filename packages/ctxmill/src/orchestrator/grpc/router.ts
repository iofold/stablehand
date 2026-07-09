/**
 * ConnectRPC router setup for the orchestrator's gRPC services.
 *
 * Creates a ConnectRPC route configuration that registers the OrchestratorService
 * and can be plugged into Fastify via fastifyConnectPlugin.
 */

import type { ConnectRouter } from '@connectrpc/connect';
import { OrchestratorService } from '@ctxmill/proto/sandbox/v1';
import type { TypedEventBus } from '../../events/bus.js';
import type { InterruptManager } from '../interrupt.js';
import type { LocalFunctionExecutor } from '../../tool/executor.js';
import type { DefaultToolRegistry } from '../../tool/registry.js';
import type { ToolContext } from '../../tool/types.js';
import type { DatabaseRepository } from '../../database/repository.js';
import {
  createOrchestratorServiceImpl,
  DefaultOrchestratorToolRegistry,
  registerDefaultToolHandlers,
  type OrchestratorToolRegistry,
  type ToolHandlerContext,
} from './orchestrator-service.js';

export interface GrpcRouterOptions {
  eventBus: TypedEventBus;
  toolRegistry?: OrchestratorToolRegistry;
  interruptManager?: InterruptManager;
  toolExecutor?: LocalFunctionExecutor;
  toolDefinitionRegistry?: DefaultToolRegistry;
  repository?: DatabaseRepository;
}

export function createGrpcRoutes(opts: GrpcRouterOptions): (router: ConnectRouter) => void {
  const { eventBus, interruptManager } = opts;

  const makeToolContext = (grpcCtx: ToolHandlerContext): ToolContext => ({
    agentId: grpcCtx.agentId,
    conversationId: '',
    instanceId: grpcCtx.sessionId,
    requestId: grpcCtx.requestId,
    workspaceDir: '/workspace',
    eventBus,
  });

  const toolRegistry = opts.toolRegistry
    ?? new DefaultOrchestratorToolRegistry(opts.toolDefinitionRegistry, makeToolContext);
  registerDefaultToolHandlers(toolRegistry, { eventBus, interruptManager, repository: opts.repository });

  if (opts.toolExecutor) {
    for (const tool of opts.toolExecutor.list()) {
      if (!toolRegistry.has(tool.name)) {
        toolRegistry.set(tool.name, async (args, ctx) => {
          return tool.handler(args, makeToolContext(ctx));
        });
      }
    }
  }

  const serviceImpl = createOrchestratorServiceImpl({
    eventBus,
    toolRegistry,
    repository: opts.repository,
  });

  return (router: ConnectRouter) => {
    router.service(OrchestratorService, serviceImpl);
  };
}
