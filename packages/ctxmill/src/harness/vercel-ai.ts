import { randomUUID } from 'node:crypto';
import { streamText as _streamText, stepCountIs as _stepCountIs, type LanguageModel, type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { AgentHarness, AgentEvent, HarnessRunConfig, TokenUsage } from './types.js';
import type { ToolContext } from '../tool/types.js';
import { createStubKnowledgeContext } from './shared.js';

/**
 * Build a Vercel AI SDK language model from the harness model config.
 * Supports openai, anthropic, and google providers.
 */
export function buildModel(config: HarnessRunConfig): LanguageModel {
  const { provider, model, baseUrl, apiKeyRef } = config.modelConfig;
  const resolvedApiKey = apiKeyRef ? config.secrets[apiKeyRef] : undefined;

  switch (provider) {
    case 'openai': {
      const openai = createOpenAI({
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        ...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
      });
      return openai(model);
    }
    case 'anthropic': {
      const anthropic = createAnthropic({
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        ...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
      });
      return anthropic(model);
    }
    case 'google': {
      const google = createGoogleGenerativeAI({
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        ...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
      });
      return google(model);
    }
    default:
      throw new Error(
        `VercelAIHarness: unsupported provider "${provider}". Supported: openai, anthropic, google`,
      );
  }
}

/**
 * Convert ctxmill Message[] to Vercel AI SDK ModelMessage[].
 */
export function convertMessages(messages: HarnessRunConfig['messages']): ModelMessage[] {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
    .map((m) => {
      const role = m.role as 'user' | 'assistant' | 'system';
      return { role, content: m.content } as ModelMessage;
    });
}

/**
 * Internal dependencies that can be overridden for testing.
 * @internal
 */
export interface VercelAIDeps {
  streamText: typeof _streamText;
  stepCountIs: typeof _stepCountIs;
  buildModel: typeof buildModel;
}

const defaultDeps: VercelAIDeps = {
  streamText: _streamText,
  stepCountIs: _stepCountIs,
  buildModel,
};

/**
 * Vercel AI SDK harness adapter (v6+).
 *
 * Uses streamText() with stopWhen(stepCountIs(10)) for automatic tool-calling
 * loop. Maps Vercel AI SDK stream parts to AgentEvent types.
 */
export class VercelAIHarness implements AgentHarness {
  readonly name = 'vercel-ai';
  /** @internal */
  readonly deps: VercelAIDeps;

  constructor(deps?: Partial<VercelAIDeps>) {
    this.deps = { ...defaultDeps, ...deps };
  }

  async *run(config: HarnessRunConfig): AsyncGenerator<AgentEvent> {
    try {
      const model = this.deps.buildModel(config);

      // Build a ToolContext for tool execution
      const toolContext: ToolContext = {
        agentId: config.agentId,
        conversationId: config.conversationId,
        workspaceDir: config.workspaceDir || process.cwd(),
        eventBus: config.eventBus ?? undefined,
        knowledge: createStubKnowledgeContext(),
      };

      // Convert ctxmill tools to AI SDK v6 tools.
      // We build Tool objects directly (inputSchema + execute) rather than
      // using the `tool()` helper, which has strict overloads that fight
      // with our generic ToolDefinition[] typing.
      const aiTools: Record<string, any> = {};
      for (const t of config.tools) {
        aiTools[t.name] = {
          description: t.description,
          inputSchema: t.input,
          execute: async (args: Record<string, unknown>) => {
            // HITL: check approval before executing
            if (t.requiresApproval && config.onApprovalNeeded) {
              const approvalReq = {
                id: randomUUID(),
                runId: config.runId,
                toolName: t.name,
                args,
              };
              const response = await config.onApprovalNeeded(approvalReq);
              if (response.action !== 'approve') {
                throw new Error('Tool call was rejected by the user.');
              }
            }

            const result = await t.handler(args, toolContext);
            return result;
          },
        };
      }

      const messages = convertMessages(config.messages);

      const result = this.deps.streamText({
        model,
        system: config.systemPrompt,
        messages,
        tools: aiTools,
        stopWhen: this.deps.stepCountIs(10),
        ...(config.modelConfig.temperature != null
          ? { temperature: config.modelConfig.temperature }
          : {}),
        ...(config.modelConfig.maxTokens != null
          ? { maxOutputTokens: config.modelConfig.maxTokens }
          : {}),
        ...(config.modelConfig.topP != null
          ? { topP: config.modelConfig.topP }
          : {}),
        ...(config.signal ? { abortSignal: config.signal } : {}),
      });

      // Track tool call timing
      const toolTimers = new Map<string, number>();

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta': {
            // In AI SDK v6, the text content field is named `delta`
            yield { type: 'text_delta', content: (part as any).delta ?? (part as any).textDelta ?? '' };
            break;
          }

          case 'tool-call': {
            const toolCallId = part.toolCallId;
            toolTimers.set(toolCallId, Date.now());
            yield {
              type: 'tool_call_start',
              id: toolCallId,
              name: part.toolName,
              args: (part as any).input ?? (part as any).args ?? {},
            };
            break;
          }

          case 'tool-result': {
            const startTime = toolTimers.get(part.toolCallId) ?? Date.now();
            const durationMs = Date.now() - startTime;
            toolTimers.delete(part.toolCallId);
            const rawOutput = (part as any).output ?? (part as any).result;
            yield {
              type: 'tool_call_end',
              id: part.toolCallId,
              result: typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput),
              durationMs,
            };
            break;
          }

          case 'error': {
            yield { type: 'error', error: String((part as any).error) };
            break;
          }

          case 'finish': {
            // In v6, usage info is in `totalUsage` (multi-step) or `usage` (single-step)
            const usageData = (part as any).totalUsage ?? (part as any).usage;
            const usage: TokenUsage | undefined = usageData
              ? {
                  inputTokens: usageData.inputTokens ?? usageData.promptTokens ?? 0,
                  outputTokens: usageData.outputTokens ?? usageData.completionTokens ?? 0,
                  totalTokens:
                    usageData.totalTokens ??
                    ((usageData.inputTokens ?? usageData.promptTokens ?? 0) +
                      (usageData.outputTokens ?? usageData.completionTokens ?? 0)),
                }
              : undefined;
            yield { type: 'done', usage };
            break;
          }
        }
      }
    } catch (err) {
      yield { type: 'error', error: String(err) };
    }
  }
}
