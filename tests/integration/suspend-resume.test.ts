/**
 * Suspend/Resume Integration Tests (Phase 7, Task 14)
 *
 * Wire real TypedEventBus + real SuspendedRunMatcher + mock DB + mock onResume.
 * Verifies end-to-end suspend/resume flows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SuspendedSessionMatcher } from '../../packages/ctxmill/src/orchestrator/suspended-session-matcher.js';
import {
  createTestBus,
  collectEvents,
  makeFeedbackReceivedEvent,
  makeSuspendedRunRow,
  createMockSuspendDb,
} from '../utils/event-bus-test-helpers.js';
import type { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';

// ── Helpers ────────────────────────────────────────────────────────

// ── Tests ──────────────────────────────────────────────────────────

describe('Suspend/Resume Integration', () => {
  let bus: TypedEventBus;
  let onResume: ReturnType<typeof vi.fn>;
  let matcher: SuspendedSessionMatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = createTestBus();
    onResume = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    matcher?.shutdown();
    vi.useRealTimers();
  });

  it('suspended run in DB + emit matching event → onResume called with correct condition', async () => {
    const row = makeSuspendedRunRow();
    const mockDb = createMockSuspendDb({ 'feedback.received': [row] });
    matcher = new SuspendedSessionMatcher(bus, mockDb as any, onResume);

    const event = makeFeedbackReceivedEvent({ agentId: 'agent-1', type: 'thumbs_up' });
    bus.emit('feedback.received', event);
    await vi.advanceTimersByTimeAsync(50);

     expect(onResume).toHaveBeenCalledTimes(1);
     const [condition, triggerEvent] = onResume.mock.calls[0];
     expect(condition.id).toBe('sr-1');
     expect(condition.sessionId).toBe('run-1');
     expect(condition.agentId).toBe('agent-1');
     expect(condition.eventType).toBe('feedback.received');
     expect(condition.contextSnapshot).toEqual({ conversationId: 'conv-1' });
     expect(triggerEvent).toEqual(event);
  });

  it('selector {agentId: a1, type: thumbs_up} + emit feedback with agentId a2 → NOT resumed', async () => {
    const row = makeSuspendedRunRow({
      waitSelector: JSON.stringify({ agentId: 'a1', type: 'thumbs_up' }),
    });
    const mockDb = createMockSuspendDb({ 'feedback.received': [row] });
    matcher = new SuspendedSessionMatcher(bus, mockDb as any, onResume);

    // Emit with agentId 'a2' — selector requires 'a1'
    const event = makeFeedbackReceivedEvent({ agentId: 'a2', type: 'thumbs_up' });
    bus.emit('feedback.received', event);
    await vi.advanceTimersByTimeAsync(50);

    expect(onResume).not.toHaveBeenCalled();
    expect(mockDb.deleteSuspendedSession).not.toHaveBeenCalled();
  });

  it('suspended run + matching event → run.resumed event emitted on bus', async () => {
    const row = makeSuspendedRunRow();
    const mockDb = createMockSuspendDb({ 'feedback.received': [row] });
    matcher = new SuspendedSessionMatcher(bus, mockDb as any, onResume);

    const collector = collectEvents(bus, 'run.resumed');

    bus.emit('feedback.received', makeFeedbackReceivedEvent({ agentId: 'agent-1', type: 'thumbs_up' }));
    await vi.advanceTimersByTimeAsync(50);

     expect(collector.events.length).toBe(1);
     expect(collector.events[0]).toEqual(
       expect.objectContaining({
         turnId: 'run-1',
         agentId: 'agent-1',
         triggeredBy: 'feedback.received',
       }),
     );
     expect(collector.events[0].suspendedDurationMs).toBeGreaterThanOrEqual(0);
     expect(collector.events[0].timestamp).toBeGreaterThan(0);
    collector.unsubscribe();
  });

  it('2 suspended runs for different event types → emit one → only matching resumed', async () => {
    const feedbackRow = makeSuspendedRunRow({
      id: 'sr-feedback',
      agentSessionId: 'run-fb',
      waitEventType: 'feedback.received',
      waitSelector: JSON.stringify({ agentId: 'agent-1' }),
    });
    const completedRow = makeSuspendedRunRow({
      id: 'sr-completed',
      agentSessionId: 'run-comp',
      waitEventType: 'turn.completed',
      waitSelector: JSON.stringify({ agentId: 'agent-1' }),
    });
    const mockDb = createMockSuspendDb({
      'feedback.received': [feedbackRow],
      'turn.completed': [completedRow],
    });
    matcher = new SuspendedSessionMatcher(bus, mockDb as any, onResume);

    // Only emit feedback.received — only the feedback suspended run should resume
    bus.emit('feedback.received', makeFeedbackReceivedEvent({ agentId: 'agent-1' }));
    await vi.advanceTimersByTimeAsync(50);

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume.mock.calls[0][0].id).toBe('sr-feedback');
    expect(mockDb.deleteSuspendedSession).toHaveBeenCalledWith('sr-feedback');
    expect(mockDb.deleteSuspendedSession).not.toHaveBeenCalledWith('sr-completed');
  });

  it('expired run → advance 30s → reconciliation deletes it', async () => {
    const mockDb = createMockSuspendDb();
    mockDb.expireOldSuspendedSessions.mockResolvedValue(1);
    matcher = new SuspendedSessionMatcher(bus, mockDb as any, onResume);

    // Advance past the 30s reconciliation interval
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockDb.expireOldSuspendedSessions).toHaveBeenCalledTimes(1);
    const callTime = mockDb.expireOldSuspendedSessions.mock.calls[0][0];
    expect(callTime).toBeGreaterThan(0);
  });

  it('full flow: create → wait → emit → resume → cleanup verified', async () => {
    const row = makeSuspendedRunRow({
      id: 'sr-full',
      agentSessionId: 'run-full',
      agentId: 'agent-full',
      waitEventType: 'feedback.received',
      waitSelector: JSON.stringify({ agentId: 'agent-full', type: 'thumbs_up' }),
      snapshotState: JSON.stringify({ conversationId: 'conv-full', lastMessageId: 'msg-42' }),
    });
    const mockDb = createMockSuspendDb({ 'feedback.received': [row] });
    matcher = new SuspendedSessionMatcher(bus, mockDb as any, onResume);

    const resumeCollector = collectEvents(bus, 'run.resumed');

    // Step 1: Emit matching event
    const triggerEvent = makeFeedbackReceivedEvent({ agentId: 'agent-full', type: 'thumbs_up' });
    bus.emit('feedback.received', triggerEvent);
    await vi.advanceTimersByTimeAsync(50);

     // Step 2: Verify onResume was called with full condition
     expect(onResume).toHaveBeenCalledTimes(1);
     const [condition] = onResume.mock.calls[0];
     expect(condition.id).toBe('sr-full');
     expect(condition.sessionId).toBe('run-full');
     expect(condition.contextSnapshot).toEqual({
       conversationId: 'conv-full',
       lastMessageId: 'msg-42',
     });

     // Step 3: Verify run.resumed event was emitted
     expect(resumeCollector.events.length).toBe(1);
     expect(resumeCollector.events[0].turnId).toBe('run-full');
     expect(resumeCollector.events[0].triggeredBy).toBe('feedback.received');

    // Step 4: Verify suspended run was deleted from DB
    expect(mockDb.deleteSuspendedSession).toHaveBeenCalledWith('sr-full');

    // Step 5: Verify cleanup — after shutdown, no more processing
    matcher.shutdown();
    mockDb.getSuspendedSessionsByEventType.mockClear();
    onResume.mockClear();

    bus.emit('feedback.received', makeFeedbackReceivedEvent({ agentId: 'agent-full', type: 'thumbs_up' }));
    await vi.advanceTimersByTimeAsync(50);

    expect(mockDb.getSuspendedSessionsByEventType).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();

    resumeCollector.unsubscribe();
  });
});
