import { ContainerAccounting, type ContainerAccountingEntry } from '../container-accounting.js';
import {
  performanceInstrumentation,
  type PerformanceRecorder,
} from '../../observability/performance.js';
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
  /** Apply new per-sandbox resource defaults at runtime (live settings, ctx-reir). */
  updateDefaults?(update: SandboxRuntimeSettingsUpdate): void;
  createContainer(opts: CreateContainerOptions): Promise<ContainerInfo>;
  startContainer(containerId: string): Promise<ContainerInfo | undefined>;
  stopContainer(containerId: string, timeoutSec?: number): Promise<void>;
  removeContainer(containerId: string, force?: boolean): Promise<void>;
  extractWorkspaceDiff(containerId: string): Promise<WorkspaceDiffSnapshot | null>;
  restoreArchive(containerId: string, archive: Buffer, options?: { deletedPaths?: string[] }): Promise<void>;
  extractLogs(containerId: string, tail?: number): Promise<string>;
  getContainer(sessionId: string): Promise<ContainerInfo | null>;
  getRuntimeInstanceToken(containerId: string): Promise<string | undefined>;
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
  runtime: 'docker' | 'kubernetes';
  performance?: PerformanceRecorder;
}

/** Container-manager-relevant subset of runtime settings (live updates, ctx-reir). */
export interface SandboxRuntimeSettingsUpdate {
  maxGlobalContainers?: number;
  queueTimeoutMs?: number;
  defaultCpus?: number;
  defaultMemoryMb?: number;
  defaultPidsLimit?: number;
  defaultTimeoutSec?: number;
}

export class SandboxContainerCore implements SandboxContainerManager {
  private readonly accounting: ContainerAccounting;
  private readonly performance: PerformanceRecorder;

  constructor(private readonly options: SandboxContainerCoreOptions) {
    this.accounting = new ContainerAccounting(options.maxGlobalContainers, options.queueTimeoutMs);
    this.performance = options.performance ?? performanceInstrumentation;
  }

  /**
   * Apply new settings to the running manager (ctx-reir): slot limits and
   * queue timeout take effect immediately, resource defaults on the next
   * container creation.
   */
  applySettings(update: SandboxRuntimeSettingsUpdate): void {
    this.accounting.updateLimits({
      maxGlobalContainers: update.maxGlobalContainers,
      queueTimeoutMs: update.queueTimeoutMs,
    });
    this.options.driver.updateDefaults?.(update);
  }

  async createContainer(opts: CreateContainerOptions): Promise<ContainerInfo> {
    const attributes = {
      'stablehand.runtime': this.options.runtime,
      'stablehand.harness': opts.harnessName,
      'stablehand.session.id': opts.sessionId,
      'stablehand.agent.id': opts.agentId,
      'stablehand.conversation.id': opts.conversationId,
    };
    const queueMeasurement = this.performance.start('sandbox.queue', attributes);
    try {
      await this.accounting.acquireSlot();
      queueMeasurement.end('ok');
    } catch (error) {
      queueMeasurement.end('error', error);
      throw error;
    }
    let containerCreated = false;

    try {
      const info = await this.performance.measure(
        'sandbox.create',
        attributes,
        () => this.options.driver.createContainer(opts),
      );
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
        harnessName: container.harnessName || container.labels['stablehand.harness'] || 'unknown',
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

  async getRuntimeInstanceToken(
    containerId: string,
  ): Promise<string | undefined> {
    return this.options.driver.getRuntimeInstanceToken(containerId);
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
