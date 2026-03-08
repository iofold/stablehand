import type { ExecutionTrace, FeedbackSignal, Insight, LearningPipeline } from './types.js';
import type { KnowledgeStore } from '../knowledge/types.js';
import type { SimpleReflector } from './reflector.js';
import type { DatabaseRepository } from '../database/repository.js';

export class DefaultLearningPipeline implements LearningPipeline {
  private reflector: SimpleReflector;
  private knowledgeStore: KnowledgeStore;
  private db?: DatabaseRepository;

  constructor(reflector: SimpleReflector, knowledgeStore: KnowledgeStore, db?: DatabaseRepository) {
    this.reflector = reflector;
    this.knowledgeStore = knowledgeStore;
    this.db = db;
  }

  async process(
    trace: ExecutionTrace,
    feedback?: FeedbackSignal[],
  ): Promise<Insight[]> {
    // Persist the trace to DB
    if (this.db) {
      try {
        await this.db.saveTrace({
          id: trace.id,
          agentId: trace.agentId,
          runId: trace.runId,
          taskDescription: trace.taskDescription,
          steps: trace.steps as any,
          startedAt: trace.startedAt.getTime(),
          completedAt: trace.completedAt.getTime(),
          outcome: trace.outcome,
        });
      } catch (err) {
        console.error('Failed to save trace to DB:', err);
      }
    }

    const insights = await this.reflector.process(trace, feedback);

    for (const insight of insights) {
      await this.knowledgeStore.add({
        agentId: trace.agentId,
        content: insight.content,
        category: insight.category,
        source: 'reflector',
        effectiveness: 0, // neutral until proven
      });
    }

    return insights;
  }

  async getKnowledge(agentId: string): Promise<string> {
    return this.knowledgeStore.render(agentId);
  }
}
