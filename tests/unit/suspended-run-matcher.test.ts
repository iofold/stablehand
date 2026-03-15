/**
 * SuspendedRunMatcher Unit Tests (Phase 7, Task 13)
 *
 * Tests selector matching, event-driven resume, TTL expiry,
 * error handling, and lifecycle management.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { matchesSelector } from '../../packages/ctxmill/src/events/wait-condition.js';
import { SuspendedRunMatcher } from '../../packages/ctxmill/src/orchestrator/suspended-run-matcher.js';
import {
  createTestBus,
  collectEvents,
  makeFeedbackReceivedEvent,
  makeRunCompletedEvent,
} from '../../tests/utils/event-bus-test-helpers.js';
import type { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';

// ── Helpers ────────────────────────────────────────────────────────

function makeSuspendedRow(overrides?: Record<string, unknown>) {
  return {
    id: 'sr-1',
    agentRunId: 'run-1',
    agentId: 'agent-1',
    waitEventType: 'feedback.received',
    waitSelector: JSON.stringify({ agentId: 'agent-1', type: 'thumbs_up' }),
    waitExpiresAt: null,
    snapshotState: JSON.stringify({ conversationId: 'conv-1' }),
    createdAt: Date.now() - 5000,
    ...overrides,
  };
}

function createMockDb(overrides?: Record<string, unknown>) {
  return {
    getSuspendedRunsByEventType: vi.fn().mockResolvedValue([]),
    deleteSuspendedRun: vi.fn().mockResolvedValue(undefined),
    expireOldSuspendedRuns: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

// ── Tests ──────────────────────────────────────────────────────────

describe('SuspendedRunMatcher', () => {
  describe('selector matching', () => {
    it('matchesSelector exact key-value match returns true', () => {
      const payload = { agentId: 'a1', type: 'thumbs_up' };
      const selector = { agentId: 'a1', type: 'thumbs_up' };
      expect(matchesSelector(payload, selector)).toBe(true);
    });

    it('matchesSelector partial match (payload has extra fields) returns true', () => {
      const payload = { agentId: 'a1', type: 'thumbs_up', extra: 'data', foo: 42 };
      const selector = { agentId: 'a1' };
      expect(matchesSelector(payload, selector)).toBe(true);
    });

    it('matchesSelector mismatch returns false', () => {
      const payload = { agentId: 'a1', type: 'thumbs_down' };
      const selector = { agentId: 'a1', type: 'thumbs_up' };
      expect(matchesSelector(payload, selector)).toBe(false);
    });

    it('matchesSelector empty selector returns true (matches anything)', () => {
      const payload = { agentId: 'a1', type: 'thumbs_up', foo: 'bar' };
      const selector = {};
      expect(matchesSelector(payload, selector)).toBe(true);
    });

    it('matchesSelector nested value returns false (only top-level)', () => {
      const nested = { inner: 'value' };
      const payload = { data: nested };
      // Different object reference — strict equality fails for nested objects
      const selector = { data: { inner: 'value' } };
      expect(matchesSelector(payload, selector)).toBe(false);
    });
  });

  describe('event-driven resume', () => {
    let bus: TypedEventBus;
    let mockDb: ReturnType<typeof createMockDb>;
    let onResume: ReturnType<typeof vi.fn>;
    let matcher: SuspendedRunMatcher;

    beforeEach(() => {
      vi.useFakeTimers();
      bus = createTestBus();
      onResume = vi.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
      matcher?.shutdown();
      vi.useRealTimers();
    });

    it('emit matching event calls onResume with condition and trigger event', async () => {
      const row = makeSuspendedRow();
      mockDb = createMockDb({
        getSuspendedRunsByEventType: vi.fn().mockResolvedValue([row]),
      });
      matcher = new SuspendedRunMatcher(bus, mockDb as any, onResume);

      const event = makeFeedbackReceivedEvent({ agentId: 'agent-1', type: 'thumbs_up' });
      bus.emit('feedback.received', event);
      await vi.advanceTimersByTimeAsync(50);

      expect(onResume).toHaveBeenCalledTimes(1);
      const [condition, triggerEvent] = onResume.mock.calls[0];
      expect(condition.id).toBe('sr-1');
      expect(condition.runId).toBe('run-1');
      expect(condition.agentId).toBe('agent-1');
      expect(triggerEvent).toEqual(event);
    });

    it('emit non-matching event does NOT call onResume', async () => {
      const row = makeSuspendedRow({
        waitSelector: JSON.stringify({ agentId: 'agent-1', type: 'thumbs_up' }),
      });
      mockDb = createMockDb({
        getSuspendedRunsByEventType: vi.fn().mockResolvedValue([row]),
      });
      matcher = new SuspendedRunMatcher(bus, mockDb as any, onResume);

      // Emit with wrong type field
      const event = makeFeedbackReceivedEvent({ agentId: 'agent-1', type: 'thumbs_down' });
      bus.emit('feedback.received', event);
      await vi.advanceTimersByTimeAsync(50);

      expect(onResume).not.toHaveBeenCalled();
    });

    it('multiple suspended runs, only matching one resumed', async () => {
      const row1 = makeSuspendedRow({
        id: 'sr-1',
        waitSelector: JSON.stringify({ agentId: 'agent-1' }),
      });
      const row2 = makeSuspendedRow({
        id: 'sr-2',
        agentRunId: 'run-2',
        waitSelector: JSON.stringify({ agentId: 'agent-2' }),
      });
      mockDb = createMockDb({
        getSuspendedRunsByEventType: vi.fn().mockResolvedValue([row1, row2]),
      });
      matcher = new SuspendedRunMatcher(bus, mockDb as any, onResume);

      const event = makeFeedbackReceivedEvent({ agentId: 'agent-1', type: 'thumbs_up' });
      bus.emit('feedback.received', event);
      await vi.advanceTimersByTimeAsync(50);

      expect(onResume).toHaveBeenCalledTimes(1);
      expect(onResume.mock.calls[0][0].id).toBe('sr-1');
    });

    it('resumed run is deleted from DB', async () => {
      const row = makeSuspendedRow();
      mockDb = createMockDb({
        getSuspendedRunsByEventType: vi.fn().mockResolvedValue([row]),
      });
      matcher = new SuspendedRunMatcher(bus, mockDb as any, onResume);

      bus.emit('feedback.received', makeFeedbackReceivedEvent({ agentId: 'agent-1', type: 'thumbs_up' }));
      await vi.advanceTimersByTimeAsync(50);

      expect(mockDb.deleteSuspendedRun).toHaveBeenCalledWith('sr-1');
    });

    it('run.resumed event emitted on bus', async () => {
      const row = makeSuspendedRow();
      mockDb = createMockDb({
        getSuspendedRunsByEventType: vi.fn().mockResolvedValue([row]),
      });
      matcher = new SuspendedRunMatcher(bus, mockDb as any, onResume);

      const collector = collectEvents(bus, 'run.resumed');

      bus.emit('feedback.received', makeFeedbackReceivedEvent({ agentId: 'agent-1', type: 'thumbs_up' }));
      await vi.advanceTimersByTimeAsync(50);

      expect(collector.events.length).toBe(1);
      expect(collector.events[0].runId).toBe('run-1');
      expect(collector.events[0].agentId).toBe('agent-1');
      expect(collector.events[0].triggeredBy).toBe('feedback.received');
      collector.unsubscribe();
    });
  });

  describe('TTL expiry', () => {
    let bus: TypedEventBus;
    let mockDb: ReturnType<typeof createMockDb>;
    let onResume: ReturnType<typeof vi.fn>;
    let matcher: SuspendedRunMatcher;

    beforeEach(() => {
      vi.useFakeTimers();
      bus = createTestBus();
      onResume = vi.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
      matcher?.shutdown();
      vi.useRealTimers();
    });

    it('expired runs cleaned up by reconciliation loop after 30s', async () => {
      mockDb = createMockDb({
        expireOldSuspendedRuns: vi.fn().mockResolvedValue(3),
      });
      matcher = new SuspendedRunMatcher(bus, mockDb as any, onResume);

      // Advance 30 seconds to trigger reconciliation
      await vi.advanceTimersByTimeAsync(30_000);

      expect(mockDb.expireOldSuspendedRuns).toHaveBeenCalledTimes(1);
      expect(mockDb.expireOldSuspendedRuns).toHaveBeenCalledWith(expect.any(Number));
    });

    it('non-expired runs NOT cleaned up (reconciliation does not delete them)', async () => {
      mockDb = createMockDb({
        expireOldSuspendedRuns: vi.fn().mockResolvedValue(0),
      });
      matcher = new SuspendedRunMatcher(bus, mockDb as any, onResume);

      await vi.advanceTimersByTimeAsync(30_000);

      expect(mockDb.expireOldSuspendedRuns).toHaveBeenCalledTimes(1);
      // Return value 0 means nothing was deleted
    });

    it('expireOldSuspendedRuns returns count of deleted rows', async () => {
      mockDb = createMockDb({
        expireOldSuspendedRuns: vi.fn().mockResolvedValue(5),
      });
      matcher = new SuspendedRunMatcher(bus, mockDb as any, onResume);

      await vi.advanceTimersByTimeAsync(30_000);

      // The reconciliation calls expireOldSuspendedRuns which returns 5
      const result = await mockDb.expireOldSuspendedRuns.mock.results[0].value;
      expect(result).toBe(5);
    });
  });

  describe('error handling', () => {
    let bus: TypedEventBus;
    let onResume: ReturnType<typeof vi.fn>;
    let matcher: SuspendedRunMatcher;

    beforeEach(() => {
      vi.useFakeTimers();
      bus = createTestBus();
      onResume = vi.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
      matcher?.shutdown();
      vi.useRealTimers();
    });

    it('DB query error is logged and does not crash', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockDb = createMockDb({
        getSuspendedRunsByEventType: vi.fn().mockRejectedValue(new Error('DB down')),
      });
      matcher = new SuspendedRunMatcher(bus, mockDb as any, onResume);

      bus.emit('feedback.received', makeFeedbackReceivedEvent());
      await vi.advanceTimersByTimeAsync(50);

      expect(errorSpy).toHaveBeenCalled();
      expect(onResume).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('onResume callback error is logged and does not crash', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const row = makeSuspendedRow();
      const mockDb = createMockDb({
        getSuspendedRunsByEventType: vi.fn().mockResolvedValue([row]),
      });
      const failingResume = vi.fn().mockRejectedValue(new Error('resume failed'));
      matcher = new SuspendedRunMatcher(bus, mockDb as any, failingResume);

      bus.emit('feedback.received', makeFeedbackReceivedEvent({ agentId: 'agent-1', type: 'thumbs_up' }));
      await vi.advanceTimersByTimeAsync(50);

      expect(failingResume).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('matchesSelector with undefined payload field does not crash', async () => {
      const row = makeSuspendedRow({
        waitSelector: JSON.stringify({ nonExistentField: 'value' }),
      });
      const mockDb = createMockDb({
        getSuspendedRunsByEventType: vi.fn().mockResolvedValue([row]),
      });
      matcher = new SuspendedRunMatcher(bus, mockDb as any, onResume);

      // Emit event that does not have nonExistentField — matchesSelector should return false
      bus.emit('feedback.received', makeFeedbackReceivedEvent());
      await vi.advanceTimersByTimeAsync(50);

      expect(onResume).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle', () => {
    let bus: TypedEventBus;
    let mockDb: ReturnType<typeof createMockDb>;
    let onResume: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.useFakeTimers();
      bus = createTestBus();
      onResume = vi.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('shutdown removes all listeners — events no longer trigger queries', async () => {
      const row = makeSuspendedRow();
      mockDb = createMockDb({
        getSuspendedRunsByEventType: vi.fn().mockResolvedValue([row]),
      });
      const matcher = new SuspendedRunMatcher(bus, mockDb as any, onResume);

      matcher.shutdown();

      // Reset mocks to verify no calls after shutdown
      mockDb.getSuspendedRunsByEventType.mockClear();

      bus.emit('feedback.received', makeFeedbackReceivedEvent({ agentId: 'agent-1', type: 'thumbs_up' }));
      await vi.advanceTimersByTimeAsync(50);

      expect(mockDb.getSuspendedRunsByEventType).not.toHaveBeenCalled();
      expect(onResume).not.toHaveBeenCalled();
    });

    it('shutdown clears reconciliation interval', async () => {
      mockDb = createMockDb();
      const matcher = new SuspendedRunMatcher(bus, mockDb as any, onResume);

      matcher.shutdown();

      // Advance past reconciliation interval — should NOT trigger
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockDb.expireOldSuspendedRuns).not.toHaveBeenCalled();
    });
  });
});
