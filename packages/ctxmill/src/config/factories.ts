import type { ResolvedConfig } from './types.js';
import type { KnowledgeStore } from '../knowledge/types.js';
import { InMemoryKnowledgeStore } from '../knowledge/store.js';
import { Mem0KnowledgeStore } from '../knowledge/mem0-store.js';

/**
 * Create a KnowledgeStore from resolved config.
 *
 * Provider selection:
 *  - `'mem0'` or env var MEM0_API_KEY present → Mem0KnowledgeStore
 *     (uses cloud API when key is set, local adapter otherwise)
 *  - `'memory'` (default) → InMemoryKnowledgeStore (legacy)
 */
export function createKnowledgeStoreFromConfig(
  config: ResolvedConfig,
  dataDir: string,
): KnowledgeStore {
  const provider = config.knowledge.providers[0] ?? 'memory';
  const mem0ApiKey = process.env.MEM0_API_KEY;
  const mem0Host = process.env.MEM0_HOST;

  // Auto-detect: if MEM0_API_KEY is set, prefer mem0 regardless of config
  if (provider === 'mem0' || mem0ApiKey) {
    console.log(`[Factory] Knowledge provider: mem0 (cloud: ${!!mem0ApiKey})`);
    return new Mem0KnowledgeStore(dataDir, {
      apiKey: mem0ApiKey,
      host: mem0Host,
    });
  }

  switch (provider) {
    case 'memory':
      console.log('[Factory] Knowledge provider: memory (in-memory)');
      return new InMemoryKnowledgeStore(dataDir);
    case 'pgvector':
      throw new Error(
        '[Factory] knowledge.providers[0]="pgvector" is not yet supported. ' +
        'PgVectorKnowledgeStore implementation is pending. ' +
        'Set knowledge.providers to ["memory"] in your config/preset.'
      );
    default:
      throw new Error(`Unknown knowledge provider: ${provider}`);
  }
}
