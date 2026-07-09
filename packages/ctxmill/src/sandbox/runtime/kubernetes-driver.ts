import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import * as tar from 'tar-stream';

import { CONTAINER_SCOPE_LABEL, resolveContainerScopeId } from '../container-scope.js';
import {
  buildKubernetesJobSpec,
  resolveContainerStartupGraceMs,
  sanitizeKubernetesName,
} from './spec.js';
import type {
  ContainerInfo,
  ContainerManagerOptions,
  CreateContainerOptions,
  ManagedContainerWithLabels,
  WorkspaceDiffSnapshot,
} from './types.js';
import {
  isAliveContainerStatus,
  normalizeKubernetesPodStatus,
} from './status.js';
import {
  assertSafeWorkspaceArchiveEntry,
  shouldIncludeWorkspaceRelativePath,
  uniqueWorkspacePaths,
  validateWorkspaceDeletedPaths,
} from './workspace-policy.js';

const TAG = '[KubernetesContainerManager]';
const SERVICE_ACCOUNT_ROOT = '/var/run/secrets/kubernetes.io/serviceaccount';

export interface KubernetesContainerManagerOptions extends ContainerManagerOptions {
  namespace?: string;
  dataHostPathRoot?: string;
  podReadyTimeoutMs?: number;
}

interface KubeMetadata {
  name?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  deletionTimestamp?: string;
}

interface KubePod {
  metadata?: KubeMetadata;
  status?: {
    phase?: string;
    podIP?: string;
    containerStatuses?: Array<{
      state?: {
        terminated?: { exitCode?: number };
      };
    }>;
  };
}

interface KubePodList {
  items?: KubePod[];
}

interface KubeStatus {
  code?: number;
  message?: string;
  reason?: string;
}

interface ContainerRecord {
  sessionId: string;
  agentId: string;
  harnessName: string;
  workspaceDir?: string;
  startedAt: number;
}

class KubernetesApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'KubernetesApiError';
  }
}

function envNumber(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function statusCodeError(statusCode: number, message: string): Error {
  return Object.assign(new KubernetesApiError(statusCode, message), { statusCode });
}

async function readNamespace(): Promise<string> {
  const explicit = process.env.CTXMILL_K8S_NAMESPACE || process.env.POD_NAMESPACE;
  if (explicit) return explicit;
  try {
    return (await fs.readFile(`${SERVICE_ACCOUNT_ROOT}/namespace`, 'utf8')).trim();
  } catch {
    return 'default';
  }
}

export class KubernetesContainerDriver {
  private readonly namespacePromise: Promise<string>;
  private readonly apiHost: string;
  private readonly apiPort: string;
  private readonly imagePrefix: string;
  private readonly scopeId: string;
  private readonly defaultCpus: number;
  private readonly defaultMemoryMb: number;
  private readonly defaultPidsLimit: number;
  private readonly defaultTimeoutSec: number;
  private readonly dataHostPathRoot: string;
  private readonly podReadyTimeoutMs: number;
  private readonly startupGraceMs: number;
  /** Kept for workspaceDirFor and record metadata only; not slot accounting. */
  private readonly records = new Map<string, ContainerRecord>();
  private tokenPromise: Promise<string>;
  private caPromise: Promise<Buffer>;

  constructor(options: KubernetesContainerManagerOptions = {}) {
    this.namespacePromise = options.namespace ? Promise.resolve(options.namespace) : readNamespace();
    this.apiHost = process.env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc';
    this.apiPort = process.env.KUBERNETES_SERVICE_PORT ?? '443';
    this.imagePrefix = options.imagePrefix ?? process.env.CTXMILL_IMAGE_PREFIX ?? 'ctxmill/harness';
    this.scopeId = resolveContainerScopeId();
    this.defaultCpus = options.defaultCpus ?? 1.0;
    this.defaultMemoryMb = options.defaultMemoryMb ?? 1024;
    this.defaultPidsLimit = options.defaultPidsLimit ?? 256;
    this.defaultTimeoutSec = options.defaultTimeoutSec ?? 600;
    this.dataHostPathRoot = options.dataHostPathRoot ?? process.env.CTXMILL_K8S_DATA_HOST_PATH ?? process.env.CTXMILL_DATA_DIR ?? '/var/lib/ctxmill/data';
    this.podReadyTimeoutMs = options.podReadyTimeoutMs ?? envNumber('CTXMILL_K8S_POD_READY_TIMEOUT_MS') ?? 60_000;
    this.startupGraceMs = resolveContainerStartupGraceMs(
      options.startupGraceMs
        ?? envNumber('CTXMILL_CONTAINER_STARTUP_GRACE_MS')
        ?? this.podReadyTimeoutMs + 30_000,
    );
    this.tokenPromise = fs.readFile(`${SERVICE_ACCOUNT_ROOT}/token`, 'utf8');
    this.caPromise = fs.readFile(`${SERVICE_ACCOUNT_ROOT}/ca.crt`);
  }

  async createContainer(opts: CreateContainerOptions): Promise<ContainerInfo> {
    const namespace = await this.namespacePromise;
    const spec = buildKubernetesJobSpec({
      options: opts,
      namespace,
      imagePrefix: this.imagePrefix,
      scopeId: this.scopeId,
      defaults: {
        cpus: this.defaultCpus,
        memoryMb: this.defaultMemoryMb,
        pidsLimit: this.defaultPidsLimit,
        timeoutSec: this.defaultTimeoutSec,
      },
      startupGraceMs: this.startupGraceMs,
      startedAtIso: new Date().toISOString(),
      orchestratorUrl: process.env.ORCHESTRATOR_CALLBACK_URL || 'http://orchestrator:3001',
      dataHostPathRoot: this.dataHostPathRoot,
    });

    console.debug(`${TAG} creating sandbox Job ${spec.jobName} in namespace ${namespace}`);

    await fs.mkdir(spec.workspaceHostPath, { recursive: true });
    await this.requestJson('POST', `/apis/batch/v1/namespaces/${namespace}/jobs`, spec.manifest);

    this.records.set(spec.jobName, {
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      harnessName: opts.harnessName,
      workspaceDir: spec.workspaceHostPath,
      startedAt: Date.now(),
    });

    return {
      containerId: spec.jobName,
      containerName: spec.jobName,
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      harnessName: opts.harnessName,
      status: 'created',
      startedAt: new Date(),
    };
  }

  async startContainer(containerId: string): Promise<ContainerInfo> {
    const pod = await this.waitForPod(containerId);
    const info = this.podToContainerInfo(containerId, pod);
    if (!info.networkIp) {
      throw new Error(`Sandbox pod ${info.containerName} has no pod IP`);
    }
    return info;
  }

  async stopContainer(containerId: string, _timeoutSec?: number): Promise<void> {
    await this.deleteJob(containerId);
    this.records.delete(containerId);
  }

  async removeContainer(containerId: string, _force?: boolean): Promise<void> {
    await this.deleteJob(containerId);
    this.records.delete(containerId);
  }

  async extractWorkspaceDiff(containerId: string): Promise<WorkspaceDiffSnapshot | null> {
    const workspaceDir = await this.workspaceDirFor(containerId);
    if (!workspaceDir) return null;
    const archive = await this.createWorkspaceArchive(workspaceDir);
    return archive.length > 0 ? { archive, deletedPaths: [] } : null;
  }

  async restoreArchive(
    containerId: string,
    archive: Buffer,
    options?: { deletedPaths?: string[] },
  ): Promise<void> {
    const workspaceDir = await this.workspaceDirFor(containerId);
    if (!workspaceDir) {
      throw new Error(`No workspace directory recorded for Kubernetes sandbox ${containerId}`);
    }
    const workspaceRoot = resolve(workspaceDir);
    const deletedPaths = uniqueWorkspacePaths(options?.deletedPaths ?? []);
    validateWorkspaceDeletedPaths(deletedPaths);

    for (const deletedPath of deletedPaths) {
      const target = resolve(workspaceRoot, deletedPath);
      await fs.rm(target, { recursive: true, force: true });
    }

    if (archive.length === 0) return;
    await this.extractArchiveToWorkspace(archive, workspaceDir);
  }

  async extractLogs(containerId: string, tail?: number): Promise<string> {
    const namespace = await this.namespacePromise;
    const pod = await this.findPod(containerId);
    if (!pod?.metadata?.name) return '';
    return this.requestText(
      'GET',
      `/api/v1/namespaces/${namespace}/pods/${pod.metadata.name}/log?container=sandbox${tail ? `&tailLines=${tail}` : ''}`,
    );
  }

  async getContainer(sessionId: string): Promise<ContainerInfo | null> {
    const pod = await this.findPodBySelector(`ctxmill.session-id=${sessionId},${CONTAINER_SCOPE_LABEL}=${this.scopeId}`)
      ?? await this.findPodBySelector(`ctxmill.session-id=${sessionId}`);
    return pod ? this.podToContainerInfo(this.jobNameFromPod(pod) ?? `ctxmill-run-${sanitizeKubernetesName(sessionId)}`, pod) : null;
  }

  async listManagedContainers(): Promise<ContainerInfo[]> {
    const pods = await this.listPodsBySelector(this.managedSelector());
    return pods.map((pod) => this.podToContainerInfo(this.jobNameFromPod(pod) ?? pod.metadata?.name ?? '', pod));
  }

  async listManagedContainersWithLabels(): Promise<ManagedContainerWithLabels[]> {
    const pods = await this.listPodsBySelector(this.managedSelector());
    return pods.map((pod) => ({
      ...this.podToContainerInfo(this.jobNameFromPod(pod) ?? pod.metadata?.name ?? '', pod),
      labels: {
        ...(pod.metadata?.labels ?? {}),
        ...(pod.metadata?.annotations ?? {}),
      },
    }));
  }

  async getContainerExitCode(containerId: string): Promise<number | null> {
    const pod = await this.findPod(containerId);
    const terminated = pod?.status?.containerStatuses?.find((status) => status.state?.terminated)?.state?.terminated;
    return terminated?.exitCode ?? null;
  }

  async isContainerAlive(containerId: string): Promise<boolean> {
    const pod = await this.findPod(containerId);
    if (!pod) return false;
    return isAliveContainerStatus(normalizeKubernetesPodStatus(pod));
  }

  async ensureNetwork(): Promise<void> {
    return;
  }

  private async requestJson<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const text = await this.requestText(method, path, body);
    return text.length > 0 ? JSON.parse(text) as T : {} as T;
  }

  private async requestText(method: string, path: string, body?: unknown): Promise<string> {
    const token = await this.tokenPromise;
    const ca = await this.caPromise;
    const payload = body === undefined ? undefined : JSON.stringify(body);

    return new Promise<string>((resolve, reject) => {
      const req = httpsRequest({
        host: this.apiHost,
        port: Number(this.apiPort),
        method,
        path,
        ca,
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 0) >= 400) {
            let message = text;
            try {
              const status = JSON.parse(text) as KubeStatus;
              message = status.message || status.reason || text;
            } catch {
              // keep raw response text
            }
            reject(statusCodeError(res.statusCode ?? 500, message));
            return;
          }
          resolve(text);
        });
      });

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  private async listPodsBySelector(selector: string): Promise<KubePod[]> {
    const namespace = await this.namespacePromise;
    const list = await this.requestJson<KubePodList>(
      'GET',
      `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(selector)}`,
    );
    return list.items ?? [];
  }

  private managedSelector(): string {
    return `ctxmill.managed=true,${CONTAINER_SCOPE_LABEL}=${this.scopeId}`;
  }

  private async findPod(containerId: string): Promise<KubePod | null> {
    return await this.findPodBySelector(`job-name=${containerId},${CONTAINER_SCOPE_LABEL}=${this.scopeId}`)
      ?? await this.findPodBySelector(`job-name=${containerId}`);
  }

  private async findPodBySelector(selector: string): Promise<KubePod | null> {
    const pods = await this.listPodsBySelector(selector);
    return pods[0] ?? null;
  }

  private async waitForPod(jobName: string): Promise<KubePod> {
    const deadline = Date.now() + this.podReadyTimeoutMs;
    let lastPod: KubePod | null = null;

    while (Date.now() < deadline) {
      const pod = await this.findPod(jobName);
      lastPod = pod;
      if (pod?.status?.phase === 'Running' && pod.status.podIP) {
        return pod;
      }
      if (pod?.status?.phase === 'Failed' || pod?.status?.phase === 'Succeeded') {
        throw new Error(`Sandbox pod ${pod.metadata?.name ?? jobName} exited before becoming ready`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`Timed out waiting for sandbox pod for Job ${jobName}; last phase=${lastPod?.status?.phase ?? 'missing'}`);
  }

  private async deleteJob(jobName: string): Promise<void> {
    const namespace = await this.namespacePromise;
    let jobDeleteError: unknown;
    try {
      await this.requestJson(
        'DELETE',
        `/apis/batch/v1/namespaces/${namespace}/jobs/${jobName}?propagationPolicy=Foreground`,
        {
          apiVersion: 'v1',
          kind: 'DeleteOptions',
          propagationPolicy: 'Foreground',
        },
      );
    } catch (err) {
      if (!(err instanceof KubernetesApiError) || err.statusCode !== 404) {
        jobDeleteError = err;
      }
    }

    if (jobDeleteError) {
      throw jobDeleteError;
    }
  }

  private podToContainerInfo(jobName: string, pod: KubePod): ContainerInfo {
    const labels = pod.metadata?.labels ?? {};
    const annotations = pod.metadata?.annotations ?? {};
    return {
      containerId: jobName,
      containerName: pod.metadata?.name ?? jobName,
      sessionId: labels['ctxmill.session-id'] ?? '',
      agentId: labels['ctxmill.agent-id'] ?? '',
      harnessName: labels['ctxmill.harness'] ?? '',
      status: normalizeKubernetesPodStatus(pod),
      startedAt: annotations['ctxmill.started-at'] ? new Date(annotations['ctxmill.started-at']) : undefined,
      networkIp: pod.status?.podIP,
    };
  }

  private jobNameFromPod(pod: KubePod): string | undefined {
    return pod.metadata?.labels?.['job-name'];
  }

  private async workspaceDirFor(containerId: string): Promise<string | undefined> {
    const recorded = this.records.get(containerId)?.workspaceDir;
    if (recorded) return recorded;

    const pod = await this.findPod(containerId);
    const labels = pod?.metadata?.labels;
    const sessionId = labels?.['ctxmill.session-id'];
    const conversationId = labels?.['ctxmill.conversation-id'];
    const agentId = labels?.['ctxmill.agent-id'];
    if (!sessionId) return undefined;

    if (agentId && conversationId) {
      const conversationWorkspaceDir = join(this.dataHostPathRoot, 'agents', agentId, 'conversations', conversationId, 'workspace');
      try {
        await fs.access(conversationWorkspaceDir);
        return conversationWorkspaceDir;
      } catch {
        // fall through to legacy session workspace
      }
    }

    if (agentId) {
      const sessionWorkspaceDir = join(this.dataHostPathRoot, 'agents', agentId, 'sessions', sessionId, 'workspace');
      try {
        await fs.access(sessionWorkspaceDir);
        return sessionWorkspaceDir;
      } catch {
        // fall through to sandbox-empty
      }
    }

    const emptyWorkspaceDir = join(this.dataHostPathRoot, 'sandbox-empty', sessionId);
    try {
      await fs.access(emptyWorkspaceDir);
      return emptyWorkspaceDir;
    } catch {
      return undefined;
    }
  }

  private async createWorkspaceArchive(workspaceDir: string): Promise<Buffer> {
    const entries = await this.collectWorkspaceEntries(workspaceDir);
    if (entries.length === 0) return Buffer.alloc(0);

    const pack = tar.pack();
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
      pack.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      pack.on('end', () => resolve(Buffer.concat(chunks)));
      pack.on('error', reject);
    });

    for (const entry of entries) {
      const data = await fs.readFile(join(workspaceDir, entry));
      pack.entry({ name: entry, size: data.length, type: 'file' }, data);
    }
    pack.finalize();

    return done;
  }

  private async collectWorkspaceEntries(root: string): Promise<string[]> {
    const out: string[] = [];
    await this.collectWorkspaceEntriesInto(root, '', out);
    return out;
  }

  private async collectWorkspaceEntriesInto(root: string, relativeDir: string, out: string[]): Promise<void> {
    const dir = join(root, relativeDir);
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const child = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (!shouldIncludeWorkspaceRelativePath(child)) {
        continue;
      }
      if (entry.isDirectory()) {
        await this.collectWorkspaceEntriesInto(root, child, out);
      } else if (entry.isFile()) {
        out.push(child);
      }
    }
  }

  private async extractArchiveToWorkspace(archive: Buffer, workspaceDir: string): Promise<void> {
    await fs.mkdir(workspaceDir, { recursive: true });
    const workspaceRoot = resolve(workspaceDir);
    const extract = tar.extract();

    await new Promise<void>((resolveDone, rejectDone) => {
      extract.on('entry', (header, stream, next) => {
        let name: string;
        try {
          name = assertSafeWorkspaceArchiveEntry(header);
        } catch (err) {
          stream.resume();
          rejectDone(err instanceof Error ? err : new Error(String(err)));
          return;
        }

        const target = resolve(workspaceRoot, name);
        if (!target.startsWith(`${workspaceRoot}/`)) {
          stream.resume();
          rejectDone(new Error(`Workspace archive rejected unsafe path: ${header.name}`));
          return;
        }

        if (header.type === 'directory') {
          fs.mkdir(target, { recursive: true }).then(() => {
            stream.resume();
            next();
          }, rejectDone);
          return;
        }

        fs.mkdir(dirname(target), { recursive: true }).then(() => {
          const output = createWriteStream(target);
          stream.pipe(output);
          output.on('finish', next);
          output.on('error', rejectDone);
        }, rejectDone);
      });
      extract.on('finish', () => resolveDone());
      extract.on('error', rejectDone);
      Readable.from(archive).pipe(extract);
    });
  }
}
