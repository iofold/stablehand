import { promises as fs } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hasStatusCode, statusCodeError } from '../../../util/status-code-error.js';
import { KubernetesContainerDriver } from '../kubernetes-driver.js';

const runningPod = {
  metadata: { name: 'stablehand-sandbox-test-abc', labels: { 'stablehand.sandbox-session-id': 's1' } },
  status: { phase: 'Running', podIP: '10.42.0.99' },
};

const unschedulablePod = {
  metadata: { name: 'stablehand-sandbox-test-abc' },
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
  metadata: { name: 'stablehand-sandbox-test-abc' },
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

    const info = await driver.startContainer('stablehand-sandbox-test');
    expect(info.networkIp).toBe('10.42.0.99');
  });

  it('fails with 503 and the scheduler message when the capacity budget expires', async () => {
    const driver = createDriver({ podReadyTimeoutMs: 1_000, queueTimeoutMs: 60 });
    stubFindPod(driver, [unschedulablePod]);

    const failure = await driver.startContainer('stablehand-sandbox-test').catch((err: unknown) => err);
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

    const info = await driver.startContainer('stablehand-sandbox-test');
    expect(info.networkIp).toBe('10.42.0.99');
  });

  it('keeps the legacy timeout for pods that are scheduled but never become ready', async () => {
    const driver = createDriver({ podReadyTimeoutMs: 40, queueTimeoutMs: 2_000 });
    stubFindPod(driver, [scheduledPendingPod]);

    const failure = await driver.startContainer('stablehand-sandbox-test').catch((err: unknown) => err);
    expect((failure as Error).message).toMatch(/Timed out waiting for sandbox pod/);
    expect(hasStatusCode(failure, 503)).toBe(false);
  });

  it('fails immediately when the pod exits before becoming ready', async () => {
    const driver = createDriver();
    stubFindPod(driver, [{ metadata: { name: 'p' }, status: { phase: 'Failed' } }]);

    await expect(driver.startContainer('stablehand-sandbox-test')).rejects.toThrow(/exited before becoming ready/);
  });

  it('does not finish Job removal until Kubernetes reports the Job absent', async () => {
    const driver = createDriver();
    const requests: Array<{ method: string; path: string }> = [];
    let jobReads = 0;
    (driver as unknown as {
      requestJson: (method: string, path: string, body?: unknown) => Promise<unknown>;
    }).requestJson = vi.fn(async (method: string, path: string) => {
      requests.push({ method, path });
      if (method === 'DELETE') {
        return {};
      }
      jobReads += 1;
      if (jobReads < 3) {
        return { metadata: { deletionTimestamp: '2026-07-28T00:00:00Z' } };
      }
      throw statusCodeError(404, 'Job not found');
    });

    await driver.removeContainer('stablehand-sandbox-test');

    expect(requests).toEqual([
      {
        method: 'DELETE',
        path: '/apis/batch/v1/namespaces/test/jobs/stablehand-sandbox-test?propagationPolicy=Foreground',
      },
      {
        method: 'GET',
        path: '/apis/batch/v1/namespaces/test/jobs/stablehand-sandbox-test',
      },
      {
        method: 'GET',
        path: '/apis/batch/v1/namespaces/test/jobs/stablehand-sandbox-test',
      },
      {
        method: 'GET',
        path: '/apis/batch/v1/namespaces/test/jobs/stablehand-sandbox-test',
      },
    ]);
  });

  it('creates a Job-owned Secret without placing credential values in the Job', async () => {
    const driver = createDriver();
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    (driver as unknown as {
      requestJson: (method: string, path: string, body?: unknown) => Promise<unknown>;
    }).requestJson = vi.fn(async (method: string, path: string, body?: unknown) => {
      requests.push({ method, path, body });
      return path.endsWith('/jobs')
        ? { metadata: { uid: 'job-uid-1' } }
        : {};
    });

    await driver.createContainer({
      sessionId: 'session-1',
      agentId: 'agent-1',
      harnessName: 'langgraph',
      secrets: { OPENAI_API_KEY: 'credential-value' },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.path).toBe('/apis/batch/v1/namespaces/test/jobs');
    expect(JSON.stringify(requests[0]?.body)).not.toContain('credential-value');
    expect(requests[1]).toMatchObject({
      method: 'POST',
      path: '/api/v1/namespaces/test/secrets',
      body: {
        metadata: {
          name: 'stablehand-sandbox-session-1-env',
          ownerReferences: [{
            apiVersion: 'batch/v1',
            kind: 'Job',
            name: 'stablehand-sandbox-session-1',
            uid: 'job-uid-1',
          }],
        },
        stringData: { OPENAI_API_KEY: 'credential-value' },
      },
    });
  });

  it('reads the exact runtime instance token from the sandbox Secret', async () => {
    const driver = createDriver();
    const requestJson = vi.fn().mockResolvedValue({
      data: {
        STABLEHAND_RUNTIME_INSTANCE_TOKEN: Buffer.from('runtime-token-1').toString('base64'),
      },
    });
    (driver as unknown as { requestJson: typeof requestJson }).requestJson = requestJson;

    await expect(
      driver.getRuntimeInstanceToken('stablehand-sandbox-test'),
    ).resolves.toBe('runtime-token-1');
    expect(requestJson).toHaveBeenCalledWith(
      'GET',
      '/api/v1/namespaces/test/secrets/stablehand-sandbox-test-env',
    );
  });
});
