import type { LLMProvider } from '../llm/types.js';
import type { ExecutionTrace, FeedbackSignal, Insight } from './types.js';

const CONFIDENCE_THRESHOLD = 0.3;

export class SimpleReflector {
  private llmProvider: LLMProvider;


  constructor(llmProvider: LLMProvider) {
    this.llmProvider = llmProvider;
  }

  async process(
    trace: ExecutionTrace,
    feedback?: FeedbackSignal[],
  ): Promise<Insight[]> {
    if (!trace.steps.length && !trace.taskDescription) return [];

    const prompt = this.buildReflectionPrompt(trace, feedback);

    const response = await this.llmProvider.invoke(prompt);

    return this.parseInsights(response.content);
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.warn('[Reflector] Failed to parse LLM response:', cleaned.substring(0, 200));

      // Fallback: try extracting JSON array by finding first [ and last ]
      const firstBracket = cleaned.indexOf('[');
      const lastBracket = cleaned.lastIndexOf(']');
      if (firstBracket !== -1 && lastBracket > firstBracket) {
        try {
          parsed = JSON.parse(cleaned.slice(firstBracket, lastBracket + 1));
        } catch {
          console.warn('[Reflector] Fallback JSON extraction also failed');
          return [];
        }
      } else {
        return [];
      }
    }

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
        const clampedConfidence = Math.max(0, Math.min(1, confidence));

        if (clampedConfidence < CONFIDENCE_THRESHOLD) {
          console.log(`[Reflector] Rejected low-confidence insight (${clampedConfidence}): ${content.substring(0, 100)}`);
          continue;
        }

        insights.push({
          content,
          category,
          confidence: clampedConfidence,
        });
      }
    }
    return insights;
  }
}
