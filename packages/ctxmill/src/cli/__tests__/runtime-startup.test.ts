import { describe, expect, it, vi } from 'vitest';

import { startRuntimeApi } from '../runtime-startup.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('runtime API startup barrier', () => {
  it('awaits recovery and scheduler activation before listen/onReady', async () => {
    const order: string[] = [];
    const accounting = deferred();
    const lifecycle = deferred();
    const turns = deferred();
    const schedules = deferred();
    const listen = vi.fn(async () => {
      order.push('listen');
      return 'http://127.0.0.1:3001';
    });

    const startup = startRuntimeApi({
      server: { listen },
      runtime: {
        containerManager: {
          rehydrateAccounting: vi.fn(async () => {
            order.push('accounting');
            await accounting.promise;
            return 1;
          }),
        },
        lifecyclePolicy: {
          start: vi.fn(async () => {
            order.push('lifecycle');
            await lifecycle.promise;
          }),
        },
        reconcileStrandedTurns: vi.fn(async (bootTimeMs: number) => {
          expect(bootTimeMs).toBe(12_345);
          order.push('turns');
          await turns.promise;
          return { failed: 0, redispatched: 0, skippedHitlParked: 0 };
        }),
        scheduleService: {
          start: vi.fn(async () => {
            order.push('schedules');
            await schedules.promise;
          }),
        },
      },
      listen: { port: 3001, host: '0.0.0.0' },
      bootTimeMs: 12_345,
    });

    await vi.waitFor(() => expect(order).toEqual(['accounting']));
    expect(listen).not.toHaveBeenCalled();
    accounting.resolve();
    await vi.waitFor(() => expect(order).toEqual(['accounting', 'lifecycle']));
    expect(listen).not.toHaveBeenCalled();
    lifecycle.resolve();
    await vi.waitFor(() => expect(order).toEqual([
      'accounting',
      'lifecycle',
      'turns',
    ]));
    expect(listen).not.toHaveBeenCalled();
    turns.resolve();

    await vi.waitFor(() => expect(order).toEqual([
      'accounting',
      'lifecycle',
      'turns',
      'schedules',
    ]));
    expect(listen).not.toHaveBeenCalled();
    schedules.resolve();

    await expect(startup).resolves.toBe('http://127.0.0.1:3001');
    expect(order).toEqual([
      'accounting',
      'lifecycle',
      'turns',
      'schedules',
      'listen',
    ]);
    expect(listen).toHaveBeenCalledWith({ port: 3001, host: '0.0.0.0' });
  });

  it('fails closed without listening when runtime recovery fails', async () => {
    const listen = vi.fn();

    await expect(startRuntimeApi({
      server: { listen },
      runtime: {
        containerManager: {
          rehydrateAccounting: vi.fn().mockResolvedValue(0),
        },
        lifecyclePolicy: {
          start: vi.fn().mockResolvedValue(undefined),
        },
        reconcileStrandedTurns: vi.fn().mockRejectedValue(
          new Error('database unavailable'),
        ),
        scheduleService: {
          start: vi.fn().mockResolvedValue(undefined),
        },
      },
      listen: { port: 3001, host: '0.0.0.0' },
      bootTimeMs: 12_345,
    })).rejects.toThrow(
      'Stranded-turn startup reconciliation failed: database unavailable',
    );
    expect(listen).not.toHaveBeenCalled();
  });

  it('fails closed without listening when schedule activation fails', async () => {
    const listen = vi.fn();

    await expect(startRuntimeApi({
      server: { listen },
      runtime: {
        containerManager: {
          rehydrateAccounting: vi.fn().mockResolvedValue(0),
        },
        lifecyclePolicy: {
          start: vi.fn().mockResolvedValue(undefined),
        },
        reconcileStrandedTurns: vi.fn().mockResolvedValue({
          failed: 0,
          redispatched: 0,
          skippedHitlParked: 0,
        }),
        scheduleService: {
          start: vi.fn().mockRejectedValue(new Error('invalid persisted cron')),
        },
      },
      listen: { port: 3001, host: '0.0.0.0' },
      bootTimeMs: 12_345,
    })).rejects.toThrow(
      'Schedule service startup failed: invalid persisted cron',
    );
    expect(listen).not.toHaveBeenCalled();
  });
});
