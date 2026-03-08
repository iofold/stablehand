import type { LLMProvider, LLMProviderConfig } from './types.js';
import { LangChainLLMProvider } from './langchain.js';

/**
 * Factory function to create an LLMProvider from config.
 * Future: register additional providers (ollama, bedrock, etc.)
 */
export function createLLMProvider(config: LLMProviderConfig): LLMProvider {
  return new LangChainLLMProvider(config);
}
