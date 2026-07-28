import { PassThrough, Readable } from 'node:stream';
import Dockerode from 'dockerode';
import { RUNTIME_INSTANCE_TOKEN_ENV } from '@ctxmill/shared';
import { isStatusCodeError } from '../../util/status-code-error.js';
import { CONTAINER_SCOPE_LABEL, resolveContainerScopeId } from '../container-scope.js';
import {
  buildDockerContainerSpec,
  resolveContainerStartupGraceMs,
  resolveSandboxRuntimeDefaults,
  runtimeLabelsToContainerInfo,
} from './spec.js';
import type { SandboxRuntimeDefaults } from './spec.js';
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

function runtimeInstanceTokenFromConfig(config: unknown): string | undefined {
  if (
    typeof config !== 'object'
    || config === null
    || !('Env' in config)
    || !Array.isArray(config.Env)
  ) {
    return undefined;
  }

  const prefix = `${RUNTIME_INSTANCE_TOKEN_ENV}=`;
  const entry = config.Env.find(
    (value): value is string =>
      typeof value === 'string' && value.startsWith(prefix),
  );
  const token = entry?.slice(prefix.length).trim();
  return token || undefined;
}

export class DockerContainerDriver {
  private readonly docker: Dockerode;
  private readonly networkName: string;
  private readonly imagePrefix: string;
  private readonly scopeId: string;
  private readonly dataVolume?: string;
  private defaults: SandboxRuntimeDefaults;
  private readonly startupGraceMs: number;

  constructor(options?: ContainerManagerOptions, dockerInstance?: Dockerode) {
    this.docker = dockerInstance ?? new Dockerode();
    this.networkName = options?.networkName ?? 'ctxmill-agents';
    this.imagePrefix = options?.imagePrefix ?? process.env.CTXMILL_IMAGE_PREFIX ?? 'ctxmill/harness';
    this.scopeId = resolveContainerScopeId(options?.scopeIdentity);
    this.dataVolume = process.env.CTXMILL_DATA_VOLUME;
    this.defaults = resolveSandboxRuntimeDefaults(options);
    this.startupGraceMs = resolveContainerStartupGraceMs(options?.startupGraceMs);
  }

  updateDefaults(update: {
    defaultCpus?: number;
    defaultMemoryMb?: number;
    defaultPidsLimit?: number;
    defaultTimeoutSec?: number;
  }): void {
    this.defaults = {
      ...this.defaults,
      ...(update.defaultCpus !== undefined ? { cpus: update.defaultCpus } : {}),
      ...(update.defaultMemoryMb !== undefined ? { memoryMb: update.defaultMemoryMb } : {}),
      ...(update.defaultPidsLimit !== undefined ? { pidsLimit: update.defaultPidsLimit } : {}),
      ...(update.defaultTimeoutSec !== undefined ? { timeoutSec: update.defaultTimeoutSec } : {}),
    };
  }

  // ── Lifecycle ────────────────────────────────────────────

  async createContainer(opts: CreateContainerOptions): Promise<ContainerInfo> {
    const spec = buildDockerContainerSpec({
      options: opts,
      imagePrefix: this.imagePrefix,
      scopeId: this.scopeId,
      networkName: this.networkName,
      defaults: this.defaults,
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
    return this.containerItemToInfo(info, containerId);
  }

  async stopContainer(containerId: string, timeoutSec?: number): Promise<void> {
    console.debug(`${TAG} stopping container ${containerId} (timeout=${timeoutSec ?? 10}s)`);
    const container = this.docker.getContainer(containerId);
    try {
      await container.stop({ t: timeoutSec ?? 10 });
      console.debug(`${TAG} container ${containerId} stopped`);
    } catch (err: unknown) {
      // Docker returns 304 if container is already stopped
      if (isStatusCodeError(err) && err.statusCode === 304) {
        console.debug(`${TAG} container ${containerId} already stopped`);
        return;
      }
      if (isStatusCodeError(err) && err.statusCode === 404) {
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
      if (isStatusCodeError(err) && err.statusCode === 404) {
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
    const result = await this.execInContainer(
      container,
      ['tar', '-C', WORKSPACE_ROOT, 'cf', '-', '--no-recursion', '--ignore-failed-read', '-T', '-'],
      { stdinPayload: paths.join('\n') + '\n' },
    );
    if (result.exitCode !== 0) {
      const stderrText = result.stderr.toString('utf-8').trim();
      throw new Error(
        stderrText.length > 0
          ? `Failed to extract container diff: ${stderrText}`
          : `Failed to extract container diff: tar exited with code ${result.exitCode}`,
      );
    }

    return result.stdout;
  }

  private async deleteWorkspacePaths(
    container: Dockerode.Container,
    paths: string[],
  ): Promise<void> {
    const result = await this.execInContainer(
      container,
      [
        'sh',
        '-c',
        'for target do rm -rf -- "/workspace/$target"; done',
        'sh',
        ...paths,
      ],
    );
    if (result.exitCode !== 0) {
      const stderrText = result.stderr.toString('utf-8').trim();
      throw new Error(
        stderrText.length > 0
          ? `Failed to apply workspace tombstones: ${stderrText}`
          : `Failed to apply workspace tombstones: rm exited with code ${result.exitCode}`,
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
        label: [
          `ctxmill.managed=true`,
          `${CONTAINER_SCOPE_LABEL}=${this.scopeId}`,
          `ctxmill.sandbox-session-id=${sessionId}`,
        ],
      },
    });

    if (containers.length === 0) return null;

    const c = containers.find((container) => this.isContainerInCurrentScope(container));
    if (!c) return null;
    return this.containerItemToInfo(c);
  }

  async getRuntimeInstanceToken(
    containerId: string,
  ): Promise<string | undefined> {
    try {
      const info = await this.docker.getContainer(containerId).inspect();
      return runtimeInstanceTokenFromConfig(info.Config);
    } catch (err: unknown) {
      if (isStatusCodeError(err) && err.statusCode === 404) {
        return undefined;
      }
      throw err;
    }
  }

  async listManagedContainers(): Promise<ContainerInfo[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ['ctxmill.managed=true', `${CONTAINER_SCOPE_LABEL}=${this.scopeId}`] },
    });

    return containers
      .filter((c) => this.isContainerInCurrentScope(c))
      .map((c) => this.containerItemToInfo(c));
  }

  async listManagedContainersWithLabels(): Promise<ManagedContainerWithLabels[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ['ctxmill.managed=true', `${CONTAINER_SCOPE_LABEL}=${this.scopeId}`] },
    });

    return containers
      .filter((c) => this.isContainerInCurrentScope(c))
      .map((c) => ({
        ...this.containerItemToInfo(c),
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
      if (isStatusCodeError(err) && err.statusCode === 404) {
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
      if (isStatusCodeError(err) && err.statusCode === 404) {
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
      if (!isStatusCodeError(err) || err.statusCode !== 404) {
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

  private isContainerInCurrentScope(container: Dockerode.ContainerInfo): boolean {
    const labels = container.Labels ?? {};
    return labels[CONTAINER_SCOPE_LABEL] === this.scopeId;
  }

  private async execInContainer(
    container: Dockerode.Container,
    command: string[],
    options: { stdinPayload?: string } = {},
  ): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
    const hasStdin = options.stdinPayload !== undefined;
    const exec = await container.exec({
      Cmd: command,
      ...(hasStdin ? { AttachStdin: true } : {}),
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start(hasStdin ? { hijack: true, stdin: true } : {});
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
        if (settled) return;
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

    if (options.stdinPayload !== undefined) {
      stream.write(options.stdinPayload);
      stream.end();
    }
    await streamDone;

    const execResult = await exec.inspect();
    return {
      stdout: Buffer.concat(stdoutChunks),
      stderr: Buffer.concat(stderrChunks),
      exitCode: execResult.ExitCode ?? 0,
    };
  }

  private containerItemToInfo(
    item: Dockerode.ContainerInfo | Dockerode.ContainerInspectInfo,
    inspectedContainerId?: string,
  ): ContainerInfo {
    const inspected = inspectedContainerId !== undefined;
    const inspectItem = item as Dockerode.ContainerInspectInfo;
    const listItem = item as Dockerode.ContainerInfo;
    const labels = inspected ? inspectItem.Config?.Labels ?? {} : listItem.Labels ?? {};
    const networks = item.NetworkSettings?.Networks;
    const preferredNetwork = networks?.[this.networkName];
    const network = preferredNetwork?.IPAddress
      ? preferredNetwork
      : Object.values(networks ?? {}).find((candidate) => candidate?.IPAddress);
    return runtimeLabelsToContainerInfo({
      containerId: inspectedContainerId ?? listItem.Id,
      containerName: (inspected ? inspectItem.Name : listItem.Names?.[0])?.replace(/^\//, '') ?? '',
      labels,
      status: normalizeDockerContainerStatus(inspected ? inspectItem.State.Status : listItem.State),
      startedAt: labels['ctxmill.started-at'],
      networkIp: network?.IPAddress,
    });
  }
}
