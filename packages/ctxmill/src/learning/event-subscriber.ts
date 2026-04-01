import type { LearningPipeline } from './types.js';
import type { DatabaseRepository } from '../database/repository.js';
import type { TypedEventBus, EventMap } from '../events/bus.js';
import { dbRowToTrace } from './trace-convert.js';

type RunCompletedHandler = (payload: EventMap['turn.completed']) => void | Promise<void>;
type FeedbackHandler = (payload: EventMap['feedback.received']) => void | Promise<void>;

/**
 * Subscribes to event bus events and triggers the learning pipeline.
 *  - run.completed (status === 'completed') -> triggers learning pipeline
 *  - feedback.received -> triggers learning with feedback signal
 */
export class LearningEventSubscriber {
  private pipeline: LearningPipeline;
  private db?: DatabaseRepository;
  private eventBus: TypedEventBus;
  private onRunCompleted: RunCompletedHandler;
  private onFeedbackReceived: FeedbackHandler;

  constructor(
    pipeline: LearningPipeline,
    eventBus: TypedEventBus,
    db?: DatabaseRepository,
  ) {
    this.pipeline = pipeline;
    this.db = db;
    this.eventBus = eventBus;

    this.onRunCompleted = async (payload) => {
      if (payload.status !== 'completed') return;
      try {
        // Look up the trace for this session
        if (!this.db) return;
        const traces = await this.db.getRecentTraces(payload.agentId, 1);
        const trace = traces.find((t) => t.sessionId === payload.sessionId);
        if (!trace) {
          console.warn(
            `[LearningEventSubscriber] No trace found for completed session ${payload.sessionId} (agent=${payload.agentId}). ` +
             'This may indicate a code bug — the trace should have been persisted before turn.completed fires.',
          );
          return;
        }

        await this.pipeline.process(dbRowToTrace(trace));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        console.error(
          `[LearningEventSubscriber] CRITICAL: turn.completed handler failed for session ${payload.sessionId}: ${message}`,
          stack ? `\n${stack}` : '',
        );
      }
    };

    this.onFeedbackReceived = async (payload) => {
      const turnId = (payload as unknown as { turnId: string }).turnId;
      try {
        if (!this.db) return;
        const traces = await this.db.getRecentTraces(payload.agentId, 5);
        const trace = traces.find((t) => t.sessionId === turnId);
        if (!trace) {
          console.warn(
            `[LearningEventSubscriber] No trace found for feedback on turn ${turnId} (agent=${payload.agentId}). ` +
            'This may indicate a code bug — the trace should exist before feedback is recorded.',
          );
          return;
        }

        const feedbackRows = await this.db.getFeedbackForTrace(trace.id);
        const feedbackSignals = feedbackRows.map((f) => ({
          id: f.id,
          traceId: f.traceId,
          agentId: f.agentId,
          source: f.source as 'human' | 'environment' | 'automated',
          type: f.type as 'thumbs' | 'rating' | 'correction' | 'comparison',
          value: f.value,
          createdAt: new Date(f.createdAt),
        }));

        await this.pipeline.process(dbRowToTrace(trace), feedbackSignals);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        console.error(
          `[LearningEventSubscriber] CRITICAL: feedback.received handler failed for turn ${turnId}: ${message}`,
          stack ? `\n${stack}` : '',
        );
      }
    };

    this.eventBus.on('turn.completed', this.onRunCompleted);
    this.eventBus.on('feedback.received', this.onFeedbackReceived);
  }

  shutdown(): void {
    this.eventBus.off('turn.completed', this.onRunCompleted);
    this.eventBus.off('feedback.received', this.onFeedbackReceived);
  }
}
