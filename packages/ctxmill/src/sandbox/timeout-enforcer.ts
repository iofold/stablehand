/**
 * TimeoutEnforcer manages per-run timeout timers for sandbox containers.
 *
 * When a run starts in a container, call `startTimeout()` with the run's
 * timeout duration. If the run completes before the timeout, call
 * `cancelTimeout()` to disarm it. If the timer fires, the enforcer
 * invokes the `onTimeout` callback so the caller can stop the container
 * and mark the run as timed out.
 */

const TAG = '[TimeoutEnforcer]';

export class TimeoutEnforcer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Start a timeout timer for a container run.
   *
   * @param runId       Unique run identifier
   * @param containerId Docker container ID to stop on timeout
   * @param timeoutSec  Timeout duration in seconds
   * @param onTimeout   Callback invoked when the timeout fires
   */
  startTimeout(
    runId: string,
    containerId: string,
    timeoutSec: number,
    onTimeout: (runId: string, containerId: string) => void,
  ): void {
    // Cancel any existing timeout for this run (idempotent restart)
    this.cancelTimeout(runId);

    console.debug(`${TAG} starting ${timeoutSec}s timeout for run ${runId} (container=${containerId})`);

    const timer = setTimeout(() => {
      this.timers.delete(runId);
      console.warn(`${TAG} timeout fired for run ${runId} (container=${containerId}) after ${timeoutSec}s`);
      onTimeout(runId, containerId);
    }, timeoutSec * 1000);

    // Unref so the timer does not prevent Node.js from exiting
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref();
    }

    this.timers.set(runId, timer);
  }

  /**
   * Cancel a pending timeout for a run (e.g., run completed normally).
   *
   * @param runId Unique run identifier
   * @returns true if a timer was found and cancelled, false if no timer existed
   */
  cancelTimeout(runId: string): boolean {
    const timer = this.timers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(runId);
      console.debug(`${TAG} cancelled timeout for run ${runId}`);
      return true;
    }
    return false;
  }

  /**
   * Cancel all pending timeouts (e.g., on server shutdown).
   *
   * @returns The number of timeouts that were cancelled
   */
  cancelAll(): number {
    const count = this.timers.size;
    for (const [runId, timer] of this.timers) {
      clearTimeout(timer);
      console.debug(`${TAG} cancelled timeout for run ${runId} (shutdown)`);
    }
    this.timers.clear();
    return count;
  }

  /**
   * Returns the number of currently active timeout timers.
   */
  get activeCount(): number {
    return this.timers.size;
  }

  /**
   * Check whether a timeout is currently active for a given run.
   */
  hasTimeout(runId: string): boolean {
    return this.timers.has(runId);
  }
}
