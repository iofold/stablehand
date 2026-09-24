// ── Container limit error ────────────────────────────────────

export class ContainerLimitError extends Error {
  public readonly statusCode = 503;
  public readonly maxContainers: number;

  constructor(maxContainers: number) {
    super(`Maximum container limit (${maxContainers}) reached. Try again later.`);
    this.name = 'ContainerLimitError';
    this.maxContainers = maxContainers;
  }
}

// ── ContainerSemaphore ───────────────────────────────────────

interface QueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Promise-based semaphore that limits concurrent container allocations.
 * When the limit is reached, acquire() queues the caller and resolves
 * when a slot opens (or rejects after a timeout).
 */
export class ContainerSemaphore {
  private active = 0;
  private peak = 0;
  private readonly queue: QueueEntry[] = [];

  constructor(
    private maxConcurrent: number,
    private queueTimeoutMs: number,
  ) {}

  /**
   * Apply new limits at runtime (live settings, ctx-reir). Raising the limit
   * wakes queued waiters immediately; lowering it only affects new acquires
   * (running containers are never evicted). A new queue timeout applies to
   * future acquires; already-queued waiters keep their original deadline.
   */
  updateLimits(update: { maxConcurrent?: number; queueTimeoutMs?: number }): void {
    if (update.queueTimeoutMs !== undefined) {
      this.queueTimeoutMs = update.queueTimeoutMs;
    }
    if (update.maxConcurrent !== undefined) {
      this.maxConcurrent = update.maxConcurrent;
      while (this.queue.length > 0 && this.active < this.maxConcurrent) {
        const next = this.queue.shift()!;
        clearTimeout(next.timer);
        this.active++;
        this.peak = Math.max(this.peak, this.active);
        next.resolve();
      }
    }
  }

  /**
   * Acquire a slot. Resolves immediately if under the limit,
   * otherwise queues until a slot opens or the timeout expires.
   */
  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      this.peak = Math.max(this.peak, this.active);
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((e) => e.resolve === resolve);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new ContainerLimitError(this.maxConcurrent));
      }, this.queueTimeoutMs);
      // Don't let the timer keep the process alive
      if (timer && typeof timer === 'object' && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref();
      }
      this.queue.push({ resolve, reject, timer });
    });
  }

  /**
   * Take a slot unconditionally, even past maxConcurrent. Used when seeding
   * accounting from containers that already exist at boot (ctx-wbt): they are
   * running whether or not we have capacity, so active may temporarily exceed
   * the limit until they are reaped (new acquires queue until then).
   */
  seedActive(): void {
    this.active++;
    this.peak = Math.max(this.peak, this.active);
  }

  /**
   * Release a slot, then wake queued requests (FIFO) while capacity remains
   * under the current limit — after a live limit decrease (or boot-time
   * over-seeding) the active count must fall back under the limit before
   * waiters run. Gracefully handles over-release (active never goes below 0).
   */
  release(): void {
    this.active = Math.max(0, this.active - 1);
    while (this.queue.length > 0 && this.active < this.maxConcurrent) {
      const next = this.queue.shift()!;
      clearTimeout(next.timer);
      this.active++;
      this.peak = Math.max(this.peak, this.active);
      next.resolve();
    }
  }

  getActive(): number {
    return this.active;
  }

  getQueued(): number {
    return this.queue.length;
  }

  getPeak(): number {
    return this.peak;
  }
}
