/**
 * HITL Interrupt Lifecycle Integration Tests
 *
 * Wires REAL InterruptManager + REAL TypedEventBus + the canonical wire (ADR-015)
 * with a mock SSEManager to test the full human-in-the-loop interrupt flow.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TypedEventBus } from '../../packages/stablehand/src/events/bus.js';
import { InterruptManager } from '../../packages/stablehand/src/orchestrator/interrupt.js';

import {
  collectEvents,
  createCanonicalWireHarness,
  flushWire,
} from '../../tests/utils/event-bus-test-helpers.js';

describe('HITL Interrupt Lifecycle', () => {
  let bus: TypedEventBus;
  let harness: ReturnType<typeof createCanonicalWireHarness>;
  let interrupts: InterruptManager;

  beforeEach(() => {
    harness = createCanonicalWireHarness();
    bus = harness.bus;

    interrupts = new InterruptManager(bus);
  });

  afterEach(() => {
    interrupts.shutdown();
  });

  // ── Full approval flow ─────────────────────────────────────────

  describe('Full approval flow', () => {
    it('waitForApproval emits interrupt.requested, resolve with approve resolves promise and emits interrupt.resolved', async () => {
      const interruptedEvents = collectEvents(bus, 'interrupt.requested');
      const resolvedEvents = collectEvents(bus, 'interrupt.resolved');

      const promise = interrupts.waitForApproval(
        'run-1', 'agent-1', 'tc-1', 'send_email',
        { to: 'user@example.com', body: 'Hello' },
      );

       // Verify interrupt.requested was emitted (persist hook defers dispatch by a tick)
       await flushWire();
       expect(interruptedEvents.events).toHaveLength(1);
       expect(interruptedEvents.events[0]).toEqual(
         expect.objectContaining({
           turnId: 'run-1',
           agentId: 'agent-1',
           toolCallId: 'tc-1',
           toolName: 'send_email',
           args: { to: 'user@example.com', body: 'Hello' },
           interruptId: expect.any(String),
         }),
       );
       const interruptId = interruptedEvents.events[0].interruptId;
       expect(interruptId).not.toBe('run-1');

      // Verify the canonical wire carried it as CUSTOM{name:'stablehand.interrupt.requested'}
      await flushWire();
      expect(harness.wire).toHaveLength(1);
      expect(harness.wire[0]).toEqual({
        agentId: 'agent-1',
        event: expect.objectContaining({ type: 'CUSTOM', name: 'stablehand.interrupt.requested', toolCallId: 'tc-1' }),
      });

      // Resolve with approve
      const resolved = await interrupts.resolveForTurn('run-1', 'approve', { reason: 'ok' }, 'agent-1');
      expect(resolved).toBe(true);

      // Verify the promise resolves correctly
      const result = await promise;
      expect(result).toEqual({ action: 'approve', data: { reason: 'ok' } });

       // Verify interrupt.resolved event was emitted
       expect(resolvedEvents.events).toHaveLength(1);
       expect(resolvedEvents.events[0]).toEqual(
         expect.objectContaining({
           turnId: 'run-1',
           agentId: 'agent-1',
           interruptId,
           action: 'approve',
         }),
       );

      // The canonical wire should carry the resolution too
      await flushWire();
      expect(harness.wire.some((entry) =>
        entry.event.type === 'CUSTOM'
        && entry.event.name === 'stablehand.interrupt.resolved'
        && entry.event.action === 'approve')).toBe(true);

      interruptedEvents.unsubscribe();
      resolvedEvents.unsubscribe();
    });
  });

  // ── Rejection flow ─────────────────────────────────────────────

  describe('Rejection flow', () => {
    it('resolve with reject resolves promise with reject action', async () => {
      const resolvedEvents = collectEvents(bus, 'interrupt.resolved');

      const promise = interrupts.waitForApproval(
        'run-rej', 'agent-rej', 'tc-rej', 'delete_file',
        { path: '/important.txt' },
      );

      const resolved = await interrupts.resolveForTurn('run-rej', 'reject', { reason: 'too dangerous' }, 'agent-rej');
      expect(resolved).toBe(true);

      const result = await promise;
      expect(result).toEqual({ action: 'reject', data: { reason: 'too dangerous' } });

       expect(resolvedEvents.events).toHaveLength(1);
       expect(resolvedEvents.events[0]).toEqual(
         expect.objectContaining({
           turnId: 'run-rej',
           agentId: 'agent-rej',
           action: 'reject',
         }),
       );

      resolvedEvents.unsubscribe();
    });
  });

  // ── Timeout flow ───────────────────────────────────────────────

  describe('Timeout flow', () => {
    it('waitForApproval with short timeout resolves with suspend action after timer fires', async () => {
      vi.useFakeTimers();

      const resolvedEvents = collectEvents(bus, 'interrupt.resolved');

      const promise = interrupts.waitForApproval(
        'run-to', 'agent-to', 'tc-to', 'risky_op',
        { level: 'high' },
        100,
      );

      // Not yet resolved
      expect(interrupts.hasPendingForTurn('run-to')).toBe(true);

      // Advance past the timeout
      vi.advanceTimersByTime(100);

      const result = await promise;
      expect(result.action).toBe('suspend');

      expect(interrupts.hasPendingForTurn('run-to')).toBe(false);

       expect(resolvedEvents.events).toHaveLength(1);
       expect(resolvedEvents.events[0]).toEqual(
	         expect.objectContaining({
	           turnId: 'run-to',
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
      const interruptedEvents = collectEvents(bus, 'interrupt.requested');
      const resolvedEvents = collectEvents(bus, 'interrupt.resolved');

      const promise1 = interrupts.waitForApproval(
        'run-c1', 'agent-shared', 'tc-c1', 'tool_a', { x: 1 },
      );
      const promise2 = interrupts.waitForApproval(
        'run-c2', 'agent-shared', 'tc-c2', 'tool_b', { y: 2 },
      );

       // Both should have emitted interrupted events (persist hook defers dispatch)
       await flushWire();
       expect(interruptedEvents.events).toHaveLength(2);
       expect(interruptedEvents.events[0].turnId).toBe('run-c1');
       expect(interruptedEvents.events[1].turnId).toBe('run-c2');

       // Resolve run-1 with approve, run-2 with reject
       await interrupts.resolveForTurn('run-c1', 'approve', { ok: true }, 'agent-shared');
       await interrupts.resolveForTurn('run-c2', 'reject', { reason: 'no' }, 'agent-shared');

       const result1 = await promise1;
       const result2 = await promise2;

       expect(result1).toEqual({ action: 'approve', data: { ok: true } });
       expect(result2).toEqual({ action: 'reject', data: { reason: 'no' } });

       // Verify events emitted with correct turnIds
       expect(resolvedEvents.events).toHaveLength(2);
       const r1Event = resolvedEvents.events.find(e => e.turnId === 'run-c1');
       const r2Event = resolvedEvents.events.find(e => e.turnId === 'run-c2');
       expect(r1Event).toEqual(expect.objectContaining({ action: 'approve', turnId: 'run-c1' }));
       expect(r2Event).toEqual(expect.objectContaining({ action: 'reject', turnId: 'run-c2' }));

      interruptedEvents.unsubscribe();
      resolvedEvents.unsubscribe();
    });
  });

  // ── Supersede behavior ─────────────────────────────────────────

  describe('Supersede behavior', () => {
    it('second waitForApproval for same runId supersedes first (first resolves with reject)', async () => {
      const interruptedEvents = collectEvents(bus, 'interrupt.requested');

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
      await flushWire();
      expect(interruptedEvents.events).toHaveLength(2);
      expect(interruptedEvents.events[0].toolCallId).toBe('tc-sup-1');
      expect(interruptedEvents.events[1].toolCallId).toBe('tc-sup-2');

      // Resolve the second interrupt with approve
      await interrupts.resolveForTurn('run-sup', 'approve', { good: true }, 'agent-sup');

      const result2 = await promise2;
      expect(result2).toEqual({ action: 'approve', data: { good: true } });

      interruptedEvents.unsubscribe();
    });
  });

  // ── Resolve non-existent interrupt ─────────────────────────────

  describe('Resolve non-existent interrupt', () => {
    it('resolve() with unknown runId returns false', async () => {
      const result = await interrupts.resolveForTurn('run-nonexistent', 'approve', undefined, 'agent-x');
      expect(result).toBe(false);
    });

    it('resolve() with unknown runId does not emit any events', async () => {
      const resolvedEvents = collectEvents(bus, 'interrupt.resolved');

      await interrupts.resolveForTurn('run-ghost', 'approve', undefined, 'agent-y');

      expect(resolvedEvents.events).toHaveLength(0);

      resolvedEvents.unsubscribe();
    });
  });
});
