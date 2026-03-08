import type { ResolvedConfig } from './types.js';

export const presets: Record<string, ResolvedConfig> = {
  local: {
    execution: { type: 'local' as const, warmPool: 0 },
    database: { type: 'sqlite' as const, path: '.ctxmill/data.db', url: '' },
    knowledge: { providers: ['memory'] },
    tools: { executors: ['local'] },
    security: { preset: 'local' },
    learning: { strategy: 'simple' as const, async: false },
    orchestration: { eventBus: false, reconciliation: false },
    observability: { sink: 'file', path: '.ctxmill/audit.ndjson' },
    llm: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: '', baseUrl: '' },
  },
  docker: {
    execution: { type: 'docker' as const, warmPool: 0 },
    database: { type: 'postgres' as const, path: '', url: 'env:DATABASE_URL' },
    knowledge: { providers: ['pgvector'] },
    tools: { executors: ['local', 'mcp'] },
    security: { preset: 'docker' },
    learning: { strategy: 'ace' as const, async: false },
    orchestration: { eventBus: true, reconciliation: false },
    observability: { sink: 'postgres', path: '' },
    llm: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: '', baseUrl: '' },
  },
  production: {
    execution: { type: 'firecracker' as const, warmPool: 3 },
    database: { type: 'postgres' as const, path: '', url: 'env:DATABASE_URL' },
    knowledge: { providers: ['pgvector', 'age'] },
    tools: { executors: ['local', 'mcp', 'composio'] },
    security: { preset: 'production' },
    learning: { strategy: 'ace' as const, async: true },
    orchestration: { eventBus: true, reconciliation: true },
    observability: { sink: 'otel', path: '' },
    llm: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: '', baseUrl: '' },
  },
};
