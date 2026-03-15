import type { ExecutionTrace, FeedbackSignal, LearningPipeline, LearningResult } from './types.js';
import type { KnowledgeStore } from '../knowledge/types.js';
import type { SimpleReflector } from './reflector.js';
import type { DatabaseRepository } from '../database/repository.js';
import type { TypedEventBus } from '../events/bus.js';
import { getErrorMessage } from '../util/errors.js';
import { traceToDbRow } from './trace-convert.js';

export class DefaultLearningPipeline implements LearningPipeline {
  private reflector: SimpleReflector;
  private knowledgeStore: KnowledgeStore;
  private db?: DatabaseRepository;
  private eventBus?: TypedEventBus;

  constructor(reflector: SimpleReflector, knowledgeStore: KnowledgeStore, db?: DatabaseRepository, eventBus?: TypedEventBus) {
    this.reflector = reflector;
    this.knowledgeStore = knowledgeStore;
    this.db = db;
    this.eventBus = eventBus;
  }

  async process(
    trace: ExecutionTrace,
    feedback?: FeedbackSignal[],
  ): Promise<LearningResult> {
    const errors: string[] = [];

    // Persist the trace to DB
    if (this.db) {
      try {
        await this.db.saveTrace(traceToDbRow(trace));
        // Emit trace captured event
        if (this.eventBus) {
          this.eventBus.emit('learning.trace_captured', {
            traceId: trace.id,
            runId: trace.runId,
            agentId: trace.agentId,
            stepCount: trace.steps.length,
            outcome: (trace.outcome === 'unknown' ? 'partial' : trace.outcome) as 'success' | 'failure' | 'partial',
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        console.error('[LearningPipeline] Trace save failed for', trace.id, err);
        errors.push(`Trace save failed for ${trace.id}: ${getErrorMessage(err)}`);
      }
    }

    console.log(`[learning] Reflecting on trace ${trace.id.slice(0, 8)} (${trace.steps.length} steps, outcome=${trace.outcome})`);
    const insights = await this.reflector.process(trace, feedback);
    console.log(`[learning] Reflector returned ${insights.length} insights`);

    // Emit insight extracted event
    if (this.eventBus && insights.length > 0) {
      this.eventBus.emit('learning.insight_extracted', {
        traceId: trace.id,
        agentId: trace.agentId,
        insightCount: insights.length,
        timestamp: Date.now(),
      });
    }

    for (const insight of insights) {
      try {
        console.log(`[learning] Storing insight: [${insight.category}] ${insight.content.slice(0, 80)}`);
        const addedItem = await this.knowledgeStore.add({
          agentId: trace.agentId,
          content: insight.content,
          category: insight.category,
          source: 'reflector',
          effectiveness: 0, // neutral until proven
        });

        // Emit knowledge updated event
        if (this.eventBus) {
          this.eventBus.emit('learning.knowledge_updated', {
            agentId: trace.agentId,
            itemId: addedItem.id,
            category: insight.category,
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        const msg = `Knowledge store add failed for insight "${insight.content.substring(0, 50)}": ${getErrorMessage(err)}`;
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
