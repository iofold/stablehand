export interface ContainerManagerOptions {
  /** Explicit logical owner for runtime isolation. Defaults to deployment environment identity. */
  scopeIdentity?: string;
  /** Docker bridge network name for agent containers. Default: 'ctxmill-agents' */
  networkName?: string;
  /** Image name prefix. Container image = `${imagePrefix}-${harnessName}:latest` */
  imagePrefix?: string;
  /** Default CPU allocation (fractional cores). Default: 1.0 */
  defaultCpus?: number;
  /** Default memory limit in MiB. Default: 1024 */
  defaultMemoryMb?: number;
  /** Default PID limit. Default: 256 */
  defaultPidsLimit?: number;
  /** Default run timeout in seconds. Default: 600 */
  defaultTimeoutSec?: number;
  /** Maximum number of concurrent containers. Default: 20; production resolves env via SystemSettingsService. */
  maxGlobalContainers?: number;
  /** Timeout in ms for queued container requests. Default: 60000 (60 seconds) */
  queueTimeoutMs?: number;
  /** Grace window in ms before orphan cleanup may reap a container still bootstrapping. Default: 90000 */
  startupGraceMs?: number;
}

export interface CreateContainerOptions {
  sessionId: string;
  conversationId?: string;
  agentId: string;
  harnessName: string;
  workspaceDir?: string;
  cpus?: number;
  memoryMb?: number;
  pidsLimit?: number;
  timeoutSec?: number;
  secrets?: Record<string, string>;
}

export interface ContainerInfo {
  containerId: string;
  containerName: string;
  sessionId: string;
  agentId: string;
  harnessName: string;
  status: 'created' | 'running' | 'paused' | 'stopped' | 'removed';
  startedAt?: Date;
  networkIp?: string;
}

export interface ManagedContainerWithLabels extends ContainerInfo {
  labels: Record<string, string>;
}

export interface ContainerMetrics {
  /** Currently running containers (from semaphore) */
  active: number;
  /** Waiting for a slot (from concurrency limiter) */
  queued: number;
  /** Highest concurrent count this session */
  peak: number;
  /** Lifetime counter of containers created */
  totalCreated: number;
  /** Active count per harness type */
  byHarness: Record<string, number>;
  /** Average running duration (ms) of completed containers */
  averageLifetimeMs: number;
  /** Maximum number of concurrent containers allowed */
  maxGlobalContainers: number;
}

export interface WorkspaceDiffSnapshot {
  archive: Buffer | null;
  deletedPaths: string[];
}

export interface SandboxContainerManager {
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
  ensureNetwork(): Promise<void>;
  /** Seed slot accounting from live containers at boot (ctx-wbt). */
  rehydrateAccounting?(): Promise<number>;
  /**
   * Release slot accounting for a tracked container without stopping it.
   * Used when startup reconciliation intentionally defers killing a proven
   * unowned container, so it does not starve new sandbox work during grace.
   */
  releaseContainerSlot?(containerId: string): boolean;
  /**
   * Apply new runtime settings without a restart (ctx-reir): slot limits and
   * queue timeout immediately, resource defaults on the next creation.
   */
  applySettings?(update: {
    maxGlobalContainers?: number;
    queueTimeoutMs?: number;
    defaultCpus?: number;
    defaultMemoryMb?: number;
    defaultPidsLimit?: number;
    defaultTimeoutSec?: number;
  }): void;
  getActiveCount(): number;
  getQueuedCount(): number;
  getPeakCount(): number;
  getMetrics(): ContainerMetrics;
}
