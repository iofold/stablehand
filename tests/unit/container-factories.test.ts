import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createKnowledgeStoreFromConfig } from '../../packages/ctxmill/src/config/factories.js';
import { InMemoryKnowledgeStore } from '../../packages/ctxmill/src/knowledge/store.js';
import type { ResolvedConfig } from '../../packages/ctxmill/src/config/types.js';

function makeConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    execution: { type: 'local', warmPool: 0 },
    database: { type: 'postgres', url: 'postgres://ctxmill:ctxmill@localhost:5433/ctxmill' },
    knowledge: { providers: ['memory'] },
    tools: { executors: [] },
    security: { preset: 'local' },
    orchestration: { eventBus: false, reconciliation: false },
    observability: { sink: 'console', path: '' },
    ...overrides,
  };
}

describe('createKnowledgeStoreFromConfig', () => {
  it('returns InMemoryKnowledgeStore for "memory" provider', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-test-'));
    const config = makeConfig({ knowledge: { providers: ['memory'] } });
    const store = createKnowledgeStoreFromConfig(config, dataDir);
    expect(store).toBeInstanceOf(InMemoryKnowledgeStore);
  });

  it('defaults to InMemoryKnowledgeStore when providers array is empty', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-test-'));
    const config = makeConfig({ knowledge: { providers: [] } });
    const store = createKnowledgeStoreFromConfig(config, dataDir);
    expect(store).toBeInstanceOf(InMemoryKnowledgeStore);
  });

  it('throws for unknown provider', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-test-'));
    const config = makeConfig({ knowledge: { providers: ['redis'] } });
    expect(() => createKnowledgeStoreFromConfig(config, dataDir)).toThrow(
      'Unknown knowledge provider: redis',
    );
  });
});
