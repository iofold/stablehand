import type { ResolvedConfig } from './types.js';

export const presets: Record<string, ResolvedConfig> = {
  docker: {
    execution: { type: 'docker' as const, warmPool: 0, maxGlobalContainers: 20 },
    database: { type: 'postgres' as const, url: 'env:DATABASE_URL' },
    tools: { executors: ['local', 'mcp'] },
    security: { preset: 'docker' },
    orchestration: { eventBus: true, reconciliation: false },
    observability: { sink: 'postgres', path: '' },
  },
};
