/**
 * HITL Interrupt Lifecycle Integration Tests
 *
 * Wires REAL InterruptManager + REAL TypedEventBus + REAL SSEBroadcaster
 * with a mock SSEManager to test the full human-in-the-loop interrupt flow.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import { InterruptManager } from '../../packages/ctxmill/src/orchestrator/interrupt.js';
import { SSEBroadcaster } from '../../packages/ctxmill/src/orchestrator/sse-broadcaster.js';
import {
  createTestBus,
  collectEvents,
  createMockSSEManager,
} from '../../tests/utils/event-bus-test-helpers.js';

describe('HITL Interrupt Lifecycle', () => {
  let bus: TypedEventBus;
  let mockSSE: ReturnType<typeof createMockSSEManager>;
  let broadcaster: SSEBroadcaster;
  let interrupts: InterruptManager;

  beforeEach(() => {
    bus = createTestBus();
    mockSSE = createMockSSEManager();
    broadcaster = new SSEBroadcaster(mockSSE as any, bus);
    interrupts = new InterruptManager(bus);
  });

  afterEach(() => {
    interrupts.shutdown();
    broadcaster.shutdown();
  });

  // ── Full approval flow ─────────────────────────────────────────

  describe('Full approval flow', () => {
    it('waitForApproval emits run.interrupted, resolve with approve resolves promise and emits run.interrupt_resolved', async () => {
      const interruptedEvents = collectEvents(bus, 'run.interrupted');
      const resolvedEvents = collectEvents(bus, 'run.interrupt_resolved');

      const promise = interrupts.waitForApproval(
        'run-1', 'agent-1', 'tc-1', 'send_email',
        { to: 'user@example.com', body: 'Hello' },
      );

      // Verify run.interrupted was emitted
      expect(interruptedEvents.events).toHaveLength(1);
      expect(interruptedEvents.events[0]).toEqual(
        expect.objectContaining({
          runId: 'run-1',
          agentId: 'agent-1',
          toolCallId: 'tc-1',
          toolName: 'send_email',
          args: { to: 'user@example.com', body: 'Hello' },
          interruptId: 'run-1',
        }),
      );

      // Verify SSEBroadcaster forwarded it as CUSTOM
      expect(mockSSE.broadcast).toHaveBeenCalledTimes(1);
      expect(mockSSE.broadcast).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ type: 'CUSTOM', internalType: 'run.interrupted' }),
      );

      // Resolve with approve
      const resolved = interrupts.resolve('run-1', 'approve', { reason: 'ok' }, 'agent-1');
      expect(resolved).toBe(true);

      // Verify the promise resolves correctly
      const result = await promise;
      expect(result).toEqual({ action: 'approve', data: { reason: 'ok' } });

      // Verify run.interrupt_resolved event was emitted
      expect(resolvedEvents.events).toHaveLength(1);
      expect(resolvedEvents.events[0]).toEqual(
        expect.objectContaining({
          runId: 'run-1',
          agentId: 'agent-1',
          interruptId: 'run-1',
          action: 'approve',
        }),
      );

      // SSEBroadcaster should have broadcast the resolved event too
      expect(mockSSE.broadcast).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ type: 'CUSTOM', internalType: 'run.interrupt_resolved' }),
      );

      interruptedEvents.unsubscribe();
      resolvedEvents.unsubscribe();
    });
  });

  // ── Rejection flow ─────────────────────────────────────────────

  describe('Rejection flow', () => {
    it('resolve with reject resolves promise with reject action', async () => {
      const resolvedEvents = collectEvents(bus, 'run.interrupt_resolved');

      const promise = interrupts.waitForApproval(
        'run-rej', 'agent-rej', 'tc-rej', 'delete_file',
        { path: '/important.txt' },
      );

      const resolved = interrupts.resolve('run-rej', 'reject', { reason: 'too dangerous' }, 'agent-rej');
      expect(resolved).toBe(true);

      const result = await promise;
      expect(result).toEqual({ action: 'reject', data: { reason: 'too dangerous' } });

      expect(resolvedEvents.events).toHaveLength(1);
      expect(resolvedEvents.events[0]).toEqual(
        expect.objectContaining({
          runId: 'run-rej',
          agentId: 'agent-rej',
          action: 'reject',
        }),
      );

      resolvedEvents.unsubscribe();
    });
  });

  // ── Timeout flow ───────────────────────────────────────────────

  describe('Timeout flow', () => {
    it('waitForApproval with short timeout resolves with timeout action after timer fires', async () => {
      vi.useFakeTimers();

      const resolvedEvents = collectEvents(bus, 'run.interrupt_resolved');

      const promise = interrupts.waitForApproval(
        'run-to', 'agent-to', 'tc-to', 'risky_op',
        { level: 'high' },
        100,
      );

      // Not yet resolved
      expect(interrupts.hasPending('run-to')).toBe(true);

      // Advance past the timeout
      vi.advanceTimersByTime(100);

      const result = await promise;
      expect(result.action).toBe('timeout');

      // Pending should be cleared
      expect(interrupts.hasPending('run-to')).toBe(false);

      // run.interrupt_resolved event should have been emitted with timeout
      expect(resolvedEvents.events).toHaveLength(1);
      expect(resolvedEvents.events[0]).toEqual(
        expect.objectContaining({
          runId: 'run-to',
          agentId: 'agent-to',
          action: 'timeout',
        }),
      );

      resolvedEvents.unsubscribe();
      vi.useRealTimers();
    });
  });

  // ── Concurrent runs isolation ──────────────────────────────────

  describe('Concurrent runs isolation', () => {
    it('two different runIds get independent resolutions and events', async () => {
      const interruptedEvents = collectEvents(bus, 'run.interrupted');
      const resolvedEvents = collectEvents(bus, 'run.interrupt_resolved');

      const promise1 = interrupts.waitForApproval(
        'run-c1', 'agent-shared', 'tc-c1', 'tool_a', { x: 1 },
      );
      const promise2 = interrupts.waitForApproval(
        'run-c2', 'agent-shared', 'tc-c2', 'tool_b', { y: 2 },
      );

      // Both should have emitted interrupted events
      expect(interruptedEvents.events).toHaveLength(2);
      expect(interruptedEvents.events[0].runId).toBe('run-c1');
      expect(interruptedEvents.events[1].runId).toBe('run-c2');

      // Resolve run-1 with approve, run-2 with reject
      interrupts.resolve('run-c1', 'approve', { ok: true }, 'agent-shared');
      interrupts.resolve('run-c2', 'reject', { reason: 'no' }, 'agent-shared');

      const result1 = await promise1;
      const result2 = await promise2;

      expect(result1).toEqual({ action: 'approve', data: { ok: true } });
      expect(result2).toEqual({ action: 'reject', data: { reason: 'no' } });

      // Verify events emitted with correct runIds
      expect(resolvedEvents.events).toHaveLength(2);
      const r1Event = resolvedEvents.events.find(e => e.runId === 'run-c1');
      const r2Event = resolvedEvents.events.find(e => e.runId === 'run-c2');
      expect(r1Event).toEqual(expect.objectContaining({ action: 'approve', runId: 'run-c1' }));
      expect(r2Event).toEqual(expect.objectContaining({ action: 'reject', runId: 'run-c2' }));

      interruptedEvents.unsubscribe();
      resolvedEvents.unsubscribe();
    });
  });

  // ── Supersede behavior ─────────────────────────────────────────

  describe('Supersede behavior', () => {
    it('second waitForApproval for same runId supersedes first (first resolves with reject)', async () => {
      const interruptedEvents = collectEvents(bus, 'run.interrupted');

      const promise1 = interrupts.waitForApproval(
        'run-sup', 'agent-sup', 'tc-sup-1', 'tool_old', { v: 1 },
      );
      const promise2 = interrupts.waitForApproval(
        'run-sup', 'agent-sup', 'tc-sup-2', 'tool_new', { v: 2 },
      );

      // First promise should have been superseded (resolved with reject)
      const result1 = await promise1;
      expect(result1).toEqual({ action: 'reject', data: 'Superseded by new interrupt' });

      // Two interrupted events should have been emitted (one per waitForApproval call)
      expect(interruptedEvents.events).toHaveLength(2);
      expect(interruptedEvents.events[0].toolCallId).toBe('tc-sup-1');
      expect(interruptedEvents.events[1].toolCallId).toBe('tc-sup-2');

      // Resolve the second interrupt with approve
      interrupts.resolve('run-sup', 'approve', { good: true }, 'agent-sup');

      const result2 = await promise2;
      expect(result2).toEqual({ action: 'approve', data: { good: true } });

      interruptedEvents.unsubscribe();
    });
  });

  // ── Resolve non-existent interrupt ─────────────────────────────

  describe('Resolve non-existent interrupt', () => {
    it('resolve() with unknown runId returns false', () => {
      const result = interrupts.resolve('run-nonexistent', 'approve', undefined, 'agent-x');
      expect(result).toBe(false);
    });

    it('resolve() with unknown runId does not emit any events', () => {
      const resolvedEvents = collectEvents(bus, 'run.interrupt_resolved');

      interrupts.resolve('run-ghost', 'approve', undefined, 'agent-y');

      expect(resolvedEvents.events).toHaveLength(0);

      resolvedEvents.unsubscribe();
    });
  });
});
