import type { ContainerManager, ContainerInfo } from './container-manager.js';

// ── Public interfaces ─────────────────────────────────────────

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export interface OrphanCleanupOptions {
  containerManager: ContainerManager;
  /** Query DB for run IDs with status 'running' or 'queued'. */
  getActiveRunIds: () => Promise<Set<string>>;
  /** Optional callback to mark an orphaned run as 'failed' in the DB. */
  markRunFailed?: (runId: string, error: string) => Promise<void>;
  logger?: Logger;
}

export interface CleanupResult {
  orphansFound: number;
  cleaned: number;
  errors: number;
}

// ── Default console logger ────────────────────────────────────

const TAG = '[OrphanCleanup]';

const defaultLogger: Logger = {
  info: (msg, ...args) => console.log(`${TAG} ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`${TAG} ${msg}`, ...args),
  error: (msg, ...args) => console.error(`${TAG} ${msg}`, ...args),
  debug: (msg, ...args) => console.debug(`${TAG} ${msg}`, ...args),
};

// ── OrphanCleanup ─────────────────────────────────────────────

export class OrphanCleanup {
  private readonly containerManager: ContainerManager;
  private readonly getActiveRunIds: () => Promise<Set<string>>;
  private readonly markRunFailed?: (runId: string, error: string) => Promise<void>;
  private readonly logger: Logger;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: OrphanCleanupOptions) {
    this.containerManager = options.containerManager;
    this.getActiveRunIds = options.getActiveRunIds;
    this.markRunFailed = options.markRunFailed;
    this.logger = options.logger ?? defaultLogger;
  }

  /**
   * Run cleanup once (called on startup).
   * - Lists all ctxmill.managed containers
   * - Cross-references with active runs in DB
   * - Extracts logs (best-effort) before removal
   * - Stops and removes orphans with a 10-second grace period
   * - Marks orphaned runs as 'failed' in DB
   * - Returns count of cleaned containers
   */
  async runOnce(): Promise<CleanupResult> {
    const result: CleanupResult = { orphansFound: 0, cleaned: 0, errors: 0 };

    let containers: ContainerInfo[];
    try {
      containers = await this.containerManager.listManagedContainers();
    } catch (err) {
      this.logger.error('Failed to list managed containers', err);
      result.errors++;
      return result;
    }

    if (containers.length === 0) {
      this.logger.debug('No managed containers found');
      return result;
    }

    let activeRunIds: Set<string>;
    try {
      activeRunIds = await this.getActiveRunIds();
    } catch (err) {
      this.logger.error('Failed to query active run IDs from DB', err);
      result.errors++;
      return result;
    }

    // Identify orphans: containers not matching any active run, or expired
    const orphans: Array<{ container: ContainerInfo; reason: string }> = [];
    for (const container of containers) {
      const isActive = activeRunIds.has(container.runId);
      const isExpired = this.isContainerExpired(container);

      if (!isActive) {
        orphans.push({ container, reason: 'no matching active run in DB' });
      } else if (isExpired) {
        orphans.push({ container, reason: 'container exceeded timeout' });
      }
    }

    result.orphansFound = orphans.length;

    if (orphans.length === 0) {
      this.logger.debug('No orphan containers found');
      return result;
    }

    this.logger.info(`Found ${orphans.length} orphan container(s) — cleaning up`);

    for (const { container, reason } of orphans) {
      try {
        await this.cleanupSingleContainer(container, reason);
        result.cleaned++;
      } catch (err) {
        this.logger.error(
          `Failed to clean up container ${container.containerId} (runId=${container.runId})`,
          err,
        );
        result.errors++;
      }
    }

    this.logger.info(
      `Orphan cleanup complete: found=${result.orphansFound}, cleaned=${result.cleaned}, errors=${result.errors}`,
    );

    return result;
  }

  /**
   * Start periodic background sweep (every 5 minutes by default).
   * Returns a cleanup function to stop the interval.
   */
  startPeriodicSweep(intervalMs: number = 5 * 60 * 1000): () => void {
    if (this.sweepTimer) {
      this.logger.warn('Periodic sweep already running — ignoring duplicate start');
      return () => this.stopPeriodicSweep();
    }

    this.logger.info(`Starting periodic orphan sweep every ${intervalMs / 1000}s`);

    this.sweepTimer = setInterval(() => {
      void this.runOnce().catch((err) => {
        this.logger.error('Periodic sweep error', err);
      });
    }, intervalMs);

    // Unref so the timer doesn't keep the Node.js process alive
    if (this.sweepTimer && typeof this.sweepTimer === 'object' && 'unref' in this.sweepTimer) {
      (this.sweepTimer as NodeJS.Timeout).unref();
    }

    return () => this.stopPeriodicSweep();
  }

  /**
   * Stop the periodic sweep if running.
   */
  stopPeriodicSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
      this.logger.info('Periodic orphan sweep stopped');
    }
  }

  // ── Private helpers ─────────────────────────────────────────

  /**
   * Check whether a container has exceeded its timeout based on labels.
   */
  private isContainerExpired(container: ContainerInfo): boolean {
    if (!container.startedAt) return false;
    // We rely on the labels stored on ContainerInfo. The timeout is stored on
    // the Docker label 'ctxmill.timeout' and read by ContainerManager, but
    // ContainerInfo doesn't expose it directly. We access the same calculation
    // that cleanupOrphans uses: (Date.now() - startedAt) / 1000 > timeout.
    // Since we don't have the timeout label on ContainerInfo, we re-check
    // via ContainerManager.cleanupOrphans logic. For now, we consider the
    // container expired if it's older than 2x the default timeout (20 minutes).
    // The ContainerManager.cleanupOrphans will catch the exact timeout.
    const ageMs = Date.now() - container.startedAt.getTime();
    const maxAgeSec = 1200; // 20 minutes — generous fallback
    return ageMs / 1000 > maxAgeSec;
  }

  /**
   * Clean up a single orphan container:
   * 1. Extract logs (best-effort)
   * 2. Stop with 10-second grace period
   * 3. Remove (force)
   * 4. Mark the run as 'failed' in DB
   */
  private async cleanupSingleContainer(
    container: ContainerInfo,
    reason: string,
  ): Promise<void> {
    const { containerId, runId } = container;

    // 1. Best-effort log extraction
    try {
      const logs = await this.containerManager.extractLogs(containerId, 200);
      if (logs) {
        this.logger.debug(
          `Extracted ${logs.length} bytes of logs from orphan ${containerId} (runId=${runId})`,
        );
      }
    } catch {
      // Best-effort — don't fail if log extraction fails
      this.logger.debug(`Could not extract logs from orphan ${containerId} — continuing`);
    }

    // 2. Stop container with 10-second grace period
    try {
      await this.containerManager.stopContainer(containerId, 10);
    } catch {
      // Best-effort stop — container may already be stopped
      this.logger.debug(`Could not stop orphan ${containerId} — may already be stopped`);
    }

    // 3. Force-remove the container
    await this.containerManager.removeContainer(containerId, true);

    // 4. Mark the run as failed in DB
    if (this.markRunFailed) {
      try {
        await this.markRunFailed(
          runId,
          `Orphan container cleaned up on startup: ${reason}`,
        );
        this.logger.debug(`Marked run ${runId} as failed in DB`);
      } catch (err) {
        this.logger.warn(`Failed to mark run ${runId} as failed in DB`, err);
      }
    }
  }
}
