import type { ServiceModule } from '@ctxmill/shared';

export interface LLMProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  provider: 'anthropic' | 'openai' | 'google';
  /** Timeout in milliseconds for each LLM call (default: 60000). */
  timeoutMs?: number;
  /** Maximum number of retry attempts for transient failures (default: 3). */
  maxRetries?: number;
}

export interface LLMResponse {
  content: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface LLMStreamChunk {
  content: string;
  done: boolean;
}

/**
 * Abstraction over LLM providers. The SimpleReflector and sandbox harnesses
 * consume this instead of directly importing LangChain.
 */
export interface LLMProvider extends ServiceModule {
  invoke(prompt: string, systemPrompt?: string): Promise<LLMResponse>;
  invokeStream?(prompt: string, systemPrompt?: string): AsyncGenerator<LLMStreamChunk>;
  /** Returns the underlying chat model for framework integration (e.g. LangGraph). */
  getChatModel?(): unknown;
}
