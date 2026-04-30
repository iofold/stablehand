import type { FastifyInstance } from 'fastify';
import type { SandboxContainerManager } from '../../sandbox/container-manager.js';

export interface SandboxRouteOptions {
  containerManager: SandboxContainerManager;
}

/**
 * Sandbox metrics endpoint — exposes in-memory container metrics
 * for dashboards and monitoring. All data is served from memory,
 * so the endpoint responds in < 5ms with no Docker API calls.
 */
export async function sandboxRoutes(
  app: FastifyInstance,
  opts: SandboxRouteOptions,
): Promise<void> {
  const { containerManager } = opts;

  // GET /api/sandbox/metrics
  app.get('/metrics', async () => {
    const metrics = containerManager.getMetrics();
    return {
      execution_mode: 'sandbox',
      containers: {
        active: metrics.active,
        queued: metrics.queued,
        peak: metrics.peak,
        total_created: metrics.totalCreated,
        by_harness: metrics.byHarness,
        average_lifetime_ms: metrics.averageLifetimeMs,
      },
      limits: {
        max_global_containers: metrics.maxGlobalContainers,
      },
    };
  });
}
