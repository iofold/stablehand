import { promises as fs } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hasStatusCode } from '../../../util/status-code-error.js';
import { KubernetesContainerDriver } from '../kubernetes-driver.js';

const runningPod = {
  metadata: { name: 'ctxmill-sandbox-test-abc', labels: { 'ctxmill.sandbox-session-id': 's1' } },
  status: { phase: 'Running', podIP: '10.42.0.99' },
};

const unschedulablePod = {
  metadata: { name: 'ctxmill-sandbox-test-abc' },
  status: {
    phase: 'Pending',
    conditions: [{
      type: 'PodScheduled',
      status: 'False',
      reason: 'Unschedulable',
      message: '0/1 nodes are available: 1 Insufficient cpu.',
    }],
  },
};

const scheduledPendingPod = {
  metadata: { name: 'ctxmill-sandbox-test-abc' },
  status: {
    phase: 'Pending',
    conditions: [{ type: 'PodScheduled', status: 'True' }],
  },
};

function createDriver(overrides: { podReadyTimeoutMs?: number; queueTimeoutMs?: number } = {}) {
  return new KubernetesContainerDriver({
    namespace: 'test',
    podReadyTimeoutMs: overrides.podReadyTimeoutMs ?? 40,
    queueTimeoutMs: overrides.queueTimeoutMs ?? 400,
    podPollIntervalMs: 5,
  });
}

function stubFindPod(driver: KubernetesContainerDriver, sequence: Array<unknown>): void {
  let call = 0;
  (driver as unknown as { findPod: (jobName: string) => Promise<unknown> }).findPod =
    async () => sequence[Math.min(call++, sequence.length - 1)] ?? null;
}

describe('KubernetesContainerDriver pod scheduling wait', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'readFile').mockResolvedValue('service-account-token' as never);
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('waits out an Unschedulable phase longer than the ready timeout, then returns the running pod', async () => {
    const driver = createDriver({ podReadyTimeoutMs: 40, queueTimeoutMs: 2_000 });
    // 20 unschedulable polls x 5ms = ~100ms of capacity wait, past the 40ms ready budget.
    stubFindPod(driver, [...Array.from({ length: 20 }, () => unschedulablePod), runningPod]);

    const info = await driver.startContainer('ctxmill-sandbox-test');
    expect(info.networkIp).toBe('10.42.0.99');
  });

  it('fails with 503 and the scheduler message when the capacity budget expires', async () => {
    const driver = createDriver({ podReadyTimeoutMs: 1_000, queueTimeoutMs: 60 });
    stubFindPod(driver, [unschedulablePod]);

    const failure = await driver.startContainer('ctxmill-sandbox-test').catch((err: unknown) => err);
    expect(hasStatusCode(failure, 503)).toBe(true);
    expect((failure as Error).message).toContain('Insufficient cpu');
  });

  it('restarts the ready budget once a previously unschedulable pod is scheduled', async () => {
    const driver = createDriver({ podReadyTimeoutMs: 60, queueTimeoutMs: 2_000 });
    // ~50ms unschedulable, then ~8 scheduled-pending polls (~40ms < 60ms ready budget), then running.
    stubFindPod(driver, [
      ...Array.from({ length: 10 }, () => unschedulablePod),
      ...Array.from({ length: 8 }, () => scheduledPendingPod),
      runningPod,
    ]);

    const info = await driver.startContainer('ctxmill-sandbox-test');
    expect(info.networkIp).toBe('10.42.0.99');
  });

  it('keeps the legacy timeout for pods that are scheduled but never become ready', async () => {
    const driver = createDriver({ podReadyTimeoutMs: 40, queueTimeoutMs: 2_000 });
    stubFindPod(driver, [scheduledPendingPod]);

    const failure = await driver.startContainer('ctxmill-sandbox-test').catch((err: unknown) => err);
    expect((failure as Error).message).toMatch(/Timed out waiting for sandbox pod/);
    expect(hasStatusCode(failure, 503)).toBe(false);
  });

  it('fails immediately when the pod exits before becoming ready', async () => {
    const driver = createDriver();
    stubFindPod(driver, [{ metadata: { name: 'p' }, status: { phase: 'Failed' } }]);

    await expect(driver.startContainer('ctxmill-sandbox-test')).rejects.toThrow(/exited before becoming ready/);
  });
});
