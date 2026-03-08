/**
 * LearningPipeline Interface Compliance Suite
 *
 * Tests that any implementation of the LearningPipeline interface
 * (from packages/ctxmill/src/learning/types.ts) satisfies the
 * behavioral contract:
 *
 *   process(trace, feedback?) => Promise<LearningResult>
 *   getKnowledge(agentId)     => Promise<string>
 *
 * Consumers provide a factory that returns a fresh pipeline instance.
 */

import { describe, it, expect } from 'vitest';
import type {
  LearningPipeline,
  ExecutionTrace,
  FeedbackSignal,
  Insight,
} from '../../packages/ctxmill/src/learning/types.js';

// ── Test data builders ──────────────────────────────────────────

export function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: 'trace-compliance-1',
    agentId: 'agent-compliance',
    runId: 'run-compliance-1',
    taskDescription: 'Compliance test task',
    steps: [
      { ordinal: 0, type: 'llm_call', content: 'Called model', durationMs: 100, metadata: {} },
      { ordinal: 1, type: 'tool_call', content: 'read_file ./test.md', durationMs: 25, metadata: {} },
    ],
    startedAt: new Date('2026-03-08T00:00:00Z'),
    completedAt: new Date('2026-03-08T00:00:01Z'),
    outcome: 'success',
    metadata: {},
    ...overrides,
  };
}

export function makeFeedback(overrides: Partial<FeedbackSignal> = {}): FeedbackSignal {
  return {
    id: 'fb-compliance-1',
    traceId: 'trace-compliance-1',
    agentId: 'agent-compliance',
    source: 'human',
    type: 'thumbs',
    value: { thumbs: 'up' },
    createdAt: new Date(),
    ...overrides,
  };
}

// ── Compliance suite factory ────────────────────────────────────

export interface ComplianceSuiteOptions {
  /** Creates a fresh pipeline instance for each test. */
  createPipeline: () => LearningPipeline | Promise<LearningPipeline>;

  /**
   * If the pipeline stores insights, this returns the stored items for
   * verification. Return null to skip storage assertions.
   */
  getStoredInsights?: (agentId: string) => Promise<{ content: string; category: string }[] | null>;

  /**
   * Seeds knowledge items so getKnowledge() has data to return.
   * Return null to skip getKnowledge render assertions.
   */
  seedKnowledge?: (agentId: string, items: { content: string; category: string; effectiveness: number }[]) => Promise<void>;
}

export function learningPipelineComplianceSuite(opts: ComplianceSuiteOptions): void {
  // ── process() contract ──────────────────────────────────────

  describe('LearningPipeline.process() contract', () => {
    it('returns a Promise that resolves to a LearningResult with insights and errors', async () => {
      const pipeline = await opts.createPipeline();
      const result = await pipeline.process(makeTrace());
      expect(result).toHaveProperty('insights');
      expect(result).toHaveProperty('errors');
      expect(Array.isArray(result.insights)).toBe(true);
      expect(Array.isArray(result.errors)).toBe(true);
    });

    it('each returned insight has content (string), category (string), confidence (number)', async () => {
      const pipeline = await opts.createPipeline();
      const result = await pipeline.process(makeTrace());
      for (const insight of result.insights) {
        expect(typeof insight.content).toBe('string');
        expect(typeof insight.category).toBe('string');
        expect(typeof insight.confidence).toBe('number');
      }
    });

    it('confidence values are in [0, 1] range', async () => {
      const pipeline = await opts.createPipeline();
      const result = await pipeline.process(makeTrace());
      for (const insight of result.insights) {
        expect(insight.confidence).toBeGreaterThanOrEqual(0);
        expect(insight.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('accepts an optional feedback array as the second argument', async () => {
      const pipeline = await opts.createPipeline();
      const feedback = [makeFeedback()];
      // Should not throw
      const result = await pipeline.process(makeTrace(), feedback);
      expect(Array.isArray(result.insights)).toBe(true);
    });

    it('works with an empty steps trace', async () => {
      const pipeline = await opts.createPipeline();
      const result = await pipeline.process(makeTrace({ steps: [] }));
      expect(Array.isArray(result.insights)).toBe(true);
    });

    it('works with all outcome variants', async () => {
      const pipeline = await opts.createPipeline();
      for (const outcome of ['success', 'failure', 'partial', 'unknown'] as const) {
        const result = await pipeline.process(makeTrace({ outcome }));
        expect(Array.isArray(result.insights)).toBe(true);
      }
    });
  });

  // ── Storage verification (optional) ────────────────────────

  if (opts.getStoredInsights) {
    describe('LearningPipeline.process() stores insights', () => {
      it('persists returned insights to the knowledge store', async () => {
        const pipeline = await opts.createPipeline();
        const result = await pipeline.process(makeTrace());

        const stored = await opts.getStoredInsights!('agent-compliance');
        if (stored === null) return; // skip if not applicable

        expect(stored.length).toBe(result.insights.length);
        for (const insight of result.insights) {
          expect(stored.some((s) => s.content === insight.content && s.category === insight.category)).toBe(true);
        }
      });
    });
  }

  // ── getKnowledge() contract ─────────────────────────────────

  describe('LearningPipeline.getKnowledge() contract', () => {
    it('returns a Promise that resolves to a string', async () => {
      const pipeline = await opts.createPipeline();
      const result = await pipeline.getKnowledge('nonexistent-agent');
      expect(typeof result).toBe('string');
    });

    it('returns empty string for an agent with no knowledge', async () => {
      const pipeline = await opts.createPipeline();
      const result = await pipeline.getKnowledge('agent-with-no-data-' + Date.now());
      expect(result).toBe('');
    });
  });

  // ── getKnowledge() with seeded data (optional) ─────────────

  if (opts.seedKnowledge) {
    describe('LearningPipeline.getKnowledge() renders seeded knowledge', () => {
      it('includes seeded item content in the rendered output', async () => {
        const agentId = 'agent-seed-test';
        await opts.seedKnowledge!(agentId, [
          { content: 'Always validate JSON', category: 'strategy', effectiveness: 0.9 },
          { content: 'User prefers concise output', category: 'preference', effectiveness: 0.5 },
        ]);

        const pipeline = await opts.createPipeline();
        const rendered = await pipeline.getKnowledge(agentId);

        expect(rendered).toContain('Always validate JSON');
        expect(rendered).toContain('User prefers concise output');
      });
    });
  }
}
