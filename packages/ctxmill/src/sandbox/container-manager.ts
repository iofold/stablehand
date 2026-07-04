import { PassThrough, Readable } from 'node:stream';
import { resolve } from 'node:path';
import Dockerode from 'dockerode';
import * as tar from 'tar-stream';
import { ContainerAccounting } from './container-accounting.js';
import { CONTAINER_SCOPE_LABEL, resolveContainerScopeId } from './container-scope.js';

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

export const STARTUP_GRACE_MS_LABEL = 'ctxmill.startup-grace-ms';
export const DEFAULT_CONTAINER_STARTUP_GRACE_MS = 90_000;

export interface SandboxContainerManager {
  createContainer(opts: CreateContainerOptions): Promise<ContainerInfo>;
  startContainer(containerId: string): Promise<ContainerInfo | undefined>;
  stopContainer(containerId: string, timeoutSec?: number): Promise<void>;
  removeContainer(containerId: string, force?: boolean): Promise<void>;
  extractWorkspaceDiff(containerId: string): Promise<WorkspaceDiffSnapshot | null>;
  extractContainerDiff(containerId: string): Promise<Buffer | null>;
  restoreArchive(containerId: string, archive: Buffer, options?: { deletedPaths?: string[] }): Promise<void>;
  extractLogs(containerId: string, tail?: number): Promise<string>;
  getContainer(sessionId: string): Promise<ContainerInfo | null>;
  listManagedContainers(): Promise<ContainerInfo[]>;
  listManagedContainersWithLabels(): Promise<ManagedContainerWithLabels[]>;
  getContainerExitCode(containerId: string): Promise<number | null>;
  getContainerByLabel(label: string, value: string): Promise<ContainerInfo | null>;
  isContainerAlive(containerId: string): Promise<boolean>;
  ensureNetwork(): Promise<void>;
  /** Seed slot accounting from live containers at boot (ctx-wbt). */
  rehydrateAccounting?(): Promise<number>;
  getActiveCount(): number;
  getQueuedCount(): number;
  getPeakCount(): number;
  getMetrics(): ContainerMetrics;
}

// ── Helpers ──────────────────────────────────────────────────

function parsePositiveMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveContainerStartupGraceMs(explicitMs?: number): number {
  return parsePositiveMs(explicitMs)
    ?? parsePositiveMs(process.env.CTXMILL_CONTAINER_STARTUP_GRACE_MS)
    ?? DEFAULT_CONTAINER_STARTUP_GRACE_MS;
}

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

export function buildSandboxOtelEnv(harnessName: string): string[] {
  const tracesExporter = process.env.CTXMILL_SANDBOX_OTEL_TRACES_EXPORTER
    ?? process.env.OTEL_TRACES_EXPORTER
    ?? 'none';
  const metricsExporter = process.env.CTXMILL_SANDBOX_OTEL_METRICS_EXPORTER
    ?? process.env.OTEL_METRICS_EXPORTER
    ?? 'none';
  const logsExporter = process.env.CTXMILL_SANDBOX_OTEL_LOGS_EXPORTER
    ?? process.env.OTEL_LOGS_EXPORTER
    ?? 'none';
  const endpoint = process.env.CTXMILL_SANDBOX_OTEL_EXPORTER_OTLP_ENDPOINT
    ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ?? 'http://host.docker.internal:4318';
  const protocol = process.env.CTXMILL_SANDBOX_OTEL_EXPORTER_OTLP_PROTOCOL
    ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL
    ?? 'http/protobuf';
  const resourceDetectors = process.env.CTXMILL_SANDBOX_OTEL_NODE_RESOURCE_DETECTORS
    ?? process.env.OTEL_NODE_RESOURCE_DETECTORS
    ?? 'env,host,os';
  const logLevel = process.env.CTXMILL_SANDBOX_OTEL_LOG_LEVEL
    ?? process.env.OTEL_LOG_LEVEL
    ?? 'error';
  const serviceNamePrefix = process.env.CTXMILL_SANDBOX_OTEL_SERVICE_NAME_PREFIX
    ?? 'ctxmill-sandbox';
  const baseResourceAttributes = process.env.CTXMILL_SANDBOX_OTEL_RESOURCE_ATTRIBUTES
    ?? process.env.OTEL_RESOURCE_ATTRIBUTES
    ?? 'deployment.environment=local,service.namespace=ctxmill';
  const resourceAttributes = [
    baseResourceAttributes,
    'ctxmill.component=sandbox',
    `ctxmill.harness=${harnessName}`,
  ].filter(Boolean).join(',');

  return [
    `OTEL_SERVICE_NAME=${serviceNamePrefix}-${harnessName}`,
    `OTEL_RESOURCE_ATTRIBUTES=${resourceAttributes}`,
    `OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`,
    `OTEL_EXPORTER_OTLP_PROTOCOL=${protocol}`,
    `OTEL_TRACES_EXPORTER=${tracesExporter}`,
    `OTEL_METRICS_EXPORTER=${metricsExporter}`,
    `OTEL_LOGS_EXPORTER=${logsExporter}`,
    `OTEL_NODE_RESOURCE_DETECTORS=${resourceDetectors}`,
    `OTEL_LOG_LEVEL=${logLevel}`,
  ];
}

// ContainerLimitError and ContainerSemaphore moved to container-semaphore.ts;
// re-exported here for existing importers.
export { ContainerLimitError, ContainerSemaphore } from './container-semaphore.js';

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
  ['pi-agent', 2048],
]);

export class ContainerManager implements SandboxContainerManager {
  private readonly docker: Dockerode;
  private readonly networkName: string;
  private readonly imagePrefix: string;
  private readonly scopeId: string;
  private readonly dataVolume?: string;
  private readonly dataDir?: string;
  private readonly defaultCpus: number;
  private readonly defaultMemoryMb: number;
  private readonly defaultPidsLimit: number;
  private readonly defaultTimeoutSec: number;
  private readonly startupGraceMs: number;
  private readonly maxGlobalContainers: number;

  /** Slot + metrics accounting, membership-keyed by containerId (ctx-wbt). */
  private readonly accounting: ContainerAccounting;

  constructor(options?: ContainerManagerOptions, dockerInstance?: Dockerode) {
    this.docker = dockerInstance ?? new Dockerode();
    this.networkName = options?.networkName ?? 'ctxmill-agents';
    this.imagePrefix = options?.imagePrefix ?? process.env.CTXMILL_IMAGE_PREFIX ?? 'ctxmill/harness';
    this.scopeId = resolveContainerScopeId();
    this.dataVolume = process.env.CTXMILL_DATA_VOLUME;
    this.dataDir = process.env.CTXMILL_DATA_DIR ? resolve(process.env.CTXMILL_DATA_DIR) : undefined;
    this.defaultCpus = options?.defaultCpus ?? 1.0;
    this.defaultMemoryMb = options?.defaultMemoryMb ?? 1024;
    this.defaultPidsLimit = options?.defaultPidsLimit ?? 256;
    this.defaultTimeoutSec = options?.defaultTimeoutSec ?? 600;
    this.startupGraceMs = resolveContainerStartupGraceMs(options?.startupGraceMs);

    this.maxGlobalContainers = options?.maxGlobalContainers
      ?? (process.env.CTXMILL_MAX_CONTAINERS ? parseInt(process.env.CTXMILL_MAX_CONTAINERS, 10) : 20);
    const queueTimeoutMs = options?.queueTimeoutMs ?? 60_000;
    this.accounting = new ContainerAccounting(this.maxGlobalContainers, queueTimeoutMs);
  }

  /**
   * Seed slot accounting from live managed containers (ctx-wbt). Run at boot
   * BEFORE lifecycle reconciliation so reconciliation-driven removals free
   * real slots. Live containers beyond maxGlobalContainers push active over
   * the limit until reaped; new creations queue meanwhile.
   */
  async rehydrateAccounting(): Promise<number> {
    const containers = await this.listManagedContainersWithLabels();
    const seeded = this.accounting.rehydrate(
      containers
        .filter((c) => c.status === 'running' || c.status === 'created' || c.status === 'paused')
        .map((c) => ({
          containerId: c.containerId,
          harnessName: c.harnessName || c.labels['ctxmill.harness'] || 'unknown',
          startedAtMs: c.startedAt?.getTime(),
        })),
    );
    if (seeded > 0) {
      console.info(`${TAG} rehydrated slot accounting for ${seeded} live container(s)`);
    }
    return seeded;
  }

  // ── Lifecycle ────────────────────────────────────────────

  async createContainer(opts: CreateContainerOptions): Promise<ContainerInfo> {
    // Acquire a concurrency slot (queues if at capacity, throws on timeout)
    await this.accounting.acquireSlot();
    let containerCreated = false;

    try {
      const cpus = opts.cpus ?? this.defaultCpus;
      const harnessFloor = HARNESS_MEMORY_FLOOR.get(opts.harnessName) ?? 0;
      const memoryMb = Math.max(opts.memoryMb ?? this.defaultMemoryMb, harnessFloor);
      const pidsLimit = opts.pidsLimit ?? this.defaultPidsLimit;
      const timeoutSec = opts.timeoutSec ?? this.defaultTimeoutSec;
      const containerName = `ctxmill-run-${opts.sessionId}`;

      console.debug(
        `${TAG} creating container ${containerName} (harness=${opts.harnessName}, cpus=${cpus}, mem=${memoryMb}MiB, active=${this.accounting.getActive()}/${this.accounting.getActive() + this.accounting.getQueued()})`,
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
          [CONTAINER_SCOPE_LABEL]: this.scopeId,
          'ctxmill.session-id': opts.sessionId,
          ...(opts.conversationId ? { 'ctxmill.conversation-id': opts.conversationId } : {}),
          'ctxmill.agent-id': opts.agentId,
          'ctxmill.harness': opts.harnessName,
          'ctxmill.started-at': new Date().toISOString(),
          'ctxmill.timeout': String(timeoutSec),
          [STARTUP_GRACE_MS_LABEL]: String(this.startupGraceMs),
        },
        HostConfig: {
          CpuPeriod: 100_000,
          CpuQuota: cpus * 100_000,
          Memory: memoryMb * 1024 * 1024,
          MemorySwap: memoryMb * 1024 * 1024, // No swap
          PidsLimit: pidsLimit,
          NetworkMode: this.networkName,
          ExtraHosts: ['host.docker.internal:host-gateway'],
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
          ...buildSandboxOtelEnv(opts.harnessName),
          'SANDBOX_PORT=50051',
          `CTXMILL_HARNESS=${opts.harnessName}`,
          `ORCHESTRATOR_URL=${process.env.ORCHESTRATOR_CALLBACK_URL || 'http://orchestrator:3001'}`,
          ...Object.entries(opts.secrets ?? {}).map(([k, v]) => `${k}=${v}`),
        ],
      });

      console.debug(`${TAG} container ${containerName} created (id=${container.id})`);

      this.accounting.registerCreated(container.id, opts.harnessName);

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
        this.accounting.releaseUnregisteredSlot();
      }
    }
  }

  async startContainer(containerId: string): Promise<ContainerInfo> {
    console.debug(`${TAG} starting container ${containerId}`);
    const container = this.docker.getContainer(containerId);
    await container.start();
    console.debug(`${TAG} container ${containerId} started`);
    const info = await container.inspect();
    return this.containerInspectItemToInfo(containerId, info);
  }

  async stopContainer(containerId: string, timeoutSec?: number): Promise<void> {
    console.debug(`${TAG} stopping container ${containerId} (timeout=${timeoutSec ?? 10}s)`);
    const container = this.docker.getContainer(containerId);
    try {
      await container.stop({ t: timeoutSec ?? 10 });
      console.debug(`${TAG} container ${containerId} stopped`);
      this.releaseOwnedContainerSlot(containerId);
    } catch (err: unknown) {
      // Docker returns 304 if container is already stopped
      if (isDockerError(err) && err.statusCode === 304) {
        console.debug(`${TAG} container ${containerId} already stopped`);
        this.releaseOwnedContainerSlot(containerId);
        return;
      }
      if (isDockerError(err) && err.statusCode === 404) {
        console.debug(`${TAG} container ${containerId} not found while stopping`);
        this.releaseOwnedContainerSlot(containerId);
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

    const c = this.pickScopedOrLegacyContainer(containers);
    if (!c) return null;
    return this.containerListItemToInfo(c);
  }

  async listManagedContainers(): Promise<ContainerInfo[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ['ctxmill.managed=true'] },
    });

    return containers
      .filter((c) => this.isContainerInCurrentScope(c))
      .map((c) => this.containerListItemToInfo(c));
  }

  async listManagedContainersWithLabels(): Promise<ManagedContainerWithLabels[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ['ctxmill.managed=true'] },
    });

    return containers
      .filter((c) => this.isContainerInCurrentScope(c))
      .map((c) => ({
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
    const container = this.pickScopedOrLegacyContainer(containers);
    return container ? this.containerListItemToInfo(container) : null;
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
    } catch (err) {
      if (!isDockerError(err) || err.statusCode !== 404) {
        console.warn(`${TAG} failed to inspect network ${this.networkName}:`, err);
        throw err;
      }
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
    return this.accounting.getActive();
  }

  /** Number of requests currently queued waiting for a slot. */
  getQueuedCount(): number {
    return this.accounting.getQueued();
  }

  /** Peak number of concurrently active container slots observed. */
  getPeakCount(): number {
    return this.accounting.getPeak();
  }

  /**
   * Return an in-memory snapshot of container metrics.
   * This is synchronous and lightweight (no Docker API calls) — suitable
   * for high-frequency polling from dashboards.
   */
  getMetrics(): ContainerMetrics {
    return this.accounting.getMetrics();
  }



  // ── Private helpers ─────────────────────────────────────

  /** Free the slot for any tracked container (created here or rehydrated at boot). */
  private releaseOwnedContainerSlot(containerId: string): void {
    if (!this.accounting.releaseFor(containerId)) {
      console.debug(`${TAG} container ${containerId} is not tracked by accounting; slot not released`);
    }
  }

  private pickScopedOrLegacyContainer(
    containers: Dockerode.ContainerInfo[],
  ): Dockerode.ContainerInfo | undefined {
    return containers.find((container) => this.isContainerInCurrentScope(container))
      ?? containers.find((container) => this.isLegacyContainerCompatibleWithCurrentScope(container));
  }

  private isContainerInCurrentScope(container: Dockerode.ContainerInfo): boolean {
    const labels = container.Labels ?? {};
    const containerScope = labels[CONTAINER_SCOPE_LABEL];
    if (containerScope) {
      return containerScope === this.scopeId;
    }

    return this.isLegacyContainerCompatibleWithCurrentScope(container);
  }

  private isLegacyContainerCompatibleWithCurrentScope(container: Dockerode.ContainerInfo): boolean {
    const labels = container.Labels ?? {};
    if (labels[CONTAINER_SCOPE_LABEL]) {
      return false;
    }

    const mounts = (container as {
      Mounts?: Array<{ Name?: string; Source?: string; Destination?: string }>;
    }).Mounts ?? [];

    if (this.dataVolume) {
      return mounts.some((mount) => (
        mount.Name === this.dataVolume
        || Boolean(mount.Source?.includes(`/volumes/${this.dataVolume}/`))
      ));
    }

    if (this.dataDir) {
      return mounts.some((mount) => (
        mount.Source !== undefined && (
          resolve(mount.Source) === this.dataDir
          || resolve(mount.Source).startsWith(`${this.dataDir}/`)
        )
      ));
    }

    return true;
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

  private containerInspectItemToInfo(
    containerId: string,
    c: Dockerode.ContainerInspectInfo,
  ): ContainerInfo {
    const labels = c.Config?.Labels ?? {};
    const info: ContainerInfo = {
      containerId,
      containerName: c.Name?.replace(/^\//, '') ?? '',
      sessionId: labels['ctxmill.session-id'] || labels['ctxmill.run-id'] || '',
      agentId: labels['ctxmill.agent-id'] ?? '',
      harnessName: labels['ctxmill.harness'] ?? '',
      status: dockerStateToStatus(c.State.Status),
    };

    const startedAt = labels['ctxmill.started-at'];
    if (startedAt) {
      info.startedAt = new Date(startedAt);
    }

    const networks = c.NetworkSettings?.Networks;
    if (networks) {
      const net = networks[this.networkName] ?? Object.values(networks).find((candidate) => candidate?.IPAddress);
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
