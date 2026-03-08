/**
 * DefaultLearningPipeline compliance test
 *
 * Runs the LearningPipeline compliance suite against the real
 * DefaultLearningPipeline class, using mocked dependencies
 * (SimpleReflector, KnowledgeStore, no DB).
 */

import { describe, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DefaultLearningPipeline } from '../../packages/ctxmill/src/learning/pipeline.js';
import { InMemoryKnowledgeStore } from '../../packages/ctxmill/src/knowledge/store.js';
import type { SimpleReflector } from '../../packages/ctxmill/src/learning/reflector.js';
import type { Insight } from '../../packages/ctxmill/src/learning/types.js';
import { learningPipelineComplianceSuite } from './learning-pipeline.compliance.js';

// ── Canned insights the mock reflector will return ──────────

const CANNED_INSIGHTS: Insight[] = [
  { content: 'Validate inputs before processing', category: 'strategy', confidence: 0.85 },
  { content: 'User prefers bullet-point format', category: 'preference', confidence: 0.7 },
];

// ── Shared state across the suite ───────────────────────────

let tempDir: string;
let store: InMemoryKnowledgeStore;
let mockReflector: SimpleReflector;

describe('DefaultLearningPipeline compliance', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ctxmill-compliance-'));
    store = new InMemoryKnowledgeStore(tempDir);
    mockReflector = {
      process: vi.fn().mockResolvedValue(CANNED_INSIGHTS),
    } as unknown as SimpleReflector;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  learningPipelineComplianceSuite({
    createPipeline: () => new DefaultLearningPipeline(mockReflector, store),

    getStoredInsights: async (agentId: string) => {
      const items = await store.list(agentId);
      return items.map((i) => ({ content: i.content, category: i.category }));
    },

    seedKnowledge: async (agentId, items) => {
      for (const item of items) {
        await store.add({
          agentId,
          content: item.content,
          category: item.category,
          source: 'reflector',
          effectiveness: item.effectiveness,
        });
      }
    },
  });
});
