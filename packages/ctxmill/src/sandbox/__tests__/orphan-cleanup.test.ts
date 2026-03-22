import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrphanCleanup, type OrphanCleanupOptions, type Logger } from '../orphan-cleanup.js';
import type { ContainerManager, ContainerInfo } from '../container-manager.js';

// ── Mock factories ──────────────────────────────────────────

function createMockContainerManager(
  overrides: Partial<ContainerManager> = {},
): ContainerManager {
  return {
    listManagedContainers: vi.fn().mockResolvedValue([]),
    extractLogs: vi.fn().mockResolvedValue('mock-logs'),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    removeContainer: vi.fn().mockResolvedValue(undefined),
    // Unused methods — stub them out
    createContainer: vi.fn(),
    startContainer: vi.fn(),
    injectSecrets: vi.fn(),
    extractWorkspaceDiff: vi.fn(),
    getContainer: vi.fn(),
    getContainerExitCode: vi.fn(),
    ensureNetwork: vi.fn(),
    cleanupOrphans: vi.fn(),
    ...overrides,
  } as unknown as ContainerManager;
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeContainerInfo(overrides: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    containerId: 'sha256-abc123',
    containerName: 'ctxmill-run-run-001',
    runId: 'run-001',
    agentId: 'agent-abc',
    harnessName: 'claude-agents',
    status: 'running',
    startedAt: new Date(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('OrphanCleanup', () => {
  let mockCM: ContainerManager;
  let mockLogger: Logger;
  let getActiveRunIds: ReturnType<typeof vi.fn>;
  let markRunFailed: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockCM = createMockContainerManager();
    mockLogger = createMockLogger();
    getActiveRunIds = vi.fn().mockResolvedValue(new Set<string>());
    markRunFailed = vi.fn().mockResolvedValue(undefined);
  });

  function createCleanup(overrides: Partial<OrphanCleanupOptions> = {}): OrphanCleanup {
    return new OrphanCleanup({
      containerManager: mockCM,
      getActiveRunIds,
      markRunFailed,
      logger: mockLogger,
      ...overrides,
    });
  }

  // ── runOnce: clean state (no orphans) ──────────────────

  describe('runOnce — clean state', () => {
    it('returns zeros when no managed containers exist', async () => {
      const cleanup = createCleanup();

      const result = await cleanup.runOnce();

      expect(result).toEqual({ orphansFound: 0, cleaned: 0, errors: 0 });
      expect(mockCM.listManagedContainers).toHaveBeenCalledTimes(1);
      expect(mockCM.stopContainer).not.toHaveBeenCalled();
      expect(mockCM.removeContainer).not.toHaveBeenCalled();
    });

    it('returns zeros when all containers match active runs', async () => {
      const containers = [
        makeContainerInfo({ containerId: 'c1', runId: 'run-1' }),
        makeContainerInfo({ containerId: 'c2', runId: 'run-2' }),
      ];
      (mockCM.listManagedContainers as ReturnType<typeof vi.fn>).mockResolvedValue(containers);
      getActiveRunIds.mockResolvedValue(new Set(['run-1', 'run-2']));

      const cleanup = createCleanup();
      const result = await cleanup.runOnce();

      expect(result).toEqual({ orphansFound: 0, cleaned: 0, errors: 0 });
      expect(mockCM.stopContainer).not.toHaveBeenCalled();
      expect(mockCM.removeContainer).not.toHaveBeenCalled();
    });
  });

  // ── runOnce: orphans (no matching DB run) ──────────────

  describe('runOnce — orphan containers', () => {
    it('cleans up containers without matching active runs', async () => {
      const orphan = makeContainerInfo({ containerId: 'c-orphan', runId: 'orphan-run' });
      (mockCM.listManagedContainers as ReturnType<typeof vi.fn>).mockResolvedValue([orphan]);
      getActiveRunIds.mockResolvedValue(new Set(['other-run']));

      const cleanup = createCleanup();
      const result = await cleanup.runOnce();

      expect(result).toEqual({ orphansFound: 1, cleaned: 1, errors: 0 });
      expect(mockCM.extractLogs).toHaveBeenCalledWith('c-orphan', 200);
      expect(mockCM.stopContainer).toHaveBeenCalledWith('c-orphan', 10);
      expect(mockCM.removeContainer).toHaveBeenCalledWith('c-orphan', true);
      expect(markRunFailed).toHaveBeenCalledWith(
        'orphan-run',
        expect.stringContaining('Orphan container cleaned up'),
      );
    });

    it('handles mixed active and orphan containers', async () => {
      const active = makeContainerInfo({ containerId: 'c-active', runId: 'active-run' });
      const orphan1 = makeContainerInfo({ containerId: 'c-orphan1', runId: 'orphan-1' });
      const orphan2 = makeContainerInfo({ containerId: 'c-orphan2', runId: 'orphan-2' });
      (mockCM.listManagedContainers as ReturnType<typeof vi.fn>).mockResolvedValue([
        active,
        orphan1,
        orphan2,
      ]);
      getActiveRunIds.mockResolvedValue(new Set(['active-run']));

      const cleanup = createCleanup();
      const result = await cleanup.runOnce();

      expect(result).toEqual({ orphansFound: 2, cleaned: 2, errors: 0 });
      // Active container should NOT be stopped or removed
      expect(mockCM.stopContainer).not.toHaveBeenCalledWith('c-active', expect.anything());
      expect(mockCM.removeContainer).not.toHaveBeenCalledWith('c-active', expect.anything());
      // Orphans should be cleaned
      expect(mockCM.stopContainer).toHaveBeenCalledWith('c-orphan1', 10);
      expect(mockCM.stopContainer).toHaveBeenCalledWith('c-orphan2', 10);
    });
  });

  // ── runOnce: expired containers ────────────────────────

  describe('runOnce — expired containers', () => {
    it('cleans up containers that have exceeded the timeout', async () => {
      // Container started 25 minutes ago (> 20 minute fallback threshold)
      const expired = makeContainerInfo({
        containerId: 'c-expired',
        runId: 'expired-run',
        startedAt: new Date(Date.now() - 25 * 60 * 1000),
      });
      (mockCM.listManagedContainers as ReturnType<typeof vi.fn>).mockResolvedValue([expired]);
      // Even though the run is "active" in DB, expired container should be cleaned
      getActiveRunIds.mockResolvedValue(new Set(['expired-run']));

      const cleanup = createCleanup();
      const result = await cleanup.runOnce();

      expect(result).toEqual({ orphansFound: 1, cleaned: 1, errors: 0 });
      expect(mockCM.stopContainer).toHaveBeenCalledWith('c-expired', 10);
      expect(mockCM.removeContainer).toHaveBeenCalledWith('c-expired', true);
    });

    it('does not clean up active containers within timeout', async () => {
      // Container started 5 minutes ago (well within 20 minute threshold)
      const recent = makeContainerInfo({
        containerId: 'c-recent',
        runId: 'recent-run',
        startedAt: new Date(Date.now() - 5 * 60 * 1000),
      });
      (mockCM.listManagedContainers as ReturnType<typeof vi.fn>).mockResolvedValue([recent]);
      getActiveRunIds.mockResolvedValue(new Set(['recent-run']));

      const cleanup = createCleanup();
      const result = await cleanup.runOnce();

      expect(result).toEqual({ orphansFound: 0, cleaned: 0, errors: 0 });
    });
  });

  // ── runOnce: error resilience ──────────────────────────

  describe('runOnce — resilience', () => {
    it('does not crash when listManagedContainers fails', async () => {
      (mockCM.listManagedContainers as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Docker socket unavailable'),
      );

      const cleanup = createCleanup();
      const result = await cleanup.runOnce();

      expect(result).toEqual({ orphansFound: 0, cleaned: 0, errors: 1 });
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to list managed containers',
        expect.any(Error),
      );
    });

    it('does not crash when getActiveRunIds fails', async () => {
      const container = makeContainerInfo();
      (mockCM.listManagedContainers as ReturnType<typeof vi.fn>).mockResolvedValue([container]);
      getActiveRunIds.mockRejectedValue(new Error('DB connection error'));

      const cleanup = createCleanup();
      const result = await cleanup.runOnce();

      expect(result).toEqual({ orphansFound: 0, cleaned: 0, errors: 1 });
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to query active run IDs from DB',
        expect.any(Error),
      );
    });

    it('continues cleaning other containers when one removal fails', async () => {
      const orphan1 = makeContainerInfo({ containerId: 'c1', runId: 'orphan-1' });
      const orphan2 = makeContainerInfo({ containerId: 'c2', runId: 'orphan-2' });
      (mockCM.listManagedContainers as ReturnType<typeof vi.fn>).mockResolvedValue([
        orphan1,
        orphan2,
      ]);
      getActiveRunIds.mockResolvedValue(new Set<string>());

      // First container removal fails, second succeeds
      (mockCM.removeContainer as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('removal failed'))
        .mockResolvedValueOnce(undefined);

      const cleanup = createCleanup();
      const result = await cleanup.runOnce();

      expect(result).toEqual({ orphansFound: 2, cleaned: 1, errors: 1 });
    });

    it('continues when log extraction fails', async () => {
      const orphan = makeContainerInfo({ containerId: 'c1', runId: 'orphan-1' });
      (mockCM.listManagedContainers as ReturnType<typeof vi.fn>).mockResolvedValue([orphan]);
      getActiveRunIds.mockResolvedValue(new Set<string>());
      (mockCM.extractLogs as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('container not running'),
      );

      const cleanup = createCleanup();
      const result = await cleanup.runOnce();

      expect(result).toEqual({ orphansFound: 1, cleaned: 1, errors: 0 });
      // Should still stop and remove
      expect(mockCM.stopContainer).toHaveBeenCalledTimes(1);
      expect(mockCM.removeContainer).toHaveBeenCalledTimes(1);
    });

    it('continues when markRunFailed fails', async () => {
      const orphan = makeContainerInfo({ containerId: 'c1', runId: 'orphan-1' });
      (mockCM.listManagedContainers as ReturnType<typeof vi.fn>).mockResolvedValue([orphan]);
      getActiveRunIds.mockResolvedValue(new Set<string>());
      markRunFailed.mockRejectedValue(new Error('DB error'));

      const cleanup = createCleanup();
      const result = await cleanup.runOnce();

      // Container still cleaned successfully, DB mark failure is a warning
      expect(result).toEqual({ orphansFound: 1, cleaned: 1, errors: 0 });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to mark run'),
        expect.any(Error),
      );
    });

    it('works without markRunFailed callback', async () => {
      const orphan = makeContainerInfo({ containerId: 'c1', runId: 'orphan-1' });
      (mockCM.listManagedContainers as ReturnType<typeof vi.fn>).mockResolvedValue([orphan]);
      getActiveRunIds.mockResolvedValue(new Set<string>());

      const cleanup = createCleanup({ markRunFailed: undefined });
      const result = await cleanup.runOnce();

      expect(result).toEqual({ orphansFound: 1, cleaned: 1, errors: 0 });
    });
  });

  // ── Periodic sweep ─────────────────────────────────────

  describe('startPeriodicSweep', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('starts and stops correctly', () => {
      vi.useFakeTimers();
      const cleanup = createCleanup();

      const stop = cleanup.startPeriodicSweep(60_000);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Starting periodic orphan sweep'),
      );

      stop();
      expect(mockLogger.info).toHaveBeenCalledWith('Periodic orphan sweep stopped');
    });

    it('runs cleanup on each interval tick', async () => {
      vi.useFakeTimers();
      const cleanup = createCleanup();

      // Spy on runOnce
      const runOnceSpy = vi.spyOn(cleanup, 'runOnce').mockResolvedValue({
        orphansFound: 0,
        cleaned: 0,
        errors: 0,
      });

      const stop = cleanup.startPeriodicSweep(1000);

      // No call yet (first tick hasn't fired)
      expect(runOnceSpy).not.toHaveBeenCalled();

      // Advance time by one interval
      await vi.advanceTimersByTimeAsync(1000);
      expect(runOnceSpy).toHaveBeenCalledTimes(1);

      // Advance another interval
      await vi.advanceTimersByTimeAsync(1000);
      expect(runOnceSpy).toHaveBeenCalledTimes(2);

      stop();
      runOnceSpy.mockRestore();
    });

    it('does not crash when periodic sweep encounters an error', async () => {
      vi.useFakeTimers();
      const cleanup = createCleanup();

      vi.spyOn(cleanup, 'runOnce').mockRejectedValue(new Error('sweep failure'));

      const stop = cleanup.startPeriodicSweep(1000);

      // Advance — should not throw
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Periodic sweep error',
        expect.any(Error),
      );

      stop();
    });

    it('ignores duplicate start calls', () => {
      vi.useFakeTimers();
      const cleanup = createCleanup();

      const stop1 = cleanup.startPeriodicSweep(1000);
      const stop2 = cleanup.startPeriodicSweep(1000);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('already running'),
      );

      stop1();
      stop2();
    });

    it('stopPeriodicSweep is idempotent', () => {
      const cleanup = createCleanup();

      // Calling stop when nothing is running should not throw
      cleanup.stopPeriodicSweep();
      cleanup.stopPeriodicSweep();
      // No error logged — it just silently does nothing
    });
  });
});
