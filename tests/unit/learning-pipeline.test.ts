import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TraceCollector } from '../../packages/ctxmill/src/learning/trace.js';
import { DefaultLearningPipeline } from '../../packages/ctxmill/src/learning/pipeline.js';
import { InMemoryKnowledgeStore } from '../../packages/ctxmill/src/knowledge/store.js';
import type { ExecutionTrace, FeedbackSignal, Insight } from '../../packages/ctxmill/src/learning/types.js';
import type { SimpleReflector } from '../../packages/ctxmill/src/learning/reflector.js';

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

function makeFeedback(overrides: Partial<FeedbackSignal> = {}): FeedbackSignal {
  return {
    id: 'fb-1',
    traceId: 'trace-1',
    agentId: 'agent-1',
    source: 'human',
    type: 'thumbs',
    value: { thumbs: 'up' },
    createdAt: new Date(),
    ...overrides,
  };
}

/** A mock reflector that returns canned insights without any LLM call. */
function createMockReflector(insights: Insight[]): SimpleReflector {
  return {
    process: vi.fn().mockResolvedValue(insights),
  } as unknown as SimpleReflector;
}

// ── Tests ────────────────────────────────────────────────────────

describe('TraceCollector', () => {
  // LRN-08: TraceCollector captures steps and finalizes
  describe('LRN-08: capture steps and finalize', () => {
    it('should start with no steps', () => {
      const collector = new TraceCollector('agent-1', 'run-1', 'Test task');
      const trace = collector.finalize('success');
      expect(trace.steps).toEqual([]);
    });

    it('should capture steps in order', () => {
      const collector = new TraceCollector('agent-1', 'run-1', 'Test task');
      collector.addStep('llm_call', 'Called model', 150);
      collector.addStep('tool_call', 'read_file ./data.csv', 30);
      collector.addStep('llm_call', 'Processed result', 200);

      const trace = collector.finalize('success');
      expect(trace.steps).toHaveLength(3);
      expect(trace.steps[0].ordinal).toBe(0);
      expect(trace.steps[0].type).toBe('llm_call');
      expect(trace.steps[0].content).toBe('Called model');
      expect(trace.steps[0].durationMs).toBe(150);
      expect(trace.steps[1].ordinal).toBe(1);
      expect(trace.steps[1].type).toBe('tool_call');
      expect(trace.steps[2].ordinal).toBe(2);
    });

    it('should populate trace metadata on finalize', () => {
      const collector = new TraceCollector('agent-1', 'run-1', 'Summarize docs');
      collector.addStep('llm_call', 'hello', 100);

      const trace = collector.finalize('failure');
      expect(trace.id).toBeDefined();
      expect(trace.agentId).toBe('agent-1');
      expect(trace.runId).toBe('run-1');
      expect(trace.taskDescription).toBe('Summarize docs');
      expect(trace.outcome).toBe('failure');
      expect(trace.startedAt).toBeInstanceOf(Date);
      expect(trace.completedAt).toBeInstanceOf(Date);
      expect(trace.completedAt.getTime()).toBeGreaterThanOrEqual(trace.startedAt.getTime());
    });

    it('should accept optional metadata per step', () => {
      const collector = new TraceCollector('agent-1', 'run-1', 'task');
      collector.addStep('tool_call', 'bash ls', 10, { exitCode: 0 });
      const trace = collector.finalize('success');
      expect(trace.steps[0].metadata).toEqual({ exitCode: 0 });
    });

    it('should default step metadata to empty object', () => {
      const collector = new TraceCollector('agent-1', 'run-1', 'task');
      collector.addStep('llm_call', 'call', 100);
      const trace = collector.finalize('success');
      expect(trace.steps[0].metadata).toEqual({});
    });

    it('should produce a unique trace id each time', () => {
      const c1 = new TraceCollector('a', 'r', 't');
      const c2 = new TraceCollector('a', 'r', 't');
      const t1 = c1.finalize('success');
      const t2 = c2.finalize('success');
      expect(t1.id).not.toBe(t2.id);
    });
  });
});

describe('DefaultLearningPipeline', () => {
  let tempDir: string;
  let store: InMemoryKnowledgeStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ctxmill-lrn-test-'));
    store = new InMemoryKnowledgeStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // LRN-02: Feedback signal storage (pipeline processes feedback)
  describe('LRN-02: feedback signal handling', () => {
    it('should pass feedback signals through to the reflector', async () => {
      const mockReflector = createMockReflector([]);
      const pipeline = new DefaultLearningPipeline(mockReflector, store);

      const trace = makeTrace();
      const feedback = [makeFeedback()];
      await pipeline.process(trace, feedback);

      expect(mockReflector.process).toHaveBeenCalledWith(trace, feedback);
    });

    it('should handle processing with no feedback', async () => {
      const mockReflector = createMockReflector([
        { content: 'Check inputs first', category: 'strategy', confidence: 0.8 },
      ]);
      const pipeline = new DefaultLearningPipeline(mockReflector, store);

      const result = await pipeline.process(makeTrace());
      expect(result.insights).toHaveLength(1);
      expect(result.insights[0].content).toBe('Check inputs first');
      expect(result.errors).toHaveLength(0);
    });
  });

  // LRN-04: Knowledge store add + retrieve
  describe('LRN-04: knowledge store add + retrieve', () => {
    it('should store insights from reflector into the knowledge store', async () => {
      const insights: Insight[] = [
        { content: 'Always validate JSON before parsing', category: 'strategy', confidence: 0.9 },
        { content: 'User prefers concise output', category: 'preference', confidence: 0.7 },
      ];
      const mockReflector = createMockReflector(insights);
      const pipeline = new DefaultLearningPipeline(mockReflector, store);

      await pipeline.process(makeTrace());

      const items = await store.list('agent-1');
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.content).sort()).toEqual([
        'Always validate JSON before parsing',
        'User prefers concise output',
      ]);
      // All items should have source 'reflector' and effectiveness 0
      for (const item of items) {
        expect(item.source).toBe('reflector');
        expect(item.effectiveness).toBe(0);
      }
    });

    it('should return the insights from the reflector', async () => {
      const insights: Insight[] = [
        { content: 'Insight A', category: 'fact', confidence: 0.6 },
      ];
      const mockReflector = createMockReflector(insights);
      const pipeline = new DefaultLearningPipeline(mockReflector, store);

      const result = await pipeline.process(makeTrace());
      expect(result.insights).toEqual(insights);
      expect(result.errors).toEqual([]);
    });

    it('should handle empty insights gracefully', async () => {
      const mockReflector = createMockReflector([]);
      const pipeline = new DefaultLearningPipeline(mockReflector, store);

      const result = await pipeline.process(makeTrace());
      expect(result.insights).toEqual([]);
      expect(result.errors).toEqual([]);

      const items = await store.list('agent-1');
      expect(items).toHaveLength(0);
    });
  });

  // LRN-05: Knowledge store render for prompt
  describe('LRN-05: knowledge render for prompt', () => {
    it('should render knowledge as markdown for prompt injection', async () => {
      // Seed knowledge directly
      await store.add({
        agentId: 'agent-1',
        content: 'Always use structured output',
        category: 'strategy',
        source: 'reflector',
        effectiveness: 0.8,
      });
      await store.add({
        agentId: 'agent-1',
        content: 'The API requires auth headers',
        category: 'fact',
        source: 'human',
        effectiveness: 0.5,
      });

      const mockReflector = createMockReflector([]);
      const pipeline = new DefaultLearningPipeline(mockReflector, store);

      const rendered = await pipeline.getKnowledge('agent-1');
      expect(rendered).toContain('# Agent Knowledge');
      expect(rendered).toContain('## strategy');
      expect(rendered).toContain('## fact');
      expect(rendered).toContain('Always use structured output');
      expect(rendered).toContain('The API requires auth headers');
      expect(rendered).toContain('[+0.8]');
      expect(rendered).toContain('[+0.5]');
    });

    it('should return empty string for agent with no knowledge', async () => {
      const mockReflector = createMockReflector([]);
      const pipeline = new DefaultLearningPipeline(mockReflector, store);

      const rendered = await pipeline.getKnowledge('unknown-agent');
      expect(rendered).toBe('');
    });

    it('should render items sorted by effectiveness descending', async () => {
      await store.add({ agentId: 'a1', content: 'Low', category: 'strategy', source: 'reflector', effectiveness: 0.1 });
      await store.add({ agentId: 'a1', content: 'High', category: 'strategy', source: 'reflector', effectiveness: 0.9 });
      await store.add({ agentId: 'a1', content: 'Medium', category: 'strategy', source: 'reflector', effectiveness: 0.5 });

      const mockReflector = createMockReflector([]);
      const pipeline = new DefaultLearningPipeline(mockReflector, store);

      const rendered = await pipeline.getKnowledge('a1');
      const highIdx = rendered.indexOf('High');
      const medIdx = rendered.indexOf('Medium');
      const lowIdx = rendered.indexOf('Low');
      expect(highIdx).toBeLessThan(medIdx);
      expect(medIdx).toBeLessThan(lowIdx);
    });
  });
});
