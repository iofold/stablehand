import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ContainerSemaphore,
  ContainerLimitError,
  ContainerManager,
} from '../container-manager.js';
import type { CreateContainerOptions } from '../container-manager.js';

// ── ContainerSemaphore unit tests ────────────────────────────

describe('ContainerSemaphore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('acquire / release basics', () => {
    it('succeeds immediately when under the limit', async () => {
      const sem = new ContainerSemaphore(3, 60_000);

      await sem.acquire();

      expect(sem.getActive()).toBe(1);
      expect(sem.getQueued()).toBe(0);
    });

    it('allows multiple acquires up to the limit', async () => {
      const sem = new ContainerSemaphore(3, 60_000);

      await sem.acquire();
      await sem.acquire();
      await sem.acquire();

      expect(sem.getActive()).toBe(3);
      expect(sem.getQueued()).toBe(0);
    });

    it('queues when at the limit', async () => {
      const sem = new ContainerSemaphore(2, 60_000);

      await sem.acquire();
      await sem.acquire();
      // This one should queue
      const p = sem.acquire();
      // Give microtasks a chance to settle
      await vi.advanceTimersByTimeAsync(0);

      expect(sem.getActive()).toBe(2);
      expect(sem.getQueued()).toBe(1);

      // Release one to let the queued request proceed
      sem.release();
      await p;

      expect(sem.getActive()).toBe(2);
      expect(sem.getQueued()).toBe(0);
    });

    it('release without queue decrements active count', async () => {
      const sem = new ContainerSemaphore(5, 60_000);

      await sem.acquire();
      expect(sem.getActive()).toBe(1);

      sem.release();
      expect(sem.getActive()).toBe(0);
    });

    it('release never goes below zero (over-release protection)', () => {
      const sem = new ContainerSemaphore(5, 60_000);

      sem.release();
      sem.release();
      sem.release();

      expect(sem.getActive()).toBe(0);
    });
  });

  describe('queue timeout', () => {
    it('throws ContainerLimitError after timeout expires', async () => {
      const sem = new ContainerSemaphore(1, 5_000);

      await sem.acquire(); // fills the slot
      // Attach a catch handler immediately to prevent unhandled rejection
      let caughtErr: unknown;
      const p = sem.acquire().catch((err) => { caughtErr = err; });

      expect(sem.getQueued()).toBe(1);

      // Advance past the timeout
      await vi.advanceTimersByTimeAsync(5_001);
      await p;

      expect(caughtErr).toBeInstanceOf(ContainerLimitError);
      expect((caughtErr as ContainerLimitError).message).toBe(
        'Maximum container limit (1) reached. Try again later.',
      );
      expect(sem.getQueued()).toBe(0);
    });

    it('ContainerLimitError has statusCode 503', async () => {
      const sem = new ContainerSemaphore(1, 100);
      await sem.acquire();
      let caughtErr: unknown;
      const p = sem.acquire().catch((err) => { caughtErr = err; });

      await vi.advanceTimersByTimeAsync(101);
      await p;

      expect(caughtErr).toBeInstanceOf(ContainerLimitError);
      expect((caughtErr as ContainerLimitError).statusCode).toBe(503);
      expect((caughtErr as ContainerLimitError).maxContainers).toBe(1);
    });
  });

  describe('FIFO ordering', () => {
    it('serves multiple queued requests in FIFO order', async () => {
      const sem = new ContainerSemaphore(1, 60_000);
      const order: number[] = [];

      await sem.acquire(); // fills the slot

      const p1 = sem.acquire().then(() => order.push(1));
      const p2 = sem.acquire().then(() => order.push(2));
      const p3 = sem.acquire().then(() => order.push(3));

      expect(sem.getQueued()).toBe(3);

      // Release slots one by one
      sem.release();
      await vi.advanceTimersByTimeAsync(0);
      await p1;

      sem.release();
      await vi.advanceTimersByTimeAsync(0);
      await p2;

      sem.release();
      await vi.advanceTimersByTimeAsync(0);
      await p3;

      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe('peak tracking', () => {
    it('tracks peak concurrent count correctly', async () => {
      const sem = new ContainerSemaphore(5, 60_000);

      await sem.acquire();
      await sem.acquire();
      await sem.acquire();
      expect(sem.getPeak()).toBe(3);

      sem.release();
      expect(sem.getPeak()).toBe(3); // Peak should remain at 3

      await sem.acquire();
      await sem.acquire();
      expect(sem.getPeak()).toBe(4); // 2 still active + 2 new = 4

      await sem.acquire();
      expect(sem.getPeak()).toBe(5); // 5 active now
    });

    it('peak is 0 when nothing acquired', () => {
      const sem = new ContainerSemaphore(5, 60_000);
      expect(sem.getPeak()).toBe(0);
    });
  });

  describe('timer cleanup on success', () => {
    it('clears timeout timer when release wakes a queued request', async () => {
      const sem = new ContainerSemaphore(1, 60_000);

      await sem.acquire();
      const p = sem.acquire(); // queued
      expect(sem.getQueued()).toBe(1);

      // Release before timeout — should clear the timer and resolve
      sem.release();
      await p;

      // Advance past original timeout — should NOT throw
      await vi.advanceTimersByTimeAsync(60_001);

      expect(sem.getActive()).toBe(1);
      expect(sem.getQueued()).toBe(0);
    });
  });

  describe('live limit updates (ctx-reir)', () => {
    it('raising the limit wakes queued waiters immediately', async () => {
      const sem = new ContainerSemaphore(1, 60_000);

      await sem.acquire();
      const queued1 = sem.acquire();
      const queued2 = sem.acquire();
      expect(sem.getQueued()).toBe(2);

      sem.updateLimits({ maxConcurrent: 3 });
      await queued1;
      await queued2;

      expect(sem.getActive()).toBe(3);
      expect(sem.getQueued()).toBe(0);

      // Original timers were cleared — advancing must not reject anything.
      await vi.advanceTimersByTimeAsync(60_001);
    });

    it('lowering the limit never evicts running work and gates waiters on the new cap', async () => {
      const sem = new ContainerSemaphore(2, 60_000);

      await sem.acquire();
      await sem.acquire();

      sem.updateLimits({ maxConcurrent: 1 });
      expect(sem.getActive()).toBe(2);

      const queued = sem.acquire();
      expect(sem.getQueued()).toBe(1);

      // First release only brings active back to the new cap; the waiter
      // must not run until a slot opens BELOW the cap.
      sem.release();
      expect(sem.getActive()).toBe(1);
      expect(sem.getQueued()).toBe(1);

      sem.release();
      await queued;
      expect(sem.getActive()).toBe(1);
      expect(sem.getQueued()).toBe(0);
    });

    it('a new queue timeout applies to future acquires', async () => {
      const sem = new ContainerSemaphore(1, 60_000);
      await sem.acquire();

      sem.updateLimits({ queueTimeoutMs: 1_000 });
      const queued = sem.acquire();
      const rejection = expect(queued).rejects.toBeInstanceOf(ContainerLimitError);

      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
    });
  });

});

// ── ContainerManager concurrency integration tests ───────────

function createMockContainer(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? 'sha256-abc123',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({
      State: { Status: 'exited', ExitCode: 0 },
    }),
    putArchive: vi.fn().mockResolvedValue(undefined),
    getArchive: vi.fn().mockResolvedValue(
      (async function* () {
        yield Buffer.from('fake-tar-data');
      })(),
    ),
    logs: vi.fn().mockResolvedValue(Buffer.from('line1\nline2\nline3')),
    pause: vi.fn().mockResolvedValue(undefined),
    unpause: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockNetwork() {
  return {
    inspect: vi.fn().mockResolvedValue({ Name: 'stablehand-agents' }),
  };
}

function createMockDocker(overrides: Record<string, unknown> = {}) {
  const mockContainer = createMockContainer();

  return {
    createContainer: vi.fn().mockResolvedValue(mockContainer),
    getContainer: vi.fn().mockReturnValue(mockContainer),
    listContainers: vi.fn().mockResolvedValue([]),
    getNetwork: vi.fn().mockReturnValue(createMockNetwork()),
    createNetwork: vi.fn().mockResolvedValue({}),
    _mockContainer: mockContainer,
    ...overrides,
  };
}

function defaultCreateOpts(sessionId = 'run-001'): CreateContainerOptions {
  return {
    sessionId,
    agentId: 'agent-abc',
    harnessName: 'claude-agents',
  };
}

describe('ContainerManager concurrency', () => {
  let docker: ReturnType<typeof createMockDocker>;

  beforeEach(() => {
    vi.useFakeTimers();
    docker = createMockDocker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('createContainer succeeds immediately when under limit', async () => {
    const manager = new ContainerManager(
      { maxGlobalContainers: 5, queueTimeoutMs: 60_000 },
      docker as any,
    );

    const info = await manager.createContainer(defaultCreateOpts());

    expect(info.status).toBe('created');
    expect(manager.getActiveCount()).toBe(1);
    expect(manager.getQueuedCount()).toBe(0);
  });

  it('createContainer queues when at the limit', async () => {
    const manager = new ContainerManager(
      { maxGlobalContainers: 2, queueTimeoutMs: 60_000 },
      docker as any,
    );

    await manager.createContainer(defaultCreateOpts('run-1'));
    await manager.createContainer(defaultCreateOpts('run-2'));

    // Third should queue
    const p3 = manager.createContainer(defaultCreateOpts('run-3'));
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.getActiveCount()).toBe(2);
    expect(manager.getQueuedCount()).toBe(1);

    // Remove a container to free a slot
    await manager.removeContainer('sha256-abc123');
    await p3;

    expect(manager.getActiveCount()).toBe(2);
    expect(manager.getQueuedCount()).toBe(0);
  });

  it('removeContainer releases a slot and wakes a queued request', async () => {
    const manager = new ContainerManager(
      { maxGlobalContainers: 1, queueTimeoutMs: 60_000 },
      docker as any,
    );

    await manager.createContainer(defaultCreateOpts('run-1'));
    expect(manager.getActiveCount()).toBe(1);

    const p2 = manager.createContainer(defaultCreateOpts('run-2'));
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.getQueuedCount()).toBe(1);

    await manager.removeContainer('sha256-abc123');
    await p2;

    expect(manager.getActiveCount()).toBe(1);
    expect(manager.getQueuedCount()).toBe(0);
  });

  it('throws ContainerLimitError on queue timeout', async () => {
    const manager = new ContainerManager(
      { maxGlobalContainers: 1, queueTimeoutMs: 5_000 },
      docker as any,
    );

    await manager.createContainer(defaultCreateOpts('run-1'));

    let caughtErr: unknown;
    const p2 = manager.createContainer(defaultCreateOpts('run-2')).catch((err) => { caughtErr = err; });
    await vi.advanceTimersByTimeAsync(5_001);
    await p2;

    expect(caughtErr).toBeInstanceOf(ContainerLimitError);
    expect((caughtErr as ContainerLimitError).message).toBe(
      'Maximum container limit (1) reached. Try again later.',
    );
  });

  it('tracks peak count across creates and removes', async () => {
    const manager = new ContainerManager(
      { maxGlobalContainers: 5, queueTimeoutMs: 60_000 },
      docker as any,
    );

    await manager.createContainer(defaultCreateOpts('run-1'));
    await manager.createContainer(defaultCreateOpts('run-2'));
    await manager.createContainer(defaultCreateOpts('run-3'));
    expect(manager.getPeakCount()).toBe(3);

    await manager.removeContainer('sha256-abc123');
    expect(manager.getPeakCount()).toBe(3); // peak should not decrease

    await manager.createContainer(defaultCreateOpts('run-4'));
    expect(manager.getPeakCount()).toBe(3); // still 3 active (2 + 1)
  });

  it('releases semaphore slot when Docker createContainer fails', async () => {
    const failingDocker = createMockDocker({
      createContainer: vi.fn().mockRejectedValue(new Error('Docker API error')),
    });

    const manager = new ContainerManager(
      { maxGlobalContainers: 2, queueTimeoutMs: 60_000 },
      failingDocker as any,
    );

    await expect(manager.createContainer(defaultCreateOpts())).rejects.toThrow('Docker API error');
    expect(manager.getActiveCount()).toBe(0);
  });

  it('removeContainer with 404 (already removed) still releases slot', async () => {
    const mockContainer = createMockContainer({
      remove: vi.fn().mockRejectedValue({ statusCode: 404, message: 'not found' }),
    });
    const docker404 = createMockDocker({
      getContainer: vi.fn().mockReturnValue(mockContainer),
    });

    const manager = new ContainerManager(
      { maxGlobalContainers: 5, queueTimeoutMs: 60_000 },
      docker404 as any,
    );

    await manager.createContainer(defaultCreateOpts());
    expect(manager.getActiveCount()).toBe(1);

    await manager.removeContainer('sha256-abc123');
    expect(manager.getActiveCount()).toBe(0);
  });

});
