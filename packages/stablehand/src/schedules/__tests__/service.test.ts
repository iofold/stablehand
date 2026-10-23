import { describe, expect, it, vi } from 'vitest';

import { ScheduleService, countMissedWindows, type ScheduleJobFactory } from '../service.js';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'schedule-1',
    agentId: 'agent-1',
    name: 'weekly-canary',
    cronExpression: '* * * * * *',
    timezone: 'UTC',
    eventType: 'custom.schedule.weekly-canary',
    payload: { source: 'canary' },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    lastFiredAt: null,
    missedFireCount: 0,
    ...overrides,
  };
}

function harness(initial = [row()]) {
  const callbacks = new Map<string, () => void>();
  const stopped: string[] = [];
  const jobs = new Map<string, { stop: ReturnType<typeof vi.fn>; nextRun: ReturnType<typeof vi.fn> }>();
  const jobFactory: ScheduleJobFactory = (schedule, callback) => {
    callbacks.set(schedule.id, callback);
    const job = {
      stop: vi.fn(() => { stopped.push(schedule.id); }),
      nextRun: vi.fn(() => new Date(10_000)),
    };
    jobs.set(schedule.id, job);
    return job;
  };
  const repository = {
    listSchedules: vi.fn().mockResolvedValue(initial),
    getSchedule: vi.fn().mockImplementation(async (id: string) => (
      initial.find((schedule) => schedule.id === id)
    )),
    createSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    claimScheduleFire: vi.fn().mockResolvedValue({ claimed: true, previousLastFiredAt: null }),
    restoreScheduleFireClaim: vi.fn().mockResolvedValue(undefined),
    recordScheduleMissedFires: vi.fn().mockResolvedValue(undefined),
    recordScheduleManualFire: vi.fn().mockImplementation(async (id: string, nowMs: number) => {
      const current = initial.find((schedule) => schedule.id === id);
      return current ? { ...current, lastFiredAt: nowMs } : undefined;
    }),
  };
  const triggerManager = { emitCustomEventAsync: vi.fn().mockResolvedValue(undefined) };
  const service = new ScheduleService({
    repository: repository as never,
    triggerManager,
    jobFactory,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { callbacks, jobs, repository, service, stopped, triggerManager };
}

describe('ScheduleService', () => {
  it('rehydrates only enabled jobs and exposes their next run', async () => {
    const active = row();
    const disabled = row({ id: 'schedule-2', name: 'disabled', enabled: false });
    const { jobs, service } = harness([active, disabled]);

    await service.start();

    expect([...jobs.keys()]).toEqual(['schedule-1']);
    await expect(service.list()).resolves.toEqual([
      { ...active, nextRunAt: 10_000 },
      { ...disabled, nextRunAt: null },
    ]);
    await service.stop();
  });

  it('fails closed when a persisted schedule violates the custom-event contract', async () => {
    const invalidName = harness([row({ eventType: 'turn.completed' })]);
    await expect(invalidName.service.start()).rejects.toThrow();
    expect(invalidName.jobs.size).toBe(0);

    const oversized = harness([row({
      payload: { content: 'x'.repeat(257 * 1024) },
    })]);
    await expect(oversized.service.start()).rejects.toThrow();
    expect(oversized.jobs.size).toBe(0);
  });

  it('claims the fire window before emitting through the custom-event choke point', async () => {
    const { callbacks, repository, service, triggerManager } = harness();
    await service.start();

    callbacks.get('schedule-1')?.();
    await service.drain();

    expect(triggerManager.emitCustomEventAsync).toHaveBeenCalledWith(
      'custom.schedule.weekly-canary',
      'agent-1',
      { source: 'canary' },
    );
    // The claim is the cross-process dedupe boundary, so it must precede
    // the emission (ctx-hljx).
    expect(repository.claimScheduleFire).toHaveBeenCalledTimes(1);
    expect(repository.claimScheduleFire.mock.invocationCallOrder[0])
      .toBeLessThan(triggerManager.emitCustomEventAsync.mock.invocationCallOrder[0]!);
    expect(repository.restoreScheduleFireClaim).not.toHaveBeenCalled();
    await service.stop();
  });

  it('skips the emission entirely when another process already claimed the window', async () => {
    const { callbacks, repository, service, triggerManager } = harness();
    repository.claimScheduleFire.mockResolvedValue({ claimed: false });
    await service.start();

    callbacks.get('schedule-1')?.();
    await service.drain();

    expect(triggerManager.emitCustomEventAsync).not.toHaveBeenCalled();
    await service.stop();
  });

  it('emits a global scheduled event when no agent scope is configured', async () => {
    const global = row({ agentId: null });
    const { callbacks, service, triggerManager } = harness([global]);
    await service.start();

    callbacks.get('schedule-1')?.();
    await service.drain();

    expect(triggerManager.emitCustomEventAsync).toHaveBeenCalledWith(
      'custom.schedule.weekly-canary',
      undefined,
      { source: 'canary' },
    );
    await service.stop();
  });

  it('does not leave a failed emission recorded as fired', async () => {
    const { callbacks, repository, service, triggerManager } = harness();
    repository.claimScheduleFire.mockResolvedValue({
      claimed: true,
      previousLastFiredAt: 777,
    });
    triggerManager.emitCustomEventAsync.mockRejectedValueOnce(new Error('persist failed'));
    await service.start();

    callbacks.get('schedule-1')?.();
    await service.drain();

    expect(repository.restoreScheduleFireClaim).toHaveBeenCalledWith(
      'schedule-1',
      expect.any(Number),
      777,
    );
    await service.stop();
  });

  it('records missed windows on boot without backfilling them', async () => {
    // Every-minute cron whose last fire was ~3.5 minutes ago: at least two
    // whole windows in between provably never fired.
    const stale = row({ lastFiredAt: Date.now() - 210_000 });
    const { repository, service, triggerManager } = harness([stale]);
    await service.start();

    expect(repository.recordScheduleMissedFires).toHaveBeenCalledWith(
      'schedule-1',
      expect.any(Number),
      expect.any(Number),
    );
    const [, missed] = repository.recordScheduleMissedFires.mock.calls[0]!;
    expect(missed).toBeGreaterThanOrEqual(2);
    expect(triggerManager.emitCustomEventAsync).toHaveBeenCalledWith(
      'custom.schedule.missed_fires',
      'agent-1',
      expect.objectContaining({
        scheduleId: 'schedule-1',
        scheduleName: 'weekly-canary',
        missedFires: missed,
      }),
    );
    await service.stop();
  });

  it('counts missed windows deterministically and strictly inside the gap', () => {
    const schedule = { cronExpression: '* * * * *', timezone: 'UTC' };
    const from = Date.UTC(2026, 7, 14, 10, 0, 30);
    // 10:01, 10:02, 10:03 are inside; the 10:03:30 boundary slot is upcoming.
    expect(countMissedWindows(schedule, from, Date.UTC(2026, 7, 14, 10, 3, 30))).toBe(3);
    // Nothing missed inside a sub-minute gap.
    expect(countMissedWindows(schedule, from, Date.UTC(2026, 7, 14, 10, 0, 55))).toBe(0);
    // A slot exactly at the boundary is upcoming, not missed.
    expect(countMissedWindows(schedule, Date.UTC(2026, 7, 14, 10, 0, 0), Date.UTC(2026, 7, 14, 10, 1, 0))).toBe(0);
  });

  it('stops a replaced generation and ignores its already-queued callback', async () => {
    const { callbacks, repository, service, stopped, triggerManager } = harness();
    await service.start();
    const staleCallback = callbacks.get('schedule-1')!;
    const updated = row({ cronExpression: '*/2 * * * * *', updatedAt: 2 });
    repository.getSchedule.mockResolvedValue(updated);

    await service.reconcile('schedule-1');
    staleCallback();
    await service.drain();

    expect(stopped).toEqual(['schedule-1']);
    expect(triggerManager.emitCustomEventAsync).not.toHaveBeenCalled();
    await service.stop();
  });

  it('serializes direct reconciliations so a delayed older projection cannot win', async () => {
    const { callbacks, repository, service, stopped, triggerManager } = harness();
    await service.start();
    const stale = row({
      cronExpression: '*/2 * * * * *',
      eventType: 'custom.schedule.stale',
      updatedAt: 2,
    });
    const latest = row({
      cronExpression: '*/3 * * * * *',
      eventType: 'custom.schedule.latest',
      updatedAt: 3,
    });
    let resolveFirst!: (value: ReturnType<typeof row>) => void;
    repository.getSchedule
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(latest);

    const first = service.reconcile('schedule-1');
    const second = service.reconcile('schedule-1');
    await vi.waitFor(() => expect(repository.getSchedule).toHaveBeenCalledOnce());
    resolveFirst(stale);
    await Promise.all([first, second]);

    expect(stopped).toEqual(['schedule-1', 'schedule-1']);
    callbacks.get('schedule-1')?.();
    await service.drain();
    expect(triggerManager.emitCustomEventAsync).toHaveBeenCalledWith(
      'custom.schedule.latest',
      'agent-1',
      { source: 'canary' },
    );
    await service.stop();
  });

  it('keeps the latest patch installed when an earlier reconciliation returns late', async () => {
    const current = row();
    const firstPatch = row({
      eventType: 'custom.schedule.first-patch',
      payload: { revision: 1 },
      updatedAt: 2,
    });
    const secondPatch = row({
      eventType: 'custom.schedule.second-patch',
      payload: { revision: 2 },
      updatedAt: 3,
    });
    const { callbacks, repository, service, triggerManager } = harness([current]);
    let resolveFirstReconcile!: (value: ReturnType<typeof row>) => void;
    repository.getSchedule
      .mockResolvedValueOnce(current)
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirstReconcile = resolve; }))
      .mockResolvedValueOnce(firstPatch)
      .mockResolvedValueOnce(secondPatch);
    repository.updateSchedule
      .mockResolvedValueOnce(firstPatch)
      .mockResolvedValueOnce(secondPatch);
    await service.start();

    const first = service.update('schedule-1', {
      eventType: firstPatch.eventType,
      payload: firstPatch.payload,
    });
    await vi.waitFor(() => expect(repository.updateSchedule).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(repository.getSchedule).toHaveBeenCalledTimes(2));
    const second = service.update('schedule-1', {
      eventType: secondPatch.eventType,
      payload: secondPatch.payload,
    });
    await Promise.resolve();
    resolveFirstReconcile(firstPatch);
    await Promise.all([first, second]);

    callbacks.get('schedule-1')?.();
    await service.drain();
    expect(triggerManager.emitCustomEventAsync).toHaveBeenLastCalledWith(
      'custom.schedule.second-patch',
      'agent-1',
      { revision: 2 },
    );
    await service.stop();
  });

  it('does not reinstall a timer when patch reconciliation races deletion', async () => {
    const current = row();
    const patched = row({ payload: { revision: 2 }, updatedAt: 2 });
    const { callbacks, repository, service, triggerManager } = harness([current]);
    let resolvePatchReconcile!: (value: ReturnType<typeof row>) => void;
    repository.getSchedule
      .mockResolvedValueOnce(current)
      .mockReturnValueOnce(new Promise((resolve) => { resolvePatchReconcile = resolve; }))
      .mockResolvedValueOnce(undefined);
    repository.updateSchedule.mockResolvedValueOnce(patched);
    repository.deleteSchedule.mockResolvedValueOnce(true);
    await service.start();

    const updating = service.update('schedule-1', { payload: patched.payload });
    await vi.waitFor(() => expect(repository.updateSchedule).toHaveBeenCalledOnce());
    const deleting = service.delete('schedule-1');
    await Promise.resolve();
    resolvePatchReconcile(patched);
    await Promise.all([updating, deleting]);

    callbacks.get('schedule-1')?.();
    await service.drain();
    expect(triggerManager.emitCustomEventAsync).not.toHaveBeenCalled();
    await service.stop();
  });

  it('retires one agent\'s timers and drains its active fire without stopping other agents', async () => {
    const other = row({ id: 'schedule-2', agentId: 'agent-2', name: 'other-agent' });
    const { callbacks, service, stopped, triggerManager } = harness([row(), other]);
    let release!: () => void;
    triggerManager.emitCustomEventAsync.mockReturnValueOnce(
      new Promise<void>((resolve) => { release = resolve; }),
    );
    await service.start();
    const retiredCallback = callbacks.get('schedule-1')!;
    retiredCallback();

    let settled = false;
    const retiring = service.stopForAgent('agent-1').then(() => { settled = true; });
    await Promise.resolve();
    expect(stopped).toEqual(['schedule-1']);
    expect(settled).toBe(false);
    release();
    await retiring;

    retiredCallback();
    callbacks.get('schedule-2')?.();
    await service.drain();
    expect(triggerManager.emitCustomEventAsync).toHaveBeenCalledTimes(2);
    expect(triggerManager.emitCustomEventAsync).toHaveBeenLastCalledWith(
      'custom.schedule.weekly-canary',
      'agent-2',
      { source: 'canary' },
    );
    await service.stop();
    expect(stopped).toEqual(['schedule-1', 'schedule-2']);
  });

  it('drains the previous generation before a patch installs its replacement', async () => {
    const current = row();
    const patched = row({
      eventType: 'custom.schedule.patched',
      payload: { revision: 2 },
      updatedAt: 2,
    });
    const { callbacks, repository, service, triggerManager } = harness([current]);
    let release!: () => void;
    triggerManager.emitCustomEventAsync.mockReturnValueOnce(
      new Promise<void>((resolve) => { release = resolve; }),
    );
    repository.getSchedule
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce({ ...patched, lastFiredAt: 1_234 });
    repository.updateSchedule.mockResolvedValueOnce(patched);
    await service.start();
    callbacks.get('schedule-1')?.();

    let settled = false;
    const updating = service.update('schedule-1', { payload: patched.payload })
      .then((value) => { settled = true; return value; });
    await vi.waitFor(() => expect(repository.updateSchedule).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(updating).resolves.toMatchObject({ lastFiredAt: 1_234 });

    callbacks.get('schedule-1')?.();
    await service.drain();
    expect(triggerManager.emitCustomEventAsync).toHaveBeenLastCalledWith(
      'custom.schedule.patched',
      'agent-1',
      { revision: 2 },
    );
    await service.stop();
  });

  it('drains an already-started fire before schedule deletion completes', async () => {
    const { callbacks, repository, service, triggerManager } = harness();
    let release!: () => void;
    triggerManager.emitCustomEventAsync.mockReturnValueOnce(
      new Promise<void>((resolve) => { release = resolve; }),
    );
    repository.deleteSchedule.mockResolvedValueOnce(true);
    repository.getSchedule.mockResolvedValueOnce(undefined);
    await service.start();
    const staleCallback = callbacks.get('schedule-1')!;
    staleCallback();

    let settled = false;
    const deleting = service.delete('schedule-1').then((value) => {
      settled = true;
      return value;
    });
    await vi.waitFor(() => expect(repository.deleteSchedule).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(deleting).resolves.toBe(true);

    staleCallback();
    await service.drain();
    expect(triggerManager.emitCustomEventAsync).toHaveBeenCalledOnce();
    await service.stop();
  });

  it('stops all jobs and waits for an in-flight emission during shutdown', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const { callbacks, service, stopped, triggerManager } = harness();
    triggerManager.emitCustomEventAsync.mockReturnValueOnce(pending);
    await service.start();
    callbacks.get('schedule-1')?.();

    const stopping = service.stop();
    await Promise.resolve();
    expect(stopped).toEqual(['schedule-1']);
    let settled = false;
    void stopping.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await stopping;
    expect(settled).toBe(true);
  });

  it('fires a schedule once on request, even while it is off, and records the fire', async () => {
    const off = row({ id: 'schedule-2', name: 'off', enabled: false });
    const { repository, service, triggerManager } = harness([row(), off]);
    await service.start();

    const fired = await service.fireNow('schedule-2');

    expect(triggerManager.emitCustomEventAsync).toHaveBeenCalledWith(
      'custom.schedule.weekly-canary',
      'agent-1',
      { source: 'canary' },
    );
    expect(repository.recordScheduleManualFire).toHaveBeenCalledWith('schedule-2', expect.any(Number));
    expect(repository.claimScheduleFire).not.toHaveBeenCalled();
    expect(fired).toMatchObject({ id: 'schedule-2', enabled: false, nextRunAt: null, lastFiredAt: expect.any(Number) });
    await expect(service.fireNow('missing')).resolves.toBeUndefined();
    await service.stop();
  });

  it('does not record a manual fire when the event cannot be emitted', async () => {
    const { repository, service, triggerManager } = harness();
    triggerManager.emitCustomEventAsync.mockRejectedValueOnce(new Error('spine down'));

    await expect(service.fireNow('schedule-1')).rejects.toThrow('spine down');
    expect(repository.recordScheduleManualFire).not.toHaveBeenCalled();
  });
});
