import type { ExecutionTrace, FeedbackSignal, LearningPipeline, LearningResult } from './types.js';
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
  ): Promise<LearningResult> {
    const errors: string[] = [];

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
        console.error('[LearningPipeline] Trace save failed for', trace.id, err);
        errors.push(`Trace save failed for ${trace.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const insights = await this.reflector.process(trace, feedback);

    for (const insight of insights) {
      try {
        await this.knowledgeStore.add({
          agentId: trace.agentId,
          content: insight.content,
          category: insight.category,
          source: 'reflector',
          effectiveness: 0, // neutral until proven
        });
      } catch (err) {
        const msg = `Knowledge store add failed for insight "${insight.content.substring(0, 50)}": ${err instanceof Error ? err.message : String(err)}`;
        console.error('[LearningPipeline]', msg);
        errors.push(msg);
      }
    }

    return { insights, errors };
  }

  async getKnowledge(agentId: string): Promise<string> {
    return this.knowledgeStore.render(agentId);
  }
}
