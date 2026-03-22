import type { ResolvedConfig } from './types.js';

export const presets: Record<string, ResolvedConfig> = {
  docker: {
    execution: { type: 'docker' as const, warmPool: 0, maxGlobalContainers: 20 },
    database: { type: 'postgres' as const, url: 'env:DATABASE_URL' },
    knowledge: { providers: ['pgvector'] },
    tools: { executors: ['local', 'mcp'] },
    security: { preset: 'docker' },
    learning: { strategy: 'ace' as const, async: false },
    orchestration: { eventBus: true, reconciliation: false },
    observability: { sink: 'postgres', path: '' },
    llm: { provider: 'openai', model: '', apiKey: '', baseUrl: '' },
  },
};
