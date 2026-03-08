import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { LLMProvider, LLMProviderConfig, LLMResponse, LLMStreamChunk } from './types.js';

/** Minimal interface for a chat model that can invoke messages. */
export interface ChatModel {
  invoke(messages: unknown[], options?: Record<string, unknown>): Promise<{ content: string | unknown[]; usage_metadata?: { input_tokens?: number; output_tokens?: number } }>;
}

/** Check if an error carries one of the given HTTP status codes. */
function isHttpError(err: unknown, codes: number[]): boolean {
  if (err == null || typeof err !== 'object') return false;
  const status = (err as Record<string, unknown>).status ?? (err as Record<string, unknown>).statusCode;
  return typeof status === 'number' && codes.includes(status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LangChainLLMProvider implements LLMProvider {
  readonly name: string;
  /** @internal visible for testing */
  _model: ChatModel;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: LLMProviderConfig);
  constructor(config: LLMProviderConfig, model: ChatModel);
  constructor(config: LLMProviderConfig, model?: ChatModel) {
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.maxRetries = config.maxRetries ?? 3;
    if (config.provider === 'anthropic') {
      this.name = 'langchain-anthropic';
      this._model = model ?? new ChatAnthropic({
        anthropicApiKey: config.apiKey,
        anthropicApiUrl: config.baseUrl || undefined,
        modelName: config.model,
      }) as unknown as ChatModel;
    } else {
      this.name = 'langchain-openai';
      this._model = model ?? new ChatOpenAI({
        apiKey: config.apiKey,
        configuration: config.baseUrl ? { baseURL: config.baseUrl } : undefined,
        modelName: config.model,
      }) as unknown as ChatModel;
    }
  }

  async invoke(prompt: string, systemPrompt?: string): Promise<LLMResponse> {
    const messages = [];
    if (systemPrompt) messages.push(new SystemMessage(systemPrompt));
    messages.push(new HumanMessage(prompt));

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let result: Awaited<ReturnType<ChatModel['invoke']>>;
        try {
          result = await this._model.invoke(messages, { signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }

        const content = typeof result.content === 'string'
          ? result.content
          : JSON.stringify(result.content);

        const usage = result.usage_metadata;

        return {
          content,
          usage: {
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
          },
        };
      } catch (err: unknown) {
        lastError = err;

        // Non-retryable status codes — throw immediately
        if (isHttpError(err, [400, 401, 403])) {
          throw err;
        }

        if (attempt < this.maxRetries) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[LLM] Retry attempt ${attempt + 1}/${this.maxRetries}: ${message}`);
          await sleep(Math.pow(2, attempt) * 1000);
        }
      }
    }

    throw lastError;
  }

  /** Expose the underlying LangChain ChatModel for framework integration. */
  getChatModel(): ChatModel {
    return this._model;
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  async shutdown(): Promise<void> {
    // LangChain models don't require explicit cleanup
  }
}
