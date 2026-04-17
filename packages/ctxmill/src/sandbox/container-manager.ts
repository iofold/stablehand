import { PassThrough, Readable } from 'node:stream';
import Dockerode from 'dockerode';
import * as tar from 'tar-stream';

// ── Public interfaces ─────────────────────────────────────────

export interface ContainerManagerOptions {
  /** Docker bridge network name for agent containers. Default: 'ctxmill-agents' */
  networkName?: string;
  /** Image name prefix. Container image = `${imagePrefix}-${harnessName}:latest` */
  imagePrefix?: string;
  /** Default CPU allocation (fractional cores). Default: 1.0 */
  defaultCpus?: number;
  /** Default memory limit in MiB. Default: 512 */
  defaultMemoryMb?: number;
  /** Default PID limit. Default: 256 */
  defaultPidsLimit?: number;
  /** Default run timeout in seconds. Default: 600 */
  defaultTimeoutSec?: number;
  /** Maximum number of concurrent containers. Default: 20, env: CTXMILL_MAX_CONTAINERS */
  maxGlobalContainers?: number;
  /** Timeout in ms for queued container requests. Default: 60000 (60 seconds) */
  queueTimeoutMs?: number;
  /**
   * Enable egress proxy for sandbox containers. When true, sets HTTP_PROXY,
   * HTTPS_PROXY, and NO_PROXY env vars so traffic is routed through the
   * nginx egress-proxy service. Default: true when CTXMILL_EGRESS_PROXY=1,
   * false otherwise.
   */
  egressProxy?: boolean;
  /**
   * Hostname of the egress proxy service. Default: 'egress-proxy'
   */
  egressProxyHost?: string;
  /**
   * Port of the egress proxy service. Default: 3128
   */
  egressProxyPort?: number;
}

export interface CreateContainerOptions {
  sessionId: string;
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

// ── Helpers ──────────────────────────────────────────────────

/**
 * Map a Docker container state string to our simplified status enum.
 */
function dockerStateToStatus(
  state: string,
): ContainerInfo['status'] {
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

// ── Container limit error ────────────────────────────────────

export class ContainerLimitError extends Error {
  public readonly statusCode = 503;
  public readonly maxContainers: number;

  constructor(maxContainers: number) {
    super(`Maximum container limit (${maxContainers}) reached. Try again later.`);
    this.name = 'ContainerLimitError';
    this.maxContainers = maxContainers;
  }
}

// ── ContainerSemaphore ───────────────────────────────────────

interface QueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Promise-based semaphore that limits concurrent container allocations.
 * When the limit is reached, acquire() queues the caller and resolves
 * when a slot opens (or rejects after a timeout).
 */
export class ContainerSemaphore {
  private active = 0;
  private peak = 0;
  private readonly queue: QueueEntry[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly queueTimeoutMs: number,
  ) {}

  /**
   * Acquire a slot. Resolves immediately if under the limit,
   * otherwise queues until a slot opens or the timeout expires.
   */
  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      this.peak = Math.max(this.peak, this.active);
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((e) => e.resolve === resolve);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new ContainerLimitError(this.maxConcurrent));
      }, this.queueTimeoutMs);
      // Don't let the timer keep the process alive
      if (timer && typeof timer === 'object' && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref();
      }
      this.queue.push({ resolve, reject, timer });
    });
  }

  /**
   * Release a slot. Wakes the next queued request (FIFO) or decrements
   * the active count if the queue is empty.
   * Gracefully handles over-release (active count never goes below 0).
   */
  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      clearTimeout(next.timer);
      // Active count stays the same — the slot transfers to the next waiter
      next.resolve();
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }

  getActive(): number {
    return this.active;
  }

  getQueued(): number {
    return this.queue.length;
  }

  getPeak(): number {
    return this.peak;
  }
}

// ── ContainerManager ─────────────────────────────────────────

const TAG = '[ContainerManager]';

const WORKSPACE_ROOT = '/workspace';
const WORKSPACE_EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules',
  '.npm',
  '.cache',
  '.bun',
]);

/**
 * Return true when a diff path should be included in snapshots.
 */
function workspaceRelativePath(filePath: string): string | null {
  if (filePath === WORKSPACE_ROOT || !filePath.startsWith(`${WORKSPACE_ROOT}/`)) {
    return null;
  }

  const relativePath = filePath.slice(WORKSPACE_ROOT.length + 1);
  return isSafeWorkspaceRelativePath(relativePath) ? relativePath : null;
}

function isSafeWorkspaceRelativePath(filePath: string): boolean {
  if (
    filePath === ''
    || filePath.startsWith('/')
    || filePath.includes('\0')
  ) {
    return false;
  }

  const segments = filePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return false;
  }

  return true;
}

function normalizeArchiveEntryName(entryName: string): string {
  return entryName
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '');
}

function shouldIncludeWorkspacePath(filePath: string): boolean {
  const relativePath = workspaceRelativePath(filePath);
  if (!relativePath) {
    return false;
  }

  return !relativePath
    .split('/')
    .some((segment) => WORKSPACE_EXCLUDED_SEGMENTS.has(segment));
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

/**
 * Per-harness minimum memory floors (MiB).
 * Harnesses that spawn subprocesses (e.g. Claude SDK → node cli.js) need
 * more headroom than the global default.
 */
const HARNESS_MEMORY_FLOOR: ReadonlyMap<string, number> = new Map([
  ['claude-agents', 2048],
]);

export class ContainerManager {
  private readonly docker: Dockerode;
  private readonly networkName: string;
  private readonly imagePrefix: string;
  private readonly defaultCpus: number;
  private readonly defaultMemoryMb: number;
  private readonly defaultPidsLimit: number;
  private readonly defaultTimeoutSec: number;
  private readonly semaphore: ContainerSemaphore;
  private readonly maxGlobalContainers: number;
  private readonly egressProxy: boolean;
  private readonly egressProxyHost: string;
  private readonly egressProxyPort: number;

  // ── Metrics tracking (in-memory, not persisted) ──────────
  private totalCreated = 0;
  private readonly activeByHarness = new Map<string, number>();
  private readonly containerStartTimes = new Map<string, number>(); // containerId → start timestamp
  private readonly containerHarness = new Map<string, string>(); // containerId → harnessName
  private completedCount = 0;
  private lifetimeSumMs = 0;

  constructor(options?: ContainerManagerOptions, dockerInstance?: Dockerode) {
    this.docker = dockerInstance ?? new Dockerode();
    this.networkName = options?.networkName ?? 'ctxmill-agents';
    this.imagePrefix = options?.imagePrefix ?? process.env.CTXMILL_IMAGE_PREFIX ?? 'ctxmill/harness';
    this.defaultCpus = options?.defaultCpus ?? 1.0;
    this.defaultMemoryMb = options?.defaultMemoryMb ?? 1024;
    this.defaultPidsLimit = options?.defaultPidsLimit ?? 256;
    this.defaultTimeoutSec = options?.defaultTimeoutSec ?? 600;
    this.egressProxy =
      options?.egressProxy ?? process.env.CTXMILL_EGRESS_PROXY === '1';
    this.egressProxyHost = options?.egressProxyHost ?? 'egress-proxy';
    this.egressProxyPort = options?.egressProxyPort ?? 3128;

    this.maxGlobalContainers = options?.maxGlobalContainers
      ?? (process.env.CTXMILL_MAX_CONTAINERS ? parseInt(process.env.CTXMILL_MAX_CONTAINERS, 10) : 20);
    const queueTimeoutMs = options?.queueTimeoutMs ?? 60_000;
    this.semaphore = new ContainerSemaphore(this.maxGlobalContainers, queueTimeoutMs);
  }

  // ── Lifecycle ────────────────────────────────────────────

  async createContainer(opts: CreateContainerOptions): Promise<ContainerInfo> {
    // Acquire a concurrency slot (queues if at capacity, throws on timeout)
    await this.semaphore.acquire();
    let containerCreated = false;

    try {
      const cpus = opts.cpus ?? this.defaultCpus;
      const harnessFloor = HARNESS_MEMORY_FLOOR.get(opts.harnessName) ?? 0;
      const memoryMb = Math.max(opts.memoryMb ?? this.defaultMemoryMb, harnessFloor);
      const pidsLimit = opts.pidsLimit ?? this.defaultPidsLimit;
      const timeoutSec = opts.timeoutSec ?? this.defaultTimeoutSec;
      const containerName = `ctxmill-run-${opts.sessionId}`;

      console.debug(
        `${TAG} creating container ${containerName} (harness=${opts.harnessName}, cpus=${cpus}, mem=${memoryMb}MiB, active=${this.semaphore.getActive()}/${this.semaphore.getActive() + this.semaphore.getQueued()})`,
      );

      const dataVolume = process.env.CTXMILL_DATA_VOLUME;
      const dataRoot = '/app/project/.ctxmill';
      const binds: string[] = [];
      const volumeMounts: unknown[] = [];

      if (opts.workspaceDir && dataVolume && opts.workspaceDir.startsWith(dataRoot)) {
        const subpath = opts.workspaceDir.slice(dataRoot.length + 1);
        volumeMounts.push({
          Type: 'volume',
          Source: dataVolume,
          Target: '/workspace',
          ReadOnly: false,
          VolumeOptions: { Subpath: subpath },
        });
      } else if (opts.workspaceDir) {
        binds.push(`${opts.workspaceDir}:/workspace:rw`);
      }

      const container = await this.docker.createContainer({
        Image: `${this.imagePrefix}-${opts.harnessName}:latest`,
        name: containerName,
        Labels: {
          'ctxmill.managed': 'true',
          'ctxmill.session-id': opts.sessionId,
          'ctxmill.agent-id': opts.agentId,
          'ctxmill.harness': opts.harnessName,
          'ctxmill.started-at': new Date().toISOString(),
          'ctxmill.timeout': String(timeoutSec),
        },
        HostConfig: {
          CpuPeriod: 100_000,
          CpuQuota: cpus * 100_000,
          Memory: memoryMb * 1024 * 1024,
          MemorySwap: memoryMb * 1024 * 1024, // No swap
          PidsLimit: pidsLimit,
          Tmpfs: { '/run/secrets': 'rw,noexec,nosuid,size=1m' },
          NetworkMode: this.networkName,
          SecurityOpt: ['no-new-privileges'],
          ReadonlyRootfs: false,
          LogConfig: {
            Type: 'json-file',
            Config: {
              'max-size': '50m',
              'max-file': '3',
            },
          },
          Binds: binds.length > 0 ? binds : undefined,
          Mounts: volumeMounts.length > 0 ? volumeMounts : undefined,
        } as Record<string, unknown>,
        Env: [
          `NODE_OPTIONS=--max-old-space-size=${Math.floor(memoryMb * 0.9)}`,
          'SANDBOX_PORT=50051',
          `CTXMILL_HARNESS=${opts.harnessName}`,
          `ORCHESTRATOR_URL=${process.env.ORCHESTRATOR_CALLBACK_URL || 'http://orchestrator:3001'}`,
          ...(opts.secrets
            ? Object.entries(opts.secrets).map(([k, v]) => `${k}=${v}`)
            : []),
          ...(this.egressProxy
            ? [
                `HTTP_PROXY=http://${this.egressProxyHost}:${this.egressProxyPort}`,
                `HTTPS_PROXY=http://${this.egressProxyHost}:${this.egressProxyPort}`,
                `http_proxy=http://${this.egressProxyHost}:${this.egressProxyPort}`,
                `https_proxy=http://${this.egressProxyHost}:${this.egressProxyPort}`,
                'NO_PROXY=orchestrator,localhost,127.0.0.1,minio',
                'no_proxy=orchestrator,localhost,127.0.0.1,minio',
              ]
            : []),
        ],
      });

      console.debug(`${TAG} container ${containerName} created (id=${container.id})`);

      // ── Update metrics ─────────────────────────────────────
      this.totalCreated++;
      const currentHarnessCount = this.activeByHarness.get(opts.harnessName) ?? 0;
      this.activeByHarness.set(opts.harnessName, currentHarnessCount + 1);
      this.containerStartTimes.set(container.id, Date.now());
      this.containerHarness.set(container.id, opts.harnessName);

      containerCreated = true;
      return {
        containerId: container.id,
        containerName,
        sessionId: opts.sessionId,
        agentId: opts.agentId,
        harnessName: opts.harnessName,
        status: 'created',
      };
    } finally {
      if (!containerCreated) {
        this.semaphore.release();
      }
    }
  }

  async startContainer(containerId: string): Promise<void> {
    console.debug(`${TAG} starting container ${containerId}`);
    const container = this.docker.getContainer(containerId);
    await container.start();
    console.debug(`${TAG} container ${containerId} started`);
  }

  async stopContainer(containerId: string, timeoutSec?: number): Promise<void> {
    console.debug(`${TAG} stopping container ${containerId} (timeout=${timeoutSec ?? 10}s)`);
    const container = this.docker.getContainer(containerId);
    try {
      await container.stop({ t: timeoutSec ?? 10 });
      console.debug(`${TAG} container ${containerId} stopped`);
    } catch (err: unknown) {
      // Docker returns 304 if container is already stopped
      if (isDockerError(err) && err.statusCode === 304) {
        console.debug(`${TAG} container ${containerId} already stopped`);
        return;
      }
      throw err;
    }
  }

  async removeContainer(containerId: string, force?: boolean): Promise<void> {
    console.debug(`${TAG} removing container ${containerId} (force=${force ?? false})`);
    const container = this.docker.getContainer(containerId);
    try {
      await container.remove({ force: force ?? false });
      console.debug(`${TAG} container ${containerId} removed`);
      this.releaseOwnedContainerSlot(containerId);
    } catch (err: unknown) {
      // Docker returns 404 if container doesn't exist
      if (isDockerError(err) && err.statusCode === 404) {
        console.debug(`${TAG} container ${containerId} not found (already removed)`);
        this.releaseOwnedContainerSlot(containerId);
        return;
      }
      throw err;
    }
  }

  // ── Workspace ───────────────────────────────────────────

  async extractWorkspaceDiff(containerId: string): Promise<WorkspaceDiffSnapshot | null> {
    console.debug(`${TAG} extracting workspace diff from container ${containerId}`);
    const container = this.docker.getContainer(containerId);
    const changes = await container.changes();

    const changedPaths = uniquePaths(
      changes
        .filter((change) => (change.Kind === 0 || change.Kind === 1) && shouldIncludeWorkspacePath(change.Path))
        .map((change) => workspaceRelativePath(change.Path))
        .filter((pathValue): pathValue is string => pathValue !== null),
    );
    const deletedPaths = uniquePaths(
      changes
        .filter((change) => change.Kind === 2 && shouldIncludeWorkspacePath(change.Path))
        .map((change) => workspaceRelativePath(change.Path))
        .filter((pathValue): pathValue is string => pathValue !== null),
    );

    if (changedPaths.length === 0 && deletedPaths.length === 0) {
      console.debug(`${TAG} no meaningful workspace changes in container ${containerId}`);
      return null;
    }

    const archive = changedPaths.length > 0
      ? await this.createWorkspaceArchive(container, changedPaths)
      : null;

    return {
      archive,
      deletedPaths,
    };
  }

  /**
   * Restore a tar archive into the container workspace.
   * This is intentionally narrow so callers do not reach through Docker internals.
   */
  async restoreArchive(
    containerId: string,
    archive: Buffer,
    options?: { deletedPaths?: string[] },
  ): Promise<void> {
    console.debug(`${TAG} restoring archive into workspace for container ${containerId}`);
    const container = this.docker.getContainer(containerId);
    const deletedPaths = uniquePaths(options?.deletedPaths ?? []);

    if (deletedPaths.some((deletedPath) => !isSafeWorkspaceRelativePath(deletedPath))) {
      throw new Error('Workspace restore rejected unsafe deleted path');
    }

    if (deletedPaths.length > 0) {
      await this.deleteWorkspacePaths(container, deletedPaths);
    }

    if (archive.length === 0) {
      return;
    }

    await this.validateWorkspaceArchive(archive);
    await container.putArchive(Readable.from(archive), { path: WORKSPACE_ROOT });
  }

  /**
   * Extract all meaningful filesystem changes from a container using Docker's
   * overlay diff. Uses container.changes() to find modified/added files, filters
   * out noise, then creates a tar via `docker exec tar` inside the container.
   */
  async extractContainerDiff(containerId: string): Promise<Buffer | null> {
    const snapshot = await this.extractWorkspaceDiff(containerId);
    return snapshot?.archive ?? null;
  }

  private async createWorkspaceArchive(
    container: Dockerode.Container,
    paths: string[],
  ): Promise<Buffer> {
    const exec = await container.exec({
      Cmd: ['tar', '-C', WORKSPACE_ROOT, 'cf', '-', '--no-recursion', '--ignore-failed-read', '-T', '-'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: true });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    stdout.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stderr.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    this.docker.modem.demuxStream(stream, stdout, stderr);

    const streamDone = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        stdout.end();
        stderr.end();
        resolve();
      };
      stream.on('error', reject);
      stream.on('end', finish);
      stream.on('finish', finish);
      stream.on('close', finish);
    });

    stream.write(paths.join('\n') + '\n');
    stream.end();

    await streamDone;

    const execResult = await exec.inspect();
    if ((execResult.ExitCode ?? 0) !== 0) {
      const stderrText = Buffer.concat(stderrChunks).toString('utf-8').trim();
      throw new Error(
        stderrText.length > 0
          ? `Failed to extract container diff: ${stderrText}`
          : `Failed to extract container diff: tar exited with code ${execResult.ExitCode}`,
      );
    }

    return Buffer.concat(stdoutChunks);
  }

  private async deleteWorkspacePaths(
    container: Dockerode.Container,
    paths: string[],
  ): Promise<void> {
    const exec = await container.exec({
      Cmd: [
        'sh',
        '-c',
        'for target do rm -rf -- "/workspace/$target"; done',
        'sh',
        ...paths,
      ],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({});
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stderrChunks: Buffer[] = [];

    stderr.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    this.docker.modem.demuxStream(stream, stdout, stderr);

    const streamDone = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        stdout.end();
        stderr.end();
        resolve();
      };
      stream.on('error', reject);
      stream.on('end', finish);
      stream.on('finish', finish);
      stream.on('close', finish);
    });

    await streamDone;

    const execResult = await exec.inspect();
    if ((execResult.ExitCode ?? 0) !== 0) {
      const stderrText = Buffer.concat(stderrChunks).toString('utf-8').trim();
      throw new Error(
        stderrText.length > 0
          ? `Failed to apply workspace tombstones: ${stderrText}`
          : `Failed to apply workspace tombstones: rm exited with code ${execResult.ExitCode}`,
      );
    }
  }

  private async validateWorkspaceArchive(archive: Buffer): Promise<void> {
    const extract = tar.extract();

    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const fail = (err: unknown) => {
        if (finished) {
          return;
        }
        finished = true;
        extract.destroy();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      extract.on('entry', (header, entryStream, next) => {
        const originalName = String(header.name ?? '');
        const normalizedName = normalizeArchiveEntryName(originalName);

        try {
          if (!isSafeWorkspaceRelativePath(normalizedName)) {
            throw new Error(`Workspace archive rejected unsafe path: ${originalName}`);
          }

          if (header.type === 'symlink' || header.type === 'link') {
            throw new Error(`Workspace archive rejected ${header.type} entry: ${originalName}`);
          }

          if (
            header.type !== undefined
            && header.type !== 'file'
            && header.type !== 'directory'
          ) {
            throw new Error(`Workspace archive rejected special entry '${header.type}': ${originalName}`);
          }

          entryStream.resume();
          next();
        } catch (err) {
          entryStream.resume();
          fail(err);
        }
      });

      extract.on('finish', () => {
        if (finished) {
          return;
        }
        finished = true;
        resolve();
      });
      extract.on('error', fail);
      Readable.from(archive).on('error', fail).pipe(extract);
    });
  }

  async extractLogs(containerId: string, tail?: number): Promise<string> {
    console.debug(`${TAG} extracting logs from container ${containerId} (tail=${tail ?? 'all'})`);
    const container = this.docker.getContainer(containerId);
    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail: tail ?? 1000,
    });
    // Dockerode can return a Buffer or string depending on TTY setting
    return typeof logs === 'string' ? logs : (logs as unknown as Buffer).toString('utf-8');
  }

  // ── Tracking ────────────────────────────────────────────

  async getContainer(sessionId: string): Promise<ContainerInfo | null> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: [`ctxmill.managed=true`, `ctxmill.session-id=${sessionId}`],
      },
    });

    if (containers.length === 0) return null;

    const c = containers[0];
    return this.containerListItemToInfo(c);
  }

  async listManagedContainers(): Promise<ContainerInfo[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ['ctxmill.managed=true'] },
    });

    return containers.map((c) => this.containerListItemToInfo(c));
  }

  async listManagedContainersWithLabels(): Promise<ManagedContainerWithLabels[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ['ctxmill.managed=true'] },
    });

    return containers.map((c) => ({
      ...this.containerListItemToInfo(c),
      labels: c.Labels ?? {},
    }));
  }

  async getContainerExitCode(containerId: string): Promise<number | null> {
    const container = this.docker.getContainer(containerId);
    try {
      const info = await container.inspect();
      if (info.State.Status === 'exited' || info.State.Status === 'dead') {
        return info.State.ExitCode;
      }
      return null;
    } catch (err: unknown) {
      if (isDockerError(err) && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async getContainerByLabel(label: string, value: string): Promise<ContainerInfo | null> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: [`ctxmill.managed=true`, `${label}=${value}`],
      },
    });

    if (containers.length === 0) return null;
    return this.containerListItemToInfo(containers[0]);
  }

  async isContainerAlive(containerId: string): Promise<boolean> {
    try {
      const info = await this.docker.getContainer(containerId).inspect();
      const state = info.State.Status.toLowerCase();
      return state === 'running' || state === 'paused';
    } catch (err: unknown) {
      if (isDockerError(err) && err.statusCode === 404) {
        return false;
      }
      throw err;
    }
  }

  // ── Network ─────────────────────────────────────────────

  async ensureNetwork(): Promise<void> {
    try {
      await this.docker.getNetwork(this.networkName).inspect();
      console.debug(`${TAG} network ${this.networkName} already exists`);
    } catch {
      console.debug(`${TAG} creating network ${this.networkName}`);
      await this.docker.createNetwork({
        Name: this.networkName,
        Driver: 'bridge',
        Internal: false, // Agents need internet for LLM APIs
      });
      console.debug(`${TAG} network ${this.networkName} created`);
    }
  }

  // ── Concurrency metrics ─────────────────────────────────

  /** Number of currently active (acquired) container slots. */
  getActiveCount(): number {
    return this.semaphore.getActive();
  }

  /** Number of requests currently queued waiting for a slot. */
  getQueuedCount(): number {
    return this.semaphore.getQueued();
  }

  /** Peak number of concurrently active container slots observed. */
  getPeakCount(): number {
    return this.semaphore.getPeak();
  }

  /**
   * Return an in-memory snapshot of container metrics.
   * This is synchronous and lightweight (no Docker API calls) — suitable
   * for high-frequency polling from dashboards.
   */
  getMetrics(): ContainerMetrics {
    const byHarness: Record<string, number> = {};
    for (const [harness, count] of this.activeByHarness) {
      byHarness[harness] = count;
    }
    return {
      active: this.semaphore.getActive(),
      queued: this.semaphore.getQueued(),
      peak: this.semaphore.getPeak(),
      totalCreated: this.totalCreated,
      byHarness,
      averageLifetimeMs: this.completedCount > 0
        ? Math.round(this.lifetimeSumMs / this.completedCount)
        : 0,
      maxGlobalContainers: this.maxGlobalContainers,
    };
  }



  // ── Private helpers ─────────────────────────────────────

  /** Release the semaphore slot only for containers created by this manager. */
  private releaseOwnedContainerSlot(containerId: string): void {
    if (!this.containerHarness.has(containerId)) {
      console.debug(`${TAG} container ${containerId} is not owned by this manager; slot not released`);
      return;
    }

    this.semaphore.release();
    this.recordContainerCompletion(containerId);
  }

  /**
   * Record completion of a container: update average lifetime and
   * decrement per-harness active count. Called internally after removal.
   */
  private recordContainerCompletion(containerId: string): void {
    // Update average lifetime (running sum, not storing all durations)
    const startTime = this.containerStartTimes.get(containerId);
    if (startTime !== undefined) {
      const lifetimeMs = Date.now() - startTime;
      this.completedCount++;
      this.lifetimeSumMs += lifetimeMs;
      this.containerStartTimes.delete(containerId);
    }

    // Decrement per-harness count
    const harnessName = this.containerHarness.get(containerId);
    if (harnessName) {
      const current = this.activeByHarness.get(harnessName) ?? 0;
      if (current <= 1) {
        this.activeByHarness.delete(harnessName);
      } else {
        this.activeByHarness.set(harnessName, current - 1);
      }
      this.containerHarness.delete(containerId);
    }
  }

  private containerListItemToInfo(c: Dockerode.ContainerInfo): ContainerInfo {
    const labels = c.Labels;
    const info: ContainerInfo = {
      containerId: c.Id,
      containerName: c.Names?.[0]?.replace(/^\//, '') ?? '',
      sessionId: labels['ctxmill.session-id'] || labels['ctxmill.run-id'] || '',
      agentId: labels['ctxmill.agent-id'] ?? '',
      harnessName: labels['ctxmill.harness'] ?? '',
      status: dockerStateToStatus(c.State),
    };

    const startedAt = labels['ctxmill.started-at'];
    if (startedAt) {
      info.startedAt = new Date(startedAt);
    }

    // Extract network IP if available
    const networks = c.NetworkSettings?.Networks;
    if (networks) {
      const net = networks[this.networkName];
      if (net?.IPAddress) {
        info.networkIp = net.IPAddress;
      }
    }

    return info;
  }
}

// ── Error helpers ─────────────────────────────────────────────

interface DockerError {
  statusCode: number;
  message: string;
}

function isDockerError(err: unknown): err is DockerError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    typeof (err as DockerError).statusCode === 'number'
  );
}
