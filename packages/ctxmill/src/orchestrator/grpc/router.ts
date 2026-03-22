/**
 * ConnectRPC router setup for the orchestrator's gRPC services.
 *
 * Creates a ConnectRPC route configuration that registers the OrchestratorService
 * and can be plugged into Fastify via fastifyConnectPlugin.
 */

import type { ConnectRouter } from '@connectrpc/connect';
import { OrchestratorService } from '@ctxmill/proto/sandbox/v1';
import type { TypedEventBus } from '../../events/bus.js';
import {
  createOrchestratorServiceImpl,
  DefaultOrchestratorToolRegistry,
  registerDefaultToolHandlers,
  type OrchestratorToolRegistry,
} from './orchestrator-service.js';

/**
 * Options for building the ConnectRPC routes function.
 */
export interface GrpcRouterOptions {
  eventBus: TypedEventBus;
  /** Optional pre-built tool registry. A default one is created if not provided. */
  toolRegistry?: OrchestratorToolRegistry;
}

/**
 * Creates a routes function suitable for passing to fastifyConnectPlugin.
 *
 * Usage:
 * ```ts
 * await fastify.register(fastifyConnectPlugin, {
 *   routes: createGrpcRoutes({ eventBus }),
 * });
 * ```
 */
export function createGrpcRoutes(opts: GrpcRouterOptions): (router: ConnectRouter) => void {
  const { eventBus } = opts;

  // Build tool registry with default handlers
  const toolRegistry = opts.toolRegistry ?? new DefaultOrchestratorToolRegistry();
  registerDefaultToolHandlers(toolRegistry, eventBus);

  // Create the service implementation
  const serviceImpl = createOrchestratorServiceImpl({ eventBus, toolRegistry });

  return (router: ConnectRouter) => {
    router.service(OrchestratorService, serviceImpl);
  };
}
