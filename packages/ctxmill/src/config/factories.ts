import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ResolvedConfig } from './types.js';
import type { KnowledgeStore } from '../knowledge/types.js';
import type { LLMProvider } from '../llm/types.js';
import type { EnvironmentFactory } from '../workspace/types.js';
import { InMemoryKnowledgeStore } from '../knowledge/store.js';
import { Mem0KnowledgeStore } from '../knowledge/mem0-store.js';
import { createLLMProvider } from '../llm/factory.js';
import { MockOverlayFactory } from '../workspace/mock-overlay.js';
import { FuseOverlayFactory } from '../workspace/fuse-overlay.js';

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
      // PgVectorKnowledgeStore not yet implemented — fall back to in-memory
      console.log('[Factory] Knowledge provider: pgvector (not yet implemented, using in-memory fallback)');
      return new InMemoryKnowledgeStore(dataDir);
    default:
      throw new Error(`Unknown knowledge provider: ${provider}`);
  }
}

/**
 * Create an LLMProvider from resolved config.
 */
export function createLLMProviderFromConfig(config: ResolvedConfig): LLMProvider {
  const { provider, apiKey, model, baseUrl } = config.llm;

  const validProviders = ['anthropic', 'openai'] as const;
  if (!validProviders.includes(provider as (typeof validProviders)[number])) {
    throw new Error(`Invalid LLM provider: ${provider}. Must be one of: ${validProviders.join(', ')}`);
  }
  if (!apiKey) {
    throw new Error('LLM apiKey must not be empty');
  }
  if (!model) {
    throw new Error('LLM model must not be empty');
  }

  return createLLMProvider({
    apiKey,
    baseUrl: baseUrl || undefined,
    model,
    provider: provider as 'anthropic' | 'openai',
  });
}

/**
 * Detect whether fuse-overlayfs is available on this host.
 * Synchronous check — suitable for startup-time detection.
 */
function isFuseAvailable(): boolean {
  try {
    execFileSync('fuse-overlayfs', ['--version'], { stdio: 'pipe' });
    return existsSync('/dev/fuse');
  } catch {
    return false;
  }
}

/**
 * Create an EnvironmentFactory based on execution type and runtime capabilities.
 *
 * - `docker` / `firecracker`: prefer FuseOverlayFactory (Level 2+ will swap to Docker/FC)
 * - `local`: auto-detect fuse-overlayfs; fall back to MockOverlayFactory
 *
 * MockOverlayFactory is always the safe default — no OS dependencies required.
 */
export function createEnvironmentFactory(executionType: string): EnvironmentFactory {
  if (executionType === 'docker' || executionType === 'firecracker') {
    if (isFuseAvailable()) {
      return new FuseOverlayFactory();
    }
    // Fall back to mock if fuse is not available even in higher execution tiers
    console.warn('[EnvironmentFactory] fuse-overlayfs not available, falling back to mock overlay');
    return new MockOverlayFactory();
  }

  // local execution: auto-detect
  if (isFuseAvailable()) {
    return new FuseOverlayFactory();
  }

  return new MockOverlayFactory();
}
