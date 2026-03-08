import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ExecutionTrace, FeedbackSignal, Insight } from './types.js';

export interface ReflectorConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  provider?: 'anthropic' | 'openai';
}

export class SimpleReflector {
  private chatModel: BaseChatModel;

  constructor(config: ReflectorConfig) {
    const model = config.model ?? 'claude-sonnet-4-6';
    const isOpenAI = config.provider === 'openai' || (!model.includes('claude') && config.provider !== 'anthropic');

    if (isOpenAI) {
      this.chatModel = new ChatOpenAI({
        model,
        apiKey: config.apiKey,
        maxTokens: 1024,
        configuration: {
          baseURL: config.baseUrl,
        },
      });
    } else {
      this.chatModel = new ChatAnthropic({
        model,
        apiKey: config.apiKey,
        maxTokens: 1024,
        ...(config.baseUrl
          ? { clientOptions: { baseURL: config.baseUrl } }
          : {}),
      });
    }
  }

  async process(
    trace: ExecutionTrace,
    feedback?: FeedbackSignal[],
  ): Promise<Insight[]> {
    if (!trace.steps.length) return [];

    const prompt = this.buildReflectionPrompt(trace, feedback);

    const response = await this.chatModel.invoke([
      new HumanMessage(prompt),
    ]);

    const text =
      typeof response.content === 'string'
        ? response.content
        : '';
    return this.parseInsights(text);
  }

  private buildReflectionPrompt(
    trace: ExecutionTrace,
    feedback?: FeedbackSignal[],
  ): string {
    const stepsSummary = trace.steps
      .map(
        (s) =>
          `  ${s.ordinal}. [${s.type}] (${s.durationMs}ms) ${s.content.slice(0, 200)}`,
      )
      .join('\n');

    const feedbackSection =
      feedback && feedback.length > 0
        ? `\n\nFeedback received:\n${feedback
            .map(
              (f) =>
                `- [${f.source}/${f.type}] ${JSON.stringify(f.value)}`,
            )
            .join('\n')}`
        : '';

    return `You are analyzing an agent execution trace to extract actionable insights for future runs.

Task: ${trace.taskDescription}
Outcome: ${trace.outcome}
Duration: ${new Date(trace.completedAt).getTime() - new Date(trace.startedAt).getTime()}ms
Steps (${trace.steps.length}):
${stepsSummary}${feedbackSection}

Extract insights from this execution. For each insight, determine:
- content: A concise, actionable statement the agent can use in future runs
- category: One of "strategy", "fact", "preference", or "correction"
- confidence: A number from 0 to 1 indicating how confident you are

Respond with ONLY a JSON array of objects with { "content", "category", "confidence" } fields. No other text.`;
  }

  private parseInsights(text: string): Insight[] {
    // Strip markdown code blocks if present
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      const firstNewline = cleaned.indexOf('\n');
      const lastFence = cleaned.lastIndexOf('```');
      if (firstNewline !== -1 && lastFence > firstNewline) {
        cleaned = cleaned.slice(firstNewline + 1, lastFence).trim();
      }
    }

    try {
      const parsed = JSON.parse(cleaned) as unknown;
      if (!Array.isArray(parsed)) return [];

      const insights: Insight[] = [];
      for (const item of parsed) {
        if (
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>).content === 'string' &&
          typeof (item as Record<string, unknown>).category === 'string' &&
          typeof (item as Record<string, unknown>).confidence === 'number'
        ) {
          const { content, category, confidence } = item as Insight;
          insights.push({
            content,
            category,
            confidence: Math.max(0, Math.min(1, confidence)),
          });
        }
      }
      return insights;
    } catch {
      return [];
    }
  }
}
