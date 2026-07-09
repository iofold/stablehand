import { ContainerAccounting, type ContainerAccountingEntry } from '../container-accounting.js';
import { isAliveContainerStatus } from './status.js';
import type {
  ContainerInfo,
  ContainerMetrics,
  CreateContainerOptions,
  ManagedContainerWithLabels,
  SandboxContainerManager,
  WorkspaceDiffSnapshot,
} from './types.js';

export interface SandboxRuntimeDriver {
  ensureNetwork(): Promise<void>;
  createContainer(opts: CreateContainerOptions): Promise<ContainerInfo>;
  startContainer(containerId: string): Promise<ContainerInfo | undefined>;
  stopContainer(containerId: string, timeoutSec?: number): Promise<void>;
  removeContainer(containerId: string, force?: boolean): Promise<void>;
  extractWorkspaceDiff(containerId: string): Promise<WorkspaceDiffSnapshot | null>;
  restoreArchive(containerId: string, archive: Buffer, options?: { deletedPaths?: string[] }): Promise<void>;
  extractLogs(containerId: string, tail?: number): Promise<string>;
  getContainer(sessionId: string): Promise<ContainerInfo | null>;
  listManagedContainers(): Promise<ContainerInfo[]>;
  listManagedContainersWithLabels(): Promise<ManagedContainerWithLabels[]>;
  getContainerExitCode(containerId: string): Promise<number | null>;
  isContainerAlive(containerId: string): Promise<boolean>;
}

export interface SandboxContainerCoreOptions {
  driver: SandboxRuntimeDriver;
  maxGlobalContainers: number;
  queueTimeoutMs: number;
  loggerTag: string;
}

export class SandboxContainerCore implements SandboxContainerManager {
  private readonly accounting: ContainerAccounting;

  constructor(private readonly options: SandboxContainerCoreOptions) {
    this.accounting = new ContainerAccounting(options.maxGlobalContainers, options.queueTimeoutMs);
  }

  async createContainer(opts: CreateContainerOptions): Promise<ContainerInfo> {
    await this.accounting.acquireSlot();
    let containerCreated = false;

    try {
      const info = await this.options.driver.createContainer(opts);
      this.accounting.registerCreated(info.containerId, opts.harnessName);
      containerCreated = true;
      return info;
    } finally {
      if (!containerCreated) {
        this.accounting.releaseUnregisteredSlot();
      }
    }
  }

  async rehydrateAccounting(): Promise<number> {
    const containers = await this.options.driver.listManagedContainersWithLabels();
    const entries: ContainerAccountingEntry[] = containers
      .filter((container) => isAliveContainerStatus(container.status))
      .map((container) => ({
        containerId: container.containerId,
        harnessName: container.harnessName || container.labels['ctxmill.harness'] || 'unknown',
        startedAtMs: container.startedAt?.getTime(),
      }));
    const seeded = this.accounting.rehydrate(entries);
    if (seeded > 0) {
      console.info(`${this.options.loggerTag} rehydrated slot accounting for ${seeded} live container(s)`);
    }
    return seeded;
  }

  releaseContainerSlot(containerId: string): boolean {
    return this.accounting.releaseFor(containerId);
  }

  async startContainer(containerId: string): Promise<ContainerInfo | undefined> {
    return this.options.driver.startContainer(containerId);
  }

  async stopContainer(containerId: string, timeoutSec?: number): Promise<void> {
    await this.options.driver.stopContainer(containerId, timeoutSec);
    this.releaseOwnedContainerSlot(containerId);
  }

  async removeContainer(containerId: string, force?: boolean): Promise<void> {
    await this.options.driver.removeContainer(containerId, force);
    this.releaseOwnedContainerSlot(containerId);
  }

  async extractWorkspaceDiff(containerId: string): Promise<WorkspaceDiffSnapshot | null> {
    return this.options.driver.extractWorkspaceDiff(containerId);
  }

  async restoreArchive(
    containerId: string,
    archive: Buffer,
    options?: { deletedPaths?: string[] },
  ): Promise<void> {
    await this.options.driver.restoreArchive(containerId, archive, options);
  }

  async extractLogs(containerId: string, tail?: number): Promise<string> {
    return this.options.driver.extractLogs(containerId, tail);
  }

  async getContainer(sessionId: string): Promise<ContainerInfo | null> {
    return this.options.driver.getContainer(sessionId);
  }

  async listManagedContainers(): Promise<ContainerInfo[]> {
    return this.options.driver.listManagedContainers();
  }

  async listManagedContainersWithLabels(): Promise<ManagedContainerWithLabels[]> {
    return this.options.driver.listManagedContainersWithLabels();
  }

  async getContainerExitCode(containerId: string): Promise<number | null> {
    return this.options.driver.getContainerExitCode(containerId);
  }

  async isContainerAlive(containerId: string): Promise<boolean> {
    return this.options.driver.isContainerAlive(containerId);
  }

  async ensureNetwork(): Promise<void> {
    await this.options.driver.ensureNetwork();
  }

  getActiveCount(): number {
    return this.accounting.getActive();
  }

  getQueuedCount(): number {
    return this.accounting.getQueued();
  }

  getPeakCount(): number {
    return this.accounting.getPeak();
  }

  getMetrics(): ContainerMetrics {
    return this.accounting.getMetrics();
  }

  private releaseOwnedContainerSlot(containerId: string): void {
    if (!this.accounting.releaseFor(containerId)) {
      console.debug(`${this.options.loggerTag} container ${containerId} is not tracked by accounting; slot not released`);
    }
  }
}
