import { PassThrough, Readable } from 'node:stream';
import { resolve } from 'node:path';
import Dockerode from 'dockerode';
import { CONTAINER_SCOPE_LABEL, resolveContainerScopeId } from '../container-scope.js';
import {
  buildDockerContainerSpec,
  resolveContainerStartupGraceMs,
} from './spec.js';
import { normalizeDockerContainerStatus } from './status.js';
import type {
  ContainerInfo,
  ContainerManagerOptions,
  CreateContainerOptions,
  ManagedContainerWithLabels,
  WorkspaceDiffSnapshot,
} from './types.js';
import {
  shouldIncludeWorkspacePath,
  uniqueWorkspacePaths,
  validateWorkspaceArchive,
  validateWorkspaceDeletedPaths,
  workspaceRelativePath,
  WORKSPACE_ROOT,
} from './workspace-policy.js';

const TAG = '[ContainerManager]';

export class DockerContainerDriver {
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
  }

  // ── Lifecycle ────────────────────────────────────────────

  async createContainer(opts: CreateContainerOptions): Promise<ContainerInfo> {
    const spec = buildDockerContainerSpec({
      options: opts,
      imagePrefix: this.imagePrefix,
      scopeId: this.scopeId,
      networkName: this.networkName,
      defaults: {
        cpus: this.defaultCpus,
        memoryMb: this.defaultMemoryMb,
        pidsLimit: this.defaultPidsLimit,
        timeoutSec: this.defaultTimeoutSec,
      },
      startupGraceMs: this.startupGraceMs,
      startedAtIso: new Date().toISOString(),
      orchestratorUrl: process.env.ORCHESTRATOR_CALLBACK_URL || 'http://orchestrator:3001',
      dataVolume: this.dataVolume,
    });

    console.debug(
      `${TAG} creating container ${spec.containerName} (harness=${opts.harnessName}, cpus=${spec.resources.cpus}, mem=${spec.resources.memoryMb}MiB)`,
    );

    const container = await this.docker.createContainer(spec.createOptions);

    console.debug(`${TAG} container ${spec.containerName} created (id=${container.id})`);

    return {
      containerId: container.id,
      containerName: spec.containerName,
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      harnessName: opts.harnessName,
      status: 'created',
    };
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
    } catch (err: unknown) {
      // Docker returns 304 if container is already stopped
      if (isDockerError(err) && err.statusCode === 304) {
        console.debug(`${TAG} container ${containerId} already stopped`);
        return;
      }
      if (isDockerError(err) && err.statusCode === 404) {
        console.debug(`${TAG} container ${containerId} not found while stopping`);
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
    } catch (err: unknown) {
      // Docker returns 404 if container doesn't exist
      if (isDockerError(err) && err.statusCode === 404) {
        console.debug(`${TAG} container ${containerId} not found (already removed)`);
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

    const changedPaths = uniqueWorkspacePaths(
      changes
        .filter((change) => (change.Kind === 0 || change.Kind === 1) && shouldIncludeWorkspacePath(change.Path))
        .map((change) => workspaceRelativePath(change.Path))
        .filter((pathValue): pathValue is string => pathValue !== null),
    );
    const deletedPaths = uniqueWorkspacePaths(
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
    const deletedPaths = uniqueWorkspacePaths(options?.deletedPaths ?? []);
    validateWorkspaceDeletedPaths(deletedPaths);

    if (deletedPaths.length > 0) {
      await this.deleteWorkspacePaths(container, deletedPaths);
    }

    if (archive.length === 0) {
      return;
    }

    await validateWorkspaceArchive(archive);
    await container.putArchive(Readable.from(archive), { path: WORKSPACE_ROOT });
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

  // ── Private helpers ─────────────────────────────────────

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
      status: normalizeDockerContainerStatus(c.State),
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
      status: normalizeDockerContainerStatus(c.State.Status),
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
