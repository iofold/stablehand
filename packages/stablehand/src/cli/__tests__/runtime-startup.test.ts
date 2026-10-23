import { describe, expect, it, vi } from 'vitest';

import { startRuntimeApi } from '../runtime-startup.js';
import { StartupTimeline } from '../../util/startup-timeline.js';

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

  it('records each recovery stage on the startup timeline, listen last', async () => {
    let clock = 0;
    const timeline = new StartupTimeline(() => clock);
    const step = (ms: number) => {
      clock += ms;
    };

    await startRuntimeApi({
      server: {
        listen: vi.fn(async () => {
          step(5);
          return 'http://127.0.0.1:3001';
        }),
      },
      runtime: {
        containerManager: {
          rehydrateAccounting: vi.fn(async () => {
            step(1);
            return 0;
          }),
        },
        lifecyclePolicy: {
          start: vi.fn(async () => {
            step(20);
          }),
        },
        reconcileStrandedTurns: vi.fn(async () => {
          step(3);
          return { failed: 0, redispatched: 0, skippedHitlParked: 0, adopting: 2 };
        }),
        scheduleService: {
          start: vi.fn(async () => {
            step(4);
          }),
        },
      },
      listen: { port: 3001, host: '0.0.0.0' },
      timeline,
    });

    expect(timeline.list()).toEqual([
      { phase: 'slot-accounting', durationMs: 1 },
      { phase: 'sandbox-reconciliation', durationMs: 20 },
      { phase: 'turn-reconciliation', durationMs: 3, detail: 'taking over 2 running turn(s)' },
      { phase: 'schedules', durationMs: 4 },
      { phase: 'listen', durationMs: 5 },
    ]);
    expect(timeline.summary()).toBe(
      '[startup] ready 33 ms after process start: slot-accounting 1 ms, '
      + 'sandbox-reconciliation 20 ms, turn-reconciliation 3 ms (taking over 2 running turn(s)), '
      + 'schedules 4 ms, listen 5 ms',
    );
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
