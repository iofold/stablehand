import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PauseManager } from '../pause-manager.js';
import type { ContainerManager } from '../container-manager.js';

// ── Helpers ───────────────────────────────────────────────────

function createMockContainerManager(): ContainerManager {
  return {
    pauseContainer: vi.fn().mockResolvedValue(undefined),
    unpauseContainer: vi.fn().mockResolvedValue(undefined),
    // Stubs for unused methods
    createContainer: vi.fn(),
    startContainer: vi.fn(),
    stopContainer: vi.fn(),
    removeContainer: vi.fn(),
    injectSecrets: vi.fn(),
    extractWorkspaceDiff: vi.fn(),
    extractLogs: vi.fn(),
    getContainer: vi.fn(),
    listManagedContainers: vi.fn(),
    getContainerExitCode: vi.fn(),
    ensureNetwork: vi.fn(),
    cleanupOrphans: vi.fn(),
  } as unknown as ContainerManager;
}

// ── Tests ─────────────────────────────────────────────────────

describe('PauseManager', () => {
  let cm: ContainerManager;
  let pm: PauseManager;
  let onPromote: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    cm = createMockContainerManager();
    onPromote = vi.fn().mockResolvedValue(undefined);
    pm = new PauseManager({
      containerManager: cm,
      pauseDelayMs: 5_000,
      maxPauseDurationMs: 300_000,
      onPromoteToCheckpoint: onPromote,
    });
  });

  afterEach(() => {
    pm.cleanupAll();
    vi.useRealTimers();
  });

  // ── State transitions ─────────────────────────────────────

  describe('state transitions', () => {
    it('starts with state "none" for unknown runs', () => {
      expect(pm.getState('unknown-run')).toBe('none');
    });

    it('transitions none → scheduled on schedulePause', () => {
      pm.schedulePause('run-1', 'container-abc');
      expect(pm.getState('run-1')).toBe('scheduled');
    });

    it('transitions scheduled → paused after pauseDelayMs', async () => {
      pm.schedulePause('run-1', 'container-abc');
      expect(pm.getState('run-1')).toBe('scheduled');

      await vi.advanceTimersByTimeAsync(5_000);

      expect(pm.getState('run-1')).toBe('paused');
      expect(cm.pauseContainer).toHaveBeenCalledWith('container-abc');
    });

    it('transitions paused → promoting after maxPauseDurationMs', async () => {
      pm.schedulePause('run-1', 'container-abc');

      // Advance past pause delay
      await vi.advanceTimersByTimeAsync(5_000);
      expect(pm.getState('run-1')).toBe('paused');

      // Advance past promotion timer
      await vi.advanceTimersByTimeAsync(300_000);

      // After promotion completes, entry is cleaned up
      expect(pm.getState('run-1')).toBe('none');
      expect(onPromote).toHaveBeenCalledWith('run-1');
    });
  });

  // ── schedulePause ─────────────────────────────────────────

  describe('schedulePause', () => {
    it('pauses the container after the delay', async () => {
      pm.schedulePause('run-1', 'container-abc');

      // Should not pause before the delay
      await vi.advanceTimersByTimeAsync(4_999);
      expect(cm.pauseContainer).not.toHaveBeenCalled();

      // Should pause at exactly the delay
      await vi.advanceTimersByTimeAsync(1);
      expect(cm.pauseContainer).toHaveBeenCalledTimes(1);
      expect(cm.pauseContainer).toHaveBeenCalledWith('container-abc');
    });

    it('is idempotent — multiple calls do not restart timers', async () => {
      pm.schedulePause('run-1', 'container-abc');

      // Advance 3 seconds
      await vi.advanceTimersByTimeAsync(3_000);

      // Schedule again — should be ignored
      pm.schedulePause('run-1', 'container-abc');

      // Pause should fire at 5s from first call, not from second
      await vi.advanceTimersByTimeAsync(2_000);
      expect(cm.pauseContainer).toHaveBeenCalledTimes(1);
    });

    it('cleans up entry on pause failure', async () => {
      (cm.pauseContainer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Docker error'));

      pm.schedulePause('run-1', 'container-abc');
      await vi.advanceTimersByTimeAsync(5_000);

      expect(pm.getState('run-1')).toBe('none');
      expect(pm.activeCount).toBe(0);
    });
  });

  // ── cancelPause ───────────────────────────────────────────

  describe('cancelPause', () => {
    it('cancels before pause delay — container never paused', async () => {
      pm.schedulePause('run-1', 'container-abc');
      expect(pm.getState('run-1')).toBe('scheduled');

      await pm.cancelPause('run-1');

      expect(pm.getState('run-1')).toBe('none');
      expect(cm.pauseContainer).not.toHaveBeenCalled();
      expect(cm.unpauseContainer).not.toHaveBeenCalled();

      // Advance well past the delay — pause should never fire
      await vi.advanceTimersByTimeAsync(10_000);
      expect(cm.pauseContainer).not.toHaveBeenCalled();
    });

    it('unpauses a paused container immediately', async () => {
      pm.schedulePause('run-1', 'container-abc');

      // Let the pause happen
      await vi.advanceTimersByTimeAsync(5_000);
      expect(pm.getState('run-1')).toBe('paused');

      // Cancel (unpause)
      await pm.cancelPause('run-1');

      expect(cm.unpauseContainer).toHaveBeenCalledWith('container-abc');
      expect(pm.getState('run-1')).toBe('none');
    });

    it('cancels the promotion timer when unpausing', async () => {
      pm.schedulePause('run-1', 'container-abc');

      // Let the pause happen
      await vi.advanceTimersByTimeAsync(5_000);

      // Cancel (unpause)
      await pm.cancelPause('run-1');

      // Advance well past the promotion timer — should NOT fire
      await vi.advanceTimersByTimeAsync(300_000);
      expect(onPromote).not.toHaveBeenCalled();
    });

    it('is a no-op when no pause is scheduled', async () => {
      await pm.cancelPause('unknown-run');
      expect(cm.pauseContainer).not.toHaveBeenCalled();
      expect(cm.unpauseContainer).not.toHaveBeenCalled();
    });

    it('handles unpause failure gracefully', async () => {
      (cm.unpauseContainer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Docker error'));

      pm.schedulePause('run-1', 'container-abc');
      await vi.advanceTimersByTimeAsync(5_000);

      // Should not throw
      await pm.cancelPause('run-1');

      // Entry should still be cleaned up
      expect(pm.getState('run-1')).toBe('none');
    });
  });

  // ── Promotion ──────────────────────────────────────────────

  describe('promotion to checkpoint', () => {
    it('calls onPromoteToCheckpoint after maxPauseDurationMs', async () => {
      pm.schedulePause('run-1', 'container-abc');

      // Let the pause happen (5s)
      await vi.advanceTimersByTimeAsync(5_000);
      expect(pm.getState('run-1')).toBe('paused');

      // Let the promotion timer fire (5 min)
      await vi.advanceTimersByTimeAsync(300_000);
      expect(onPromote).toHaveBeenCalledWith('run-1');
      expect(pm.getState('run-1')).toBe('none');
    });

    it('handles promotion callback failure gracefully', async () => {
      onPromote.mockRejectedValueOnce(new Error('checkpoint failed'));

      pm.schedulePause('run-1', 'container-abc');
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(300_000);

      // Entry should still be cleaned up
      expect(pm.getState('run-1')).toBe('none');
    });

    it('does not promote if no callback is configured', async () => {
      const pmNoCallback = new PauseManager({
        containerManager: cm,
        pauseDelayMs: 5_000,
        maxPauseDurationMs: 300_000,
      });

      pmNoCallback.schedulePause('run-1', 'container-abc');
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(300_000);

      // Should not throw, entry cleaned up
      expect(pmNoCallback.getState('run-1')).toBe('none');
      pmNoCallback.cleanupAll();
    });
  });

  // ── cleanup ────────────────────────────────────────────────

  describe('cleanup', () => {
    it('cancels all timers for a run', async () => {
      pm.schedulePause('run-1', 'container-abc');
      pm.cleanup('run-1');

      expect(pm.getState('run-1')).toBe('none');
      expect(pm.activeCount).toBe(0);

      // Ensure timers don't fire
      await vi.advanceTimersByTimeAsync(10_000);
      expect(cm.pauseContainer).not.toHaveBeenCalled();
    });

    it('cancels promotion timer for a paused run', async () => {
      pm.schedulePause('run-1', 'container-abc');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(pm.getState('run-1')).toBe('paused');

      pm.cleanup('run-1');

      await vi.advanceTimersByTimeAsync(300_000);
      expect(onPromote).not.toHaveBeenCalled();
    });

    it('is a no-op for unknown runs', () => {
      pm.cleanup('unknown-run'); // should not throw
      expect(pm.activeCount).toBe(0);
    });
  });

  // ── cleanupAll ─────────────────────────────────────────────

  describe('cleanupAll', () => {
    it('cleans up all tracked runs', async () => {
      pm.schedulePause('run-1', 'c1');
      pm.schedulePause('run-2', 'c2');
      pm.schedulePause('run-3', 'c3');

      expect(pm.activeCount).toBe(3);

      pm.cleanupAll();

      expect(pm.activeCount).toBe(0);
      expect(pm.getState('run-1')).toBe('none');
      expect(pm.getState('run-2')).toBe('none');
      expect(pm.getState('run-3')).toBe('none');

      // Ensure no timers fire
      await vi.advanceTimersByTimeAsync(310_000);
      expect(cm.pauseContainer).not.toHaveBeenCalled();
    });

    it('handles empty state', () => {
      pm.cleanupAll(); // should not throw
      expect(pm.activeCount).toBe(0);
    });
  });

  // ── activeCount ────────────────────────────────────────────

  describe('activeCount', () => {
    it('tracks scheduled runs', () => {
      expect(pm.activeCount).toBe(0);

      pm.schedulePause('run-1', 'c1');
      expect(pm.activeCount).toBe(1);

      pm.schedulePause('run-2', 'c2');
      expect(pm.activeCount).toBe(2);
    });

    it('decrements when runs are cleaned up', () => {
      pm.schedulePause('run-1', 'c1');
      pm.schedulePause('run-2', 'c2');
      expect(pm.activeCount).toBe(2);

      pm.cleanup('run-1');
      expect(pm.activeCount).toBe(1);

      pm.cleanup('run-2');
      expect(pm.activeCount).toBe(0);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────

  describe('edge cases', () => {
    it('user responds during the 5-second delay — never pauses', async () => {
      pm.schedulePause('run-1', 'container-abc');

      // User responds in 2 seconds
      await vi.advanceTimersByTimeAsync(2_000);
      await pm.cancelPause('run-1');

      // Advance past delay — should not pause
      await vi.advanceTimersByTimeAsync(10_000);
      expect(cm.pauseContainer).not.toHaveBeenCalled();
    });

    it('user responds while paused — unpauses immediately', async () => {
      pm.schedulePause('run-1', 'container-abc');

      // Let pause happen
      await vi.advanceTimersByTimeAsync(5_000);
      expect(cm.pauseContainer).toHaveBeenCalledTimes(1);

      // User responds
      await pm.cancelPause('run-1');
      expect(cm.unpauseContainer).toHaveBeenCalledWith('container-abc');
    });

    it('multiple approval_needed events are idempotent', () => {
      pm.schedulePause('run-1', 'container-abc');
      pm.schedulePause('run-1', 'container-abc');
      pm.schedulePause('run-1', 'container-abc');

      expect(pm.activeCount).toBe(1);
    });

    it('cancelPause when no pause scheduled is a no-op', async () => {
      await pm.cancelPause('nonexistent');
      expect(cm.pauseContainer).not.toHaveBeenCalled();
      expect(cm.unpauseContainer).not.toHaveBeenCalled();
    });

    it('supports custom pause delay and max pause duration', async () => {
      const customPm = new PauseManager({
        containerManager: cm,
        pauseDelayMs: 1_000,
        maxPauseDurationMs: 10_000,
        onPromoteToCheckpoint: onPromote,
      });

      customPm.schedulePause('run-1', 'c1');

      // Pause after 1s, not 5s
      await vi.advanceTimersByTimeAsync(1_000);
      expect(cm.pauseContainer).toHaveBeenCalledTimes(1);

      // Promote after 10s, not 5min
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onPromote).toHaveBeenCalledWith('run-1');

      customPm.cleanupAll();
    });

    it('executePause is a no-op if entry was cancelled before timer fires', async () => {
      pm.schedulePause('run-1', 'container-abc');

      // Clean up before timer fires
      pm.cleanup('run-1');

      // Advance past delay — executePause should find no entry
      await vi.advanceTimersByTimeAsync(5_000);
      expect(cm.pauseContainer).not.toHaveBeenCalled();
    });

    it('executePromotion is a no-op if entry was cancelled before timer fires', async () => {
      pm.schedulePause('run-1', 'container-abc');

      // Let pause happen
      await vi.advanceTimersByTimeAsync(5_000);
      expect(pm.getState('run-1')).toBe('paused');

      // Cancel during pause window
      await pm.cancelPause('run-1');

      // Advance past promotion timer — should not promote
      await vi.advanceTimersByTimeAsync(300_000);
      expect(onPromote).not.toHaveBeenCalled();
    });
  });
});
