import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';
import { LearningEventSubscriber } from '../../packages/ctxmill/src/learning/event-subscriber.js';
import {
  createTestBus,
  createMockLearningPipeline,
  makeRunCompletedEvent,
  makeFeedbackReceivedEvent,
  makeTraceRow,
  makeFeedbackRow,
} from '../utils/event-bus-test-helpers.js';
import type { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';

/** Small settle helper for async event handlers. */
const settle = () => new Promise((r) => setTimeout(r, 10));

function createMockDb() {
  return {
    getRecentTraces: vi.fn().mockResolvedValue([]),
    getFeedbackForTrace: vi.fn().mockResolvedValue([]),
  };
}

describe('LearningEventSubscriber', () => {
  let bus: TypedEventBus;
  let pipeline: ReturnType<typeof createMockLearningPipeline>;
  let db: ReturnType<typeof createMockDb>;
  let subscriber: LearningEventSubscriber;

  beforeEach(() => {
    bus = createTestBus();
    pipeline = createMockLearningPipeline();
    db = createMockDb();
    subscriber = new LearningEventSubscriber(pipeline as any, bus, db as any);
  });

  afterEach(() => {
    subscriber.shutdown();
  });

  describe('turn.completed handling', () => {
    it('status completed fetches trace and calls pipeline.process()', async () => {
      const trace = makeTraceRow();
      db.getRecentTraces.mockResolvedValue([trace]);

      bus.emit('turn.completed', makeRunCompletedEvent({ status: 'completed' }));
      await settle();

      expect(db.getRecentTraces).toHaveBeenCalledWith('agent-test-1', 5);
      expect(pipeline.process).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'trace-1',
          agentId: 'agent-test-1',
          turnId: 'run-test-1',
        }),
      );
    });

    it('matches trace by turnId when sandbox sessionId differs', async () => {
      db.getRecentTraces.mockResolvedValue([
        makeTraceRow({ id: 'older-trace', sessionId: 'sandbox-session-1' }),
        makeTraceRow({ id: 'turn-trace', sessionId: 'run-test-1' }),
      ]);

      bus.emit('turn.completed', makeRunCompletedEvent({
        status: 'completed',
        sessionId: 'sandbox-session-1',
        turnId: 'run-test-1',
      }));
      await settle();

      expect(pipeline.process).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'turn-trace',
          turnId: 'run-test-1',
        }),
      );
    });

    it('status error - pipeline NOT called', async () => {
      bus.emit('turn.completed', makeRunCompletedEvent({ status: 'error' }));
      await settle();

      expect(db.getRecentTraces).not.toHaveBeenCalled();
      expect(pipeline.process).not.toHaveBeenCalled();
    });

    it('status cancelled - pipeline NOT called', async () => {
      bus.emit('turn.completed', makeRunCompletedEvent({ status: 'cancelled' }));
      await settle();

      expect(db.getRecentTraces).not.toHaveBeenCalled();
      expect(pipeline.process).not.toHaveBeenCalled();
    });

    it('no matching trace in DB - pipeline NOT called, no error', async () => {
      allowConsoleErrors();
      db.getRecentTraces.mockResolvedValue([
        makeTraceRow({ sessionId: 'different-run' }),
      ]);

      bus.emit('turn.completed', makeRunCompletedEvent({ status: 'completed' }));
      await settle();

      expect(db.getRecentTraces).toHaveBeenCalled();
      expect(pipeline.process).not.toHaveBeenCalled();
    });

    it('DB error - logged, does not throw', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      db.getRecentTraces.mockRejectedValue(new Error('DB connection lost'));

      bus.emit('turn.completed', makeRunCompletedEvent({ status: 'completed' }));
      await settle();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('CRITICAL: turn.completed handler failed'),
        expect.any(String),
      );
      expect(pipeline.process).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('pipeline error - logged, does not throw', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      db.getRecentTraces.mockResolvedValue([makeTraceRow()]);
      pipeline.process.mockRejectedValue(new Error('Pipeline broke'));

      bus.emit('turn.completed', makeRunCompletedEvent({ status: 'completed' }));
      await settle();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('CRITICAL: turn.completed handler failed'),
        expect.any(String),
      );
      consoleSpy.mockRestore();
    });
  });

  describe('feedback.received handling', () => {
    it('feedback fetches trace + existing feedback and calls pipeline.process()', async () => {
      const trace = makeTraceRow();
      const feedbackRow = makeFeedbackRow();
      db.getRecentTraces.mockResolvedValue([trace]);
      db.getFeedbackForTrace.mockResolvedValue([feedbackRow]);

      bus.emit('feedback.received', makeFeedbackReceivedEvent());
      await settle();

      expect(db.getRecentTraces).toHaveBeenCalledWith('agent-test-1', 5);
      expect(db.getFeedbackForTrace).toHaveBeenCalledWith('trace-1');
      expect(pipeline.process).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'trace-1' }),
        expect.arrayContaining([
          expect.objectContaining({
            source: 'human',
            type: 'thumbs',
            value: 'positive',
          }),
        ]),
      );
    });

    it('feedback signal transformation: DB row normalized to { source, type, value }', async () => {
      const trace = makeTraceRow();
      const rows = [
        makeFeedbackRow({ source: 'environment', type: 'rating', value: 5 }),
        makeFeedbackRow({ id: 'fb-2', source: 'automated', type: 'correction', value: 'fixed' }),
      ];
      db.getRecentTraces.mockResolvedValue([trace]);
      db.getFeedbackForTrace.mockResolvedValue(rows);

      bus.emit('feedback.received', makeFeedbackReceivedEvent());
      await settle();

      expect(pipeline.process).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'trace-1' }),
        expect.arrayContaining([
          expect.objectContaining({ source: 'environment', type: 'rating', value: 5 }),
          expect.objectContaining({ source: 'automated', type: 'correction', value: 'fixed' }),
        ]),
      );
      const callArgs = pipeline.process.mock.lastCall!;
      const signals = callArgs[1] as Array<{ source: string; type: string; value: unknown }>;
      expect(signals).toHaveLength(2);
      expect(signals[0]).toEqual(
        expect.objectContaining({ source: 'environment', type: 'rating', value: 5 }),
      );
      expect(signals[1]).toEqual(
        expect.objectContaining({ source: 'automated', type: 'correction', value: 'fixed' }),
      );
    });

    it('no matching trace - pipeline NOT called', async () => {
      allowConsoleErrors();
      db.getRecentTraces.mockResolvedValue([
        makeTraceRow({ sessionId: 'other-run' }),
      ]);

      bus.emit('feedback.received', makeFeedbackReceivedEvent());
      await settle();

      expect(pipeline.process).not.toHaveBeenCalled();
    });

    it('pipeline called with feedback signals array', async () => {
      const trace = makeTraceRow();
      db.getRecentTraces.mockResolvedValue([trace]);
      db.getFeedbackForTrace.mockResolvedValue([makeFeedbackRow()]);

      bus.emit('feedback.received', makeFeedbackReceivedEvent());
      await settle();

      // Second argument is an array of signals
      expect(pipeline.process).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'trace-1' }),
        expect.any(Array),
      );
      const callArgs = pipeline.process.mock.lastCall!;
      expect(Array.isArray(callArgs[1])).toBe(true);
      expect((callArgs[1] as unknown[]).length).toBeGreaterThan(0);
    });
  });

  describe('lifecycle', () => {
    it('shutdown removes listeners', async () => {
      db.getRecentTraces.mockResolvedValue([makeTraceRow()]);
      subscriber.shutdown();

      bus.emit('turn.completed', makeRunCompletedEvent({ status: 'completed' }));
      bus.emit('feedback.received', makeFeedbackReceivedEvent());
      await settle();

      expect(db.getRecentTraces).not.toHaveBeenCalled();
      expect(pipeline.process).not.toHaveBeenCalled();
    });

    it('events after shutdown produce no pipeline calls', async () => {
      subscriber.shutdown();

      // Emit multiple events
      for (let i = 0; i < 5; i++) {
          bus.emit('turn.completed', makeRunCompletedEvent({ status: 'completed' }));
      }
      await settle();

      expect(pipeline.process).not.toHaveBeenCalled();
    });
  });

  describe('without database', () => {
    it('constructed with undefined db - no pipeline calls on events', async () => {
      allowConsoleErrors();
      const noDB = new LearningEventSubscriber(pipeline as any, bus, undefined);

      bus.emit('turn.completed', makeRunCompletedEvent({ status: 'completed' }));
      bus.emit('feedback.received', makeFeedbackReceivedEvent());
      await settle();

      expect(pipeline.process).not.toHaveBeenCalled();
      noDB.shutdown();
    });
  });
});
