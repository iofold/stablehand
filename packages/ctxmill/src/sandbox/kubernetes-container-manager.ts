import { SandboxContainerCore } from './runtime/core.js';
import {
  KubernetesContainerDriver,
  type KubernetesContainerManagerOptions,
} from './runtime/kubernetes-driver.js';

export type { KubernetesContainerManagerOptions } from './runtime/kubernetes-driver.js';

export class KubernetesContainerManager extends SandboxContainerCore {
  constructor(options: KubernetesContainerManagerOptions = {}) {
    super({
      driver: new KubernetesContainerDriver(options),
      maxGlobalContainers: options.maxGlobalContainers ?? 20,
      queueTimeoutMs: options.queueTimeoutMs ?? 60_000,
      loggerTag: '[KubernetesContainerManager]',
    });
  }
}
