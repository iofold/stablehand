import { describe, expect, it } from 'vitest';

import { ContainerAccounting } from '../container-accounting.js';

describe('ContainerAccounting (ctx-wbt)', () => {
  it('tracks created containers and frees slots on release', async () => {
    const accounting = new ContainerAccounting(2, 1_000);

    await accounting.acquireSlot();
    accounting.registerCreated('c-1', 'langgraph');
    expect(accounting.getActive()).toBe(1);
    expect(accounting.isTracked('c-1')).toBe(true);

    expect(accounting.releaseFor('c-1')).toBe(true);
    expect(accounting.getActive()).toBe(0);
    expect(accounting.isTracked('c-1')).toBe(false);
  });

  it('does not release slots for untracked containers', () => {
    const accounting = new ContainerAccounting(2, 1_000);
    expect(accounting.releaseFor('unknown')).toBe(false);
    expect(accounting.getActive()).toBe(0);
  });

  it('returns a slot when creation fails before registration', async () => {
    const accounting = new ContainerAccounting(1, 1_000);
    await accounting.acquireSlot();
    accounting.releaseUnregisteredSlot();
    expect(accounting.getActive()).toBe(0);
  });

  it('rehydrates externally discovered containers and frees their slots on release', async () => {
    const accounting = new ContainerAccounting(4, 1_000);

    const seeded = accounting.rehydrate([
      { containerId: 'boot-1', harnessName: 'langgraph', startedAtMs: Date.now() - 5_000 },
      { containerId: 'boot-2', harnessName: 'claude-agents' },
    ]);

    expect(seeded).toBe(2);
    expect(accounting.getActive()).toBe(2);
    expect(accounting.getMetrics().byHarness).toEqual({ langgraph: 1, 'claude-agents': 1 });
    // Rehydrated containers were not created by this process — releasing them
    // must still free a slot (membership-keyed, the ctx-wbt fix).
    expect(accounting.releaseFor('boot-1')).toBe(true);
    expect(accounting.getActive()).toBe(1);
  });

  it('is idempotent per containerId across rehydrate calls', () => {
    const accounting = new ContainerAccounting(4, 1_000);
    accounting.rehydrate([{ containerId: 'boot-1', harnessName: 'langgraph' }]);
    const seededAgain = accounting.rehydrate([
      { containerId: 'boot-1', harnessName: 'langgraph' },
      { containerId: 'boot-2', harnessName: 'langgraph' },
    ]);

    expect(seededAgain).toBe(1);
    expect(accounting.getActive()).toBe(2);
  });

  it('seeds past maxGlobalContainers at boot; new acquires queue until a slot frees', async () => {
    const accounting = new ContainerAccounting(1, 1_000);
    accounting.rehydrate([
      { containerId: 'boot-1', harnessName: 'langgraph' },
      { containerId: 'boot-2', harnessName: 'langgraph' },
    ]);
    expect(accounting.getActive()).toBe(2);

    let acquired = false;
    const pending = accounting.acquireSlot().then(() => { acquired = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    expect(acquired).toBe(false);
    expect(accounting.getQueued()).toBe(1);

    accounting.releaseFor('boot-1');
    await pending;
    expect(acquired).toBe(true);
  });

  it('reports metrics equivalent to the old per-manager bookkeeping', async () => {
    const accounting = new ContainerAccounting(8, 1_000);
    await accounting.acquireSlot();
    accounting.registerCreated('c-1', 'langgraph');
    await accounting.acquireSlot();
    accounting.registerCreated('c-2', 'pi-agent');
    accounting.releaseFor('c-1');

    const metrics = accounting.getMetrics();
    expect(metrics).toEqual(expect.objectContaining({
      active: 1,
      queued: 0,
      peak: 2,
      totalCreated: 2,
      byHarness: { 'pi-agent': 1 },
      maxGlobalContainers: 8,
    }));
    expect(metrics.averageLifetimeMs).toBeGreaterThanOrEqual(0);
  });
});
