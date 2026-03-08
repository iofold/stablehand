import { describe, it, expect, vi } from 'vitest';
import { SimpleReflector } from '../../packages/ctxmill/src/learning/reflector.js';
import type { LLMProvider, LLMResponse } from '../../packages/ctxmill/src/llm/types.js';
import type { ExecutionTrace, FeedbackSignal, Insight } from '../../packages/ctxmill/src/learning/types.js';

// ── Helpers ──────────────────────────────────────────────────────

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: 'trace-1',
    agentId: 'agent-1',
    runId: 'run-1',
    taskDescription: 'Summarize a document',
    steps: [
      { ordinal: 0, type: 'llm_call', content: 'Called model', durationMs: 200, metadata: {} },
      { ordinal: 1, type: 'tool_call', content: 'read_file ./doc.md', durationMs: 50, metadata: {} },
    ],
    startedAt: new Date('2026-03-07T10:00:00Z'),
    completedAt: new Date('2026-03-07T10:00:01Z'),
    outcome: 'success',
    metadata: {},
    ...overrides,
  };
}

function createMockLLMProvider(responseContent: string): LLMProvider {
  return {
    name: 'mock-llm',
    invoke: vi.fn().mockResolvedValue({
      content: responseContent,
      usage: { inputTokens: 100, outputTokens: 50 },
    } satisfies LLMResponse),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('SimpleReflector', () => {
  describe('process()', () => {
    it('should call LLMProvider.invoke with the reflection prompt', async () => {
      const provider = createMockLLMProvider('[]');
      const reflector = new SimpleReflector(provider);

      await reflector.process(makeTrace());

      expect(provider.invoke).toHaveBeenCalledTimes(1);
      const prompt = (provider.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(prompt).toContain('Summarize a document');
      expect(prompt).toContain('success');
      expect(prompt).toContain('Called model');
    });

    it('should parse valid JSON insights from LLM response', async () => {
      const insights: Insight[] = [
        { content: 'Always validate input', category: 'strategy', confidence: 0.85 },
        { content: 'User prefers short output', category: 'preference', confidence: 0.7 },
      ];
      const provider = createMockLLMProvider(JSON.stringify(insights));
      const reflector = new SimpleReflector(provider);

      const result = await reflector.process(makeTrace());

      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('Always validate input');
      expect(result[0].category).toBe('strategy');
      expect(result[0].confidence).toBe(0.85);
      expect(result[1].content).toBe('User prefers short output');
    });

    it('should handle markdown-wrapped JSON response', async () => {
      const insights = [{ content: 'Test insight', category: 'fact', confidence: 0.9 }];
      const wrappedResponse = '```json\n' + JSON.stringify(insights) + '\n```';
      const provider = createMockLLMProvider(wrappedResponse);
      const reflector = new SimpleReflector(provider);

      const result = await reflector.process(makeTrace());

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('Test insight');
    });

    it('should return empty array for invalid JSON response', async () => {
      const provider = createMockLLMProvider('This is not JSON at all');
      const reflector = new SimpleReflector(provider);

      const result = await reflector.process(makeTrace());

      expect(result).toEqual([]);
    });

    it('should return empty array when trace has no steps and no task description', async () => {
      const provider = createMockLLMProvider('[]');
      const reflector = new SimpleReflector(provider);

      const result = await reflector.process(makeTrace({ steps: [], taskDescription: '' }));

      expect(result).toEqual([]);
      expect(provider.invoke).not.toHaveBeenCalled();
    });

    it('should clamp confidence values to [0, 1] and reject below threshold', async () => {
      const insights = [
        { content: 'Over-confident', category: 'fact', confidence: 1.5 },
        { content: 'Negative confidence', category: 'fact', confidence: -0.3 },
        { content: 'Borderline low', category: 'fact', confidence: 0.2 },
        { content: 'Above threshold', category: 'fact', confidence: 0.5 },
      ];
      const provider = createMockLLMProvider(JSON.stringify(insights));
      const reflector = new SimpleReflector(provider);

      const result = await reflector.process(makeTrace());

      // Over-confident clamped to 1, above threshold passes
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('Over-confident');
      expect(result[0].confidence).toBe(1);
      expect(result[1].content).toBe('Above threshold');
      expect(result[1].confidence).toBe(0.5);
      // Negative (-0.3 -> 0) and borderline (0.2) are below 0.3 threshold, rejected
    });

    it('should include feedback in the prompt when provided', async () => {
      const provider = createMockLLMProvider('[]');
      const reflector = new SimpleReflector(provider);

      const feedback: FeedbackSignal[] = [
        {
          id: 'fb-1',
          traceId: 'trace-1',
          agentId: 'agent-1',
          source: 'human',
          type: 'thumbs',
          value: { thumbs: 'up' },
          createdAt: new Date(),
        },
      ];

      await reflector.process(makeTrace(), feedback);

      const prompt = (provider.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(prompt).toContain('Feedback received');
      expect(prompt).toContain('human');
      expect(prompt).toContain('thumbs');
    });

    it('should filter out items with missing required fields', async () => {
      const mixed = [
        { content: 'Valid insight', category: 'fact', confidence: 0.8 },
        { content: 'Missing confidence', category: 'fact' },
        { category: 'fact', confidence: 0.5 },
        null,
      ];
      const provider = createMockLLMProvider(JSON.stringify(mixed));
      const reflector = new SimpleReflector(provider);

      const result = await reflector.process(makeTrace());

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('Valid insight');
    });
  });
});
