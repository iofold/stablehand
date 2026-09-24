import type { ContainerInfo } from '../container-manager.js';

export type ContainerStatus = ContainerInfo['status'];

export interface KubernetesPodStatusInput {
  metadata?: {
    deletionTimestamp?: string;
  };
  status?: {
    phase?: string;
  };
}

export function normalizeDockerContainerStatus(state: string): ContainerStatus {
  switch (state.toLowerCase()) {
    case 'created':
      return 'created';
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'exited':
    case 'dead':
      return 'stopped';
    case 'removing':
      return 'removed';
    default:
      return 'stopped';
  }
}

export function normalizeKubernetesPodStatus(pod: KubernetesPodStatusInput | undefined): ContainerStatus {
  if (!pod) return 'created';
  if (pod.metadata?.deletionTimestamp) return 'removed';

  switch ((pod.status?.phase ?? '').toLowerCase()) {
    case 'pending':
      return 'created';
    case 'running':
      return 'running';
    case 'succeeded':
    case 'failed':
      return 'stopped';
    default:
      return 'created';
  }
}

export function isAliveContainerStatus(status: ContainerStatus): boolean {
  return status === 'created' || status === 'running' || status === 'paused';
}
