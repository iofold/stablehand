/**
 * PauseManager — manages Docker pause/unpause lifecycle for HITL waits and
 * session-keyed idle timeouts.
 *
 * HITL flow (unchanged):
 *  1. Schedules a pause after a short delay (pauseDelayMs, default 5s) to give
 *     the user a chance to respond quickly without any pause overhead.
 *  2. Executes `docker pause` via ContainerManager (~1ms, preserves full state).
 *  3. Starts a promotion timer (maxPauseDurationMs, default 5 minutes). If the
 *     user hasn't responded by then, promotes to a full checkpoint via the
 *     onPromoteToCheckpoint callback.
 *  4. On approval response, cancels/reverses any active pause instantly via
 *     `docker unpause`.
 *
 * Idle timeout flow (additive):
 *  1. Caller registers scheduleIdleTimeout(sessionId, containerId, callbacks)
 *     at turn end. Idle timer starts at idleTimeoutMs (default 5 min).
 *  2. If no cancelIdleTimeout call arrives before the timer fires, onFreeze is
 *     called (container freeze) and state → 'idle_frozen'.
 *  3. A freeze-promotion timer then waits freezePromotionMs (default 10 min).
 *     If the session is still idle, onCheckpoint is called (full suspend).
 *  4. On new turn start, cancelIdleTimeout cancels pending timers and unpauses
 *     an already idle-frozen container.
 *
 * The two flows track separate timer slots on the same PauseEntry so they can
 * coexist without interfering. Idle freeze is skipped when a HITL pause is
 * already active (state !== 'none').
 *
 * The gRPC stream survives pause/unpause for short durations because the TCP
 * connection is preserved by the kernel.
 */

import type { ContainerManager } from './container-manager.js';

const TAG = '[PauseManager]';

// ── Types ─────────────────────────────────────────────────────

export type PauseState = 'none' | 'scheduled' | 'paused' | 'promoting' | 'idle_frozen';

export interface PauseManagerOptions {
  containerManager: ContainerManager;
  /** Delay before pausing after scheduling (default: 5000ms = 5 seconds) */
  pauseDelayMs?: number;
  /** Max pause duration before promoting to checkpoint (default: 300000ms = 5 minutes) */
  maxPauseDurationMs?: number;
  /** Callback when a paused container should be promoted to a full checkpoint */
  onPromoteToCheckpoint?: (sessionId: string) => Promise<void>;
  /** Idle inactivity before freezing the container (default: 300000ms = 5 minutes) */
  idleTimeoutMs?: number;
  /** Time after idle freeze before promoting to a full checkpoint (default: 600000ms = 10 minutes) */
  freezePromotionMs?: number;
}

interface IdleCallbacks {
  onFreeze: (sessionId: string) => Promise<void>;
  onCheckpoint: (sessionId: string) => Promise<void>;
}

interface PauseEntry {
  containerId: string;
  state: PauseState;
  /** Timer that fires to execute the actual docker pause (HITL) */
  pauseTimer?: ReturnType<typeof setTimeout>;
  /** Timer that fires to promote a HITL-paused container to checkpoint */
  promotionTimer?: ReturnType<typeof setTimeout>;
  /** Timer that fires to freeze the container after idle inactivity */
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Timer that fires to promote an idle-frozen container to a full checkpoint */
  freezePromotionTimer?: ReturnType<typeof setTimeout>;
  /** Callbacks stored so cancelIdleTimeout can reference them if needed */
  idleCallbacks?: IdleCallbacks;
}

// ── PauseManager ──────────────────────────────────────────────

export class PauseManager {
  private readonly containerManager: ContainerManager;
  private readonly pauseDelayMs: number;
  private readonly maxPauseDurationMs: number;
  private readonly onPromoteToCheckpoint?: (sessionId: string) => Promise<void>;
  private readonly idleTimeoutMs: number;
  private readonly freezePromotionMs: number;
  private readonly entries = new Map<string, PauseEntry>();

  constructor(options: PauseManagerOptions) {
    this.containerManager = options.containerManager;
    this.pauseDelayMs = options.pauseDelayMs ?? 5_000;
    this.maxPauseDurationMs = options.maxPauseDurationMs ?? 300_000;
    this.onPromoteToCheckpoint = options.onPromoteToCheckpoint;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 300_000;
    this.freezePromotionMs = options.freezePromotionMs ?? 600_000;
  }

  // ── HITL pause API ──────────────────────────────────────────

  /**
   * Schedule a container pause. Called when the agent enters HITL wait.
   *
   * After pauseDelayMs of inactivity, pauses the container.
   * After maxPauseDurationMs of being paused, promotes to checkpoint.
   *
   * Idempotent: calling multiple times for the same sessionId reuses the
   * existing schedule (does not restart timers).
   */
  schedulePause(sessionId: string, containerId: string): void {
    // Idempotent — if already scheduled or paused, do nothing
    const existing = this.entries.get(sessionId);
    if (existing && existing.state !== 'none') {
      console.debug(`${TAG} pause already ${existing.state} for session ${sessionId}, ignoring duplicate schedule`);
      return;
    }

    console.debug(`${TAG} scheduling pause for session ${sessionId} (container=${containerId}) in ${this.pauseDelayMs}ms`);

    // Preserve any idle timers already registered on this entry
    const entry: PauseEntry = existing ?? { containerId, state: 'none' };
    entry.containerId = containerId;
    entry.state = 'scheduled';

    const pauseTimer = setTimeout(() => {
      void this.executePause(sessionId);
    }, this.pauseDelayMs);

    // Don't prevent Node.js from exiting
    if (typeof pauseTimer === 'object' && 'unref' in pauseTimer) {
      pauseTimer.unref();
    }

    entry.pauseTimer = pauseTimer;
    this.entries.set(sessionId, entry);
  }

  /**
   * Cancel a scheduled or active HITL pause. Called when HITL approval is received.
   *
   * - If container is paused, unpauses it immediately.
   * - If pause is scheduled but not yet executed, cancels the schedule.
   * - If no pause is active, this is a no-op.
   */
  async cancelPause(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.state === 'none') {
      console.debug(`${TAG} no active pause for session ${sessionId}, cancelPause is a no-op`);
      return;
    }

    const previousState = entry.state;

    // Clear HITL timers
    if (entry.pauseTimer) {
      clearTimeout(entry.pauseTimer);
      entry.pauseTimer = undefined;
    }
    if (entry.promotionTimer) {
      clearTimeout(entry.promotionTimer);
      entry.promotionTimer = undefined;
    }

    // If container was actually paused, unpause it
    if (previousState === 'paused') {
      console.debug(`${TAG} unpausing container for session ${sessionId} (container=${entry.containerId})`);
      try {
        await this.containerManager.unpauseContainer(entry.containerId);
        console.debug(`${TAG} container unpaused for session ${sessionId}`);
      } catch (err) {
        console.warn(`${TAG} failed to unpause container for session ${sessionId}:`, err);
      }
    } else {
      console.debug(`${TAG} cancelled scheduled pause for session ${sessionId} (was: ${previousState})`);
    }

    // Reset HITL state — keep the entry alive if idle timers are still pending
    entry.state = 'none';
    if (!entry.idleTimer && !entry.freezePromotionTimer) {
      this.entries.delete(sessionId);
    }
  }

  // ── Idle timeout API ────────────────────────────────────────

  /**
   * Schedule an idle freeze for a session. Called at the end of each turn.
   *
   * After idleTimeoutMs: calls callbacks.onFreeze (container freeze).
   * After freezePromotionMs beyond the freeze: calls callbacks.onCheckpoint
   * (full suspend / checkpoint promotion).
   *
   * Safe to call multiple times — re-registering cancels the previous idle
   * timer and starts fresh (restarts the idle countdown).
   */
  scheduleIdleTimeout(
    sessionId: string,
    containerId: string,
    callbacks: IdleCallbacks,
  ): void {
    // Always restart the idle countdown when re-registered
    this.cancelIdleTimeout(sessionId);

    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = { containerId, state: 'none' };
      this.entries.set(sessionId, entry);
    }
    entry.containerId = containerId;
    entry.idleCallbacks = callbacks;

    console.debug(`${TAG} scheduling idle timeout for session ${sessionId} in ${this.idleTimeoutMs}ms`);

    const idleTimer = setTimeout(() => {
      void this.executeIdleFreeze(sessionId);
    }, this.idleTimeoutMs);

    if (typeof idleTimer === 'object' && 'unref' in idleTimer) {
      idleTimer.unref();
    }

    entry.idleTimer = idleTimer;
  }

  /**
   * Cancel pending idle freeze and freeze-promotion timers for a session.
   * Called when a new turn starts.
   *
   * If the container is already idle-frozen, it is unpaused immediately.
   */
  cancelIdleTimeout(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
      console.debug(`${TAG} cancelled idle timer for session ${sessionId}`);
    }

    if (entry.freezePromotionTimer) {
      clearTimeout(entry.freezePromotionTimer);
      entry.freezePromotionTimer = undefined;
      console.debug(`${TAG} cancelled freeze-promotion timer for session ${sessionId}`);
    }

    if (entry.state === 'idle_frozen') {
      console.debug(`${TAG} unpausing idle-frozen container for session ${sessionId} (container=${entry.containerId})`);
      entry.state = 'none';
      this.containerManager.unpauseContainer(entry.containerId).catch((err: unknown) => {
        console.warn(`${TAG} failed to unpause idle-frozen container for session ${sessionId}:`, err);
      });
    }

    // Drop the entry if no HITL state remains
    if (entry.state === 'none' && !entry.pauseTimer && !entry.promotionTimer) {
      this.entries.delete(sessionId);
    }
  }

  // ── Shared query/cleanup API ─────────────────────────────────

  /**
   * Get the pause state for a session.
   */
  getState(sessionId: string): PauseState {
    return this.entries.get(sessionId)?.state ?? 'none';
  }

  /**
   * Clean up all timers for a session.
   * Called on run completion/error.
   */
  cleanup(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;

    if (entry.pauseTimer) {
      clearTimeout(entry.pauseTimer);
    }
    if (entry.promotionTimer) {
      clearTimeout(entry.promotionTimer);
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
    }
    if (entry.freezePromotionTimer) {
      clearTimeout(entry.freezePromotionTimer);
    }

    this.entries.delete(sessionId);
    console.debug(`${TAG} cleaned up pause state for session ${sessionId}`);
  }

  /**
   * Clean up everything (shutdown).
   * Cancels all timers for all sessions.
   */
  cleanupAll(): void {
    for (const [sessionId, entry] of this.entries) {
      if (entry.pauseTimer) {
        clearTimeout(entry.pauseTimer);
      }
      if (entry.promotionTimer) {
        clearTimeout(entry.promotionTimer);
      }
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
      }
      if (entry.freezePromotionTimer) {
        clearTimeout(entry.freezePromotionTimer);
      }
      console.debug(`${TAG} cleaned up pause state for session ${sessionId} (shutdown)`);
    }
    this.entries.clear();
  }

  /**
   * Returns the number of currently tracked sessions.
   */
  get activeCount(): number {
    return this.entries.size;
  }

  // ── Private — HITL ──────────────────────────────────────────

  /**
   * Execute the actual docker pause, then start the HITL promotion timer.
   */
  private async executePause(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.state !== 'scheduled') {
      // Already cancelled or cleaned up before the timer fired
      return;
    }

    console.debug(`${TAG} pausing container for session ${sessionId} (container=${entry.containerId})`);

    try {
      await this.containerManager.pauseContainer(entry.containerId);
      entry.state = 'paused';
      entry.pauseTimer = undefined;
      console.debug(`${TAG} container paused for session ${sessionId}`);

      // Start HITL promotion timer
      const promotionTimer = setTimeout(() => {
        void this.executePromotion(sessionId);
      }, this.maxPauseDurationMs);

      if (typeof promotionTimer === 'object' && 'unref' in promotionTimer) {
        promotionTimer.unref();
      }

      entry.promotionTimer = promotionTimer;
    } catch (err) {
      console.warn(`${TAG} failed to pause container for session ${sessionId}:`, err);
      // Clean up on failure — don't leave stale entry (preserve idle timers if any)
      if (entry.idleTimer || entry.freezePromotionTimer) {
        entry.state = 'none';
        entry.pauseTimer = undefined;
      } else {
        this.entries.delete(sessionId);
      }
    }
  }

  /**
   * Execute the HITL promotion to a full checkpoint.
   */
  private async executePromotion(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.state !== 'paused') {
      // Already cancelled, cleaned up, or unpaused
      return;
    }

    entry.state = 'promoting';
    entry.promotionTimer = undefined;
    console.debug(`${TAG} promoting paused container for session ${sessionId} to checkpoint`);

    if (this.onPromoteToCheckpoint) {
      try {
        await this.onPromoteToCheckpoint(sessionId);
        console.debug(`${TAG} promotion to checkpoint complete for session ${sessionId}`);
      } catch (err) {
        console.warn(`${TAG} promotion to checkpoint failed for session ${sessionId}:`, err);
      }
    } else {
      console.warn(`${TAG} no onPromoteToCheckpoint callback configured; session ${sessionId} remains paused`);
    }

    // Clean up after promotion (the checkpoint handler takes ownership).
    // Preserve idle timers if any are pending.
    if (entry.idleTimer || entry.freezePromotionTimer) {
      entry.state = 'none';
    } else {
      this.entries.delete(sessionId);
    }
  }

  // ── Private — Idle ───────────────────────────────────────────

  /**
   * Execute the idle freeze after the idle timeout fires.
   * Skipped if a HITL pause is already active.
   */
  private async executeIdleFreeze(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;

    entry.idleTimer = undefined;

    // Don't override an active HITL pause
    if (entry.state !== 'none') {
      console.debug(`${TAG} skipping idle freeze for session ${sessionId} (state=${entry.state})`);
      return;
    }

    const callbacks = entry.idleCallbacks;
    if (!callbacks) return;

    console.debug(`${TAG} executing idle freeze for session ${sessionId} (container=${entry.containerId})`);

    try {
      await callbacks.onFreeze(sessionId);
      entry.state = 'idle_frozen';
      console.debug(`${TAG} idle freeze complete for session ${sessionId}`);

      // Schedule freeze-promotion timer
      const freezePromotionTimer = setTimeout(() => {
        void this.executeIdlePromotion(sessionId);
      }, this.freezePromotionMs);

      if (typeof freezePromotionTimer === 'object' && 'unref' in freezePromotionTimer) {
        freezePromotionTimer.unref();
      }

      entry.freezePromotionTimer = freezePromotionTimer;
    } catch (err) {
      console.warn(`${TAG} idle freeze failed for session ${sessionId}:`, err);
      // Don't leave stale entry if nothing else is pending
      if (!entry.pauseTimer && !entry.promotionTimer) {
        this.entries.delete(sessionId);
      }
    }
  }

  /**
   * Execute the idle checkpoint promotion after the freeze-promotion timer fires.
   */
  private async executeIdlePromotion(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.state !== 'idle_frozen') {
      // Already cancelled, resumed, or cleaned up
      return;
    }

    entry.state = 'promoting';
    entry.freezePromotionTimer = undefined;

    const callbacks = entry.idleCallbacks;
    console.debug(`${TAG} promoting idle-frozen container for session ${sessionId} to checkpoint`);

    if (callbacks) {
      try {
        await callbacks.onCheckpoint(sessionId);
        console.debug(`${TAG} idle checkpoint promotion complete for session ${sessionId}`);
      } catch (err) {
        console.warn(`${TAG} idle checkpoint promotion failed for session ${sessionId}:`, err);
      }
    } else {
      console.warn(`${TAG} no idle callbacks available for session ${sessionId}; skipping checkpoint promotion`);
    }

    // Checkpoint handler takes ownership — remove entry
    this.entries.delete(sessionId);
  }
}
