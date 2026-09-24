import type { FastifyInstance } from 'fastify';
import { SandboxMetricsResponseSchema } from '@stablehand/contracts';
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
    return SandboxMetricsResponseSchema.parse({
      executionMode: 'sandbox',
      containers: {
        active: metrics.active,
        queued: metrics.queued,
        peak: metrics.peak,
        totalCreated: metrics.totalCreated,
        byHarness: metrics.byHarness,
        averageLifetimeMs: metrics.averageLifetimeMs,
      },
      limits: {
        maxGlobalContainers: metrics.maxGlobalContainers,
      },
    });
  });
}
