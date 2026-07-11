import { ContainerSemaphore } from './container-semaphore.js';

export interface ContainerAccountingEntry {
  containerId: string;
  harnessName: string;
  startedAtMs?: number;
}

export interface ContainerAccountingMetrics {
  active: number;
  queued: number;
  peak: number;
  totalCreated: number;
  byHarness: Record<string, number>;
  averageLifetimeMs: number;
  maxGlobalContainers: number;
}

/**
 * Slot + metrics accounting for sandbox containers (ctx-wbt), shared by the
 * docker and kubernetes managers. Membership is keyed by containerId — any
 * tracked container frees its slot on release, whether it was created by this
 * process or rehydrated from labels at boot. Rehydration (or a live limit
 * decrease, ctx-reir) may push `active` past maxGlobalContainers; new
 * acquires queue until active converges below the limit (hard cap).
 */
export class ContainerAccounting {
  private readonly semaphore: ContainerSemaphore;
  private totalCreated = 0;
  private readonly activeByHarness = new Map<string, number>();
  private readonly containerStartTimes = new Map<string, number>();
  private readonly containerHarness = new Map<string, string>();
  private completedCount = 0;
  private lifetimeSumMs = 0;

  constructor(
    private maxGlobalContainers: number,
    queueTimeoutMs: number,
  ) {
    this.semaphore = new ContainerSemaphore(maxGlobalContainers, queueTimeoutMs);
  }

  /** Apply new limits at runtime (live settings, ctx-reir). */
  updateLimits(update: { maxGlobalContainers?: number; queueTimeoutMs?: number }): void {
    if (update.maxGlobalContainers !== undefined) {
      this.maxGlobalContainers = update.maxGlobalContainers;
    }
    this.semaphore.updateLimits({
      maxConcurrent: update.maxGlobalContainers,
      queueTimeoutMs: update.queueTimeoutMs,
    });
  }

  /** Acquire a creation slot (queues at capacity, rejects on timeout). */
  async acquireSlot(): Promise<void> {
    await this.semaphore.acquire();
  }

  /** Return a slot acquired for a creation that failed before registration. */
  releaseUnregisteredSlot(): void {
    this.semaphore.release();
  }

  /** Register a container created by this process against its held slot. */
  registerCreated(containerId: string, harnessName: string): void {
    this.totalCreated++;
    this.track(containerId, harnessName, Date.now());
  }

  /**
   * Seed accounting from live containers discovered at boot. Idempotent per
   * containerId; each new entry consumes a slot (past the limit if needed).
   * Returns the number of entries seeded.
   */
  rehydrate(entries: ContainerAccountingEntry[]): number {
    let seeded = 0;
    for (const entry of entries) {
      if (this.containerHarness.has(entry.containerId)) {
        continue;
      }
      this.semaphore.seedActive();
      this.track(entry.containerId, entry.harnessName, entry.startedAtMs ?? Date.now());
      seeded++;
    }
    return seeded;
  }

  /**
   * Free the slot for a tracked container (membership-keyed, not
   * created-by-this-process). Returns false for untracked containers.
   */
  releaseFor(containerId: string): boolean {
    if (!this.containerHarness.has(containerId)) {
      return false;
    }
    this.semaphore.release();
    this.recordCompletion(containerId);
    return true;
  }

  isTracked(containerId: string): boolean {
    return this.containerHarness.has(containerId);
  }

  getActive(): number {
    return this.semaphore.getActive();
  }

  getQueued(): number {
    return this.semaphore.getQueued();
  }

  getPeak(): number {
    return this.semaphore.getPeak();
  }

  getMetrics(): ContainerAccountingMetrics {
    const byHarness: Record<string, number> = {};
    for (const [harness, count] of this.activeByHarness) {
      byHarness[harness] = count;
    }
    return {
      active: this.semaphore.getActive(),
      queued: this.semaphore.getQueued(),
      peak: this.semaphore.getPeak(),
      totalCreated: this.totalCreated,
      byHarness,
      averageLifetimeMs: this.completedCount > 0
        ? Math.round(this.lifetimeSumMs / this.completedCount)
        : 0,
      maxGlobalContainers: this.maxGlobalContainers,
    };
  }

  private track(containerId: string, harnessName: string, startedAtMs: number): void {
    this.activeByHarness.set(harnessName, (this.activeByHarness.get(harnessName) ?? 0) + 1);
    this.containerStartTimes.set(containerId, startedAtMs);
    this.containerHarness.set(containerId, harnessName);
  }

  private recordCompletion(containerId: string): void {
    const startTime = this.containerStartTimes.get(containerId);
    if (startTime !== undefined) {
      this.completedCount++;
      this.lifetimeSumMs += Date.now() - startTime;
      this.containerStartTimes.delete(containerId);
    }

    const harnessName = this.containerHarness.get(containerId);
    if (harnessName) {
      const current = this.activeByHarness.get(harnessName) ?? 0;
      if (current <= 1) {
        this.activeByHarness.delete(harnessName);
      } else {
        this.activeByHarness.set(harnessName, current - 1);
      }
      this.containerHarness.delete(containerId);
    }
  }
}
