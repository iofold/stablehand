import type { ResolvedConfig } from './types.js';
import type { KnowledgeStore } from '../knowledge/types.js';
import type { LLMProvider } from '../llm/types.js';
import { InMemoryKnowledgeStore } from '../knowledge/store.js';
import { createLLMProvider } from '../llm/factory.js';

/**
 * Create a KnowledgeStore from resolved config.
 * Currently only supports 'memory' provider; future providers (pgvector, etc.)
 * will be added as additional cases.
 */
export function createKnowledgeStoreFromConfig(
  config: ResolvedConfig,
  dataDir: string,
): KnowledgeStore {
  const provider = config.knowledge.providers[0] ?? 'memory';
  switch (provider) {
    case 'memory':
      return new InMemoryKnowledgeStore(dataDir);
    default:
      throw new Error(`Unknown knowledge provider: ${provider}`);
  }
}

/**
 * Create an LLMProvider from resolved config.
 */
export function createLLMProviderFromConfig(config: ResolvedConfig): LLMProvider {
  return createLLMProvider({
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl || undefined,
    model: config.llm.model,
    provider: config.llm.provider as 'anthropic' | 'openai',
  });
}
