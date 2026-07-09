import Dockerode from 'dockerode';
import { ContainerLimitError, ContainerSemaphore } from './container-semaphore.js';
import { SandboxContainerCore } from './runtime/core.js';
import { DockerContainerDriver } from './runtime/docker-driver.js';
import type { ContainerManagerOptions } from './runtime/types.js';

export type {
  ContainerInfo,
  ContainerManagerOptions,
  ContainerMetrics,
  CreateContainerOptions,
  ManagedContainerWithLabels,
  SandboxContainerManager,
  WorkspaceDiffSnapshot,
} from './runtime/types.js';

export {
  buildSandboxOtelEnv,
  DEFAULT_CONTAINER_STARTUP_GRACE_MS,
  resolveContainerStartupGraceMs,
  STARTUP_GRACE_MS_LABEL,
} from './runtime/spec.js';

export { ContainerLimitError, ContainerSemaphore };

export class ContainerManager extends SandboxContainerCore {
  constructor(options?: ContainerManagerOptions, dockerInstance?: Dockerode) {
    super({
      driver: new DockerContainerDriver(options, dockerInstance),
      maxGlobalContainers: options?.maxGlobalContainers ?? 20,
      queueTimeoutMs: options?.queueTimeoutMs ?? 60_000,
      loggerTag: '[ContainerManager]',
    });
  }
}
