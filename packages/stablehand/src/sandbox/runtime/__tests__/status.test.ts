import { describe, expect, it } from 'vitest';
import {
  isAliveContainerStatus,
  normalizeDockerContainerStatus,
  normalizeKubernetesPodStatus,
} from '../status.js';

describe('sandbox runtime status normalization', () => {
  it.each([
    ['created', 'created'],
    ['running', 'running'],
    ['paused', 'paused'],
    ['exited', 'stopped'],
    ['dead', 'stopped'],
    ['removing', 'removed'],
    ['unknown', 'stopped'],
    ['RUNNING', 'running'],
  ] as const)('maps Docker state %s to %s', (state, expectedStatus) => {
    expect(normalizeDockerContainerStatus(state)).toBe(expectedStatus);
  });

  it.each([
    [undefined, 'created'],
    [{ status: { phase: 'Pending' } }, 'created'],
    [{ status: { phase: 'Running' } }, 'running'],
    [{ status: { phase: 'Succeeded' } }, 'stopped'],
    [{ status: { phase: 'Failed' } }, 'stopped'],
    [{ status: { phase: 'Unknown' } }, 'created'],
    [{ metadata: { deletionTimestamp: '2026-07-08T15:00:00.000Z' }, status: { phase: 'Running' } }, 'removed'],
  ] as const)('maps Kubernetes pod state %# to %s', (pod, expectedStatus) => {
    expect(normalizeKubernetesPodStatus(pod)).toBe(expectedStatus);
  });

  it.each([
    ['created', true],
    ['running', true],
    ['paused', true],
    ['stopped', false],
    ['removed', false],
  ] as const)('classifies %s alive=%s', (status, expectedAlive) => {
    expect(isAliveContainerStatus(status)).toBe(expectedAlive);
  });
});
