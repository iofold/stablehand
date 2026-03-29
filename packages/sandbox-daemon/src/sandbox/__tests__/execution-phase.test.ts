import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ExecutionPhaseTracker,
  SAFE_SUSPEND_PHASES,
  type ExecutionPhase,
} from '../execution-phase.js';

describe('ExecutionPhaseTracker', () => {
  let tracker: ExecutionPhaseTracker;

  beforeEach(() => {
    tracker = new ExecutionPhaseTracker();
  });

  // ── Phase transitions ──────────────────────────────────────

  describe('phase transitions', () => {
    it('starts in idle phase', () => {
      expect(tracker.getPhase()).toBe('idle');
    });

    it('transitions between phases correctly', () => {
      const phases: ExecutionPhase[] = [
        'before_llm',
        'llm_call_in_flight',
        'after_llm',
        'before_tool',
        'tool_execution',
        'after_tool',
        'hitl_wait',
        'idle',
      ];

      for (const phase of phases) {
        tracker.setPhase(phase);
        expect(tracker.getPhase()).toBe(phase);
      }
    });

    it('can transition to the same phase', () => {
      tracker.setPhase('before_llm');
      tracker.setPhase('before_llm');
      expect(tracker.getPhase()).toBe('before_llm');
    });
  });

  // ── isSuspendSafe ──────────────────────────────────────────

  describe('isSuspendSafe', () => {
    it('returns true for all safe phases', () => {
      const safePhases: ExecutionPhase[] = [
        'idle',
        'before_llm',
        'after_llm',
        'after_tool',
        'hitl_wait',
      ];

      for (const phase of safePhases) {
        tracker.setPhase(phase);
        expect(tracker.isSuspendSafe()).toBe(true);
      }
    });

    it('returns false for all unsafe phases', () => {
      const unsafePhases: ExecutionPhase[] = [
        'llm_call_in_flight',
        'before_tool',
        'tool_execution',
      ];

      for (const phase of unsafePhases) {
        tracker.setPhase(phase);
        expect(tracker.isSuspendSafe()).toBe(false);
      }
    });

    it('SAFE_SUSPEND_PHASES set matches isSuspendSafe results', () => {
      const allPhases: ExecutionPhase[] = [
        'idle',
        'before_llm',
        'llm_call_in_flight',
        'after_llm',
        'before_tool',
        'tool_execution',
        'after_tool',
        'hitl_wait',
      ];

      for (const phase of allPhases) {
        tracker.setPhase(phase);
        expect(tracker.isSuspendSafe()).toBe(SAFE_SUSPEND_PHASES.has(phase));
      }
    });
  });

  // ── requestSuspend at safe point ──────────────────────────

  describe('requestSuspend at safe point', () => {
    it('resolves immediately when at idle phase', async () => {
      const promise = tracker.requestSuspend();
      // Should resolve without needing any phase transitions
      await expect(promise).resolves.toBeUndefined();
    });

    it('resolves immediately when at before_llm phase', async () => {
      tracker.setPhase('before_llm');
      await expect(tracker.requestSuspend()).resolves.toBeUndefined();
    });

    it('resolves immediately when at after_llm phase', async () => {
      tracker.setPhase('after_llm');
      await expect(tracker.requestSuspend()).resolves.toBeUndefined();
    });

    it('resolves immediately when at after_tool phase', async () => {
      tracker.setPhase('after_tool');
      await expect(tracker.requestSuspend()).resolves.toBeUndefined();
    });

    it('resolves immediately when at hitl_wait phase', async () => {
      tracker.setPhase('hitl_wait');
      await expect(tracker.requestSuspend()).resolves.toBeUndefined();
    });

    it('sets suspendRequested flag after resolving', async () => {
      await tracker.requestSuspend();
      expect(tracker.isSuspendRequested()).toBe(true);
    });
  });

  // ── requestSuspend at unsafe point ────────────────────────

  describe('requestSuspend at unsafe point', () => {
    it('queues and resolves when safe point is reached via setPhase', async () => {
      tracker.setPhase('llm_call_in_flight');

      let resolved = false;
      const promise = tracker.requestSuspend().then(() => {
        resolved = true;
      });

      // Should not be resolved yet — we're at an unsafe point
      await Promise.resolve(); // flush microtasks
      expect(resolved).toBe(false);

      // Transition to a safe phase
      tracker.setPhase('after_llm');

      // Now it should resolve
      await promise;
      expect(resolved).toBe(true);
    });

    it('queues and resolves when tool_execution transitions to after_tool', async () => {
      tracker.setPhase('tool_execution');

      let resolved = false;
      const promise = tracker.requestSuspend().then(() => {
        resolved = true;
      });

      await Promise.resolve();
      expect(resolved).toBe(false);

      tracker.setPhase('after_tool');
      await promise;
      expect(resolved).toBe(true);
    });

    it('queues and resolves when before_tool transitions to after_tool via tool_execution', async () => {
      tracker.setPhase('before_tool');

      let resolved = false;
      const promise = tracker.requestSuspend().then(() => {
        resolved = true;
      });

      await Promise.resolve();
      expect(resolved).toBe(false);

      // Still unsafe
      tracker.setPhase('tool_execution');
      await Promise.resolve();
      expect(resolved).toBe(false);

      // Now safe
      tracker.setPhase('after_tool');
      await promise;
      expect(resolved).toBe(true);
    });
  });

  // ── checkSuspendAtSafePoint ───────────────────────────────

  describe('checkSuspendAtSafePoint', () => {
    it('returns false when no suspend requested', () => {
      tracker.setPhase('before_llm');
      expect(tracker.checkSuspendAtSafePoint()).toBe(false);
    });

    it('returns true when suspend requested and at safe phase', async () => {
      tracker.setPhase('before_llm');
      await tracker.requestSuspend();
      expect(tracker.checkSuspendAtSafePoint()).toBe(true);
    });

    it('returns false when suspend requested but at unsafe phase', () => {
      tracker.setPhase('tool_execution');

      // Request suspend (will queue) — don't await since it won't resolve
      tracker.requestSuspend();

      // Manually set to unsafe phase (stays in tool_execution)
      expect(tracker.checkSuspendAtSafePoint()).toBe(false);
    });
  });

  // ── cancelSuspend ─────────────────────────────────────────

  describe('cancelSuspend', () => {
    it('clears a pending suspend request', () => {
      tracker.setPhase('tool_execution');
      tracker.requestSuspend(); // queued, not resolved
      expect(tracker.isSuspendRequested()).toBe(true);

      tracker.cancelSuspend();
      expect(tracker.isSuspendRequested()).toBe(false);
    });

    it('prevents resolution when safe point is later reached', async () => {
      tracker.setPhase('tool_execution');

      let resolved = false;
      tracker.requestSuspend().then(() => {
        resolved = true;
      });

      tracker.cancelSuspend();
      tracker.setPhase('after_tool');

      // Give microtasks a chance to flush
      await Promise.resolve();
      await Promise.resolve();

      // Should NOT have resolved because we cancelled
      expect(resolved).toBe(false);
    });

    it('allows a new suspend request after cancellation', async () => {
      tracker.setPhase('tool_execution');
      tracker.requestSuspend();
      tracker.cancelSuspend();

      // Move to a safe phase, then request again
      tracker.setPhase('after_tool');
      await expect(tracker.requestSuspend()).resolves.toBeUndefined();
      expect(tracker.isSuspendRequested()).toBe(true);
    });
  });

  // ── isSuspendRequested ────────────────────────────────────

  describe('isSuspendRequested', () => {
    it('returns false initially', () => {
      expect(tracker.isSuspendRequested()).toBe(false);
    });

    it('returns true after requestSuspend', async () => {
      await tracker.requestSuspend();
      expect(tracker.isSuspendRequested()).toBe(true);
    });

    it('returns false after cancelSuspend', () => {
      tracker.requestSuspend();
      tracker.cancelSuspend();
      expect(tracker.isSuspendRequested()).toBe(false);
    });
  });

  // ── Multiple rapid suspend requests ───────────────────────

  describe('multiple rapid suspend requests', () => {
    it('returns the same promise for multiple requests at unsafe point', async () => {
      tracker.setPhase('llm_call_in_flight');

      const promise1 = tracker.requestSuspend();
      const promise2 = tracker.requestSuspend();

      // Should be the same promise (or both resolve together)
      tracker.setPhase('after_llm');

      await Promise.all([promise1, promise2]);
      // Both resolved without errors
    });

    it('handles rapid request-cancel-request cycle', async () => {
      tracker.setPhase('tool_execution');

      // First request
      tracker.requestSuspend();
      tracker.cancelSuspend();

      // Second request — still unsafe
      let resolved = false;
      const promise = tracker.requestSuspend().then(() => {
        resolved = true;
      });

      await Promise.resolve();
      expect(resolved).toBe(false);

      // Transition to safe
      tracker.setPhase('after_tool');
      await promise;
      expect(resolved).toBe(true);
    });

    it('multiple requests at safe point all resolve immediately', async () => {
      tracker.setPhase('before_llm');

      await tracker.requestSuspend();
      // Second call when already suspended — should return immediately
      await tracker.requestSuspend();
      // Third call
      await tracker.requestSuspend();

      expect(tracker.isSuspendRequested()).toBe(true);
    });
  });

  // ── setPhase auto-resolves on safe transition ─────────────

  describe('setPhase auto-resolves pending suspend', () => {
    it('resolves pending suspend when setPhase transitions to idle', async () => {
      tracker.setPhase('llm_call_in_flight');

      let resolved = false;
      const promise = tracker.requestSuspend().then(() => {
        resolved = true;
      });

      tracker.setPhase('idle');
      await promise;
      expect(resolved).toBe(true);
    });

    it('does not resolve when transitioning between unsafe phases', async () => {
      tracker.setPhase('before_tool');

      let resolved = false;
      tracker.requestSuspend().then(() => {
        resolved = true;
      });

      // Transition to another unsafe phase
      tracker.setPhase('tool_execution');

      await Promise.resolve();
      await Promise.resolve();
      expect(resolved).toBe(false);
    });
  });
});
