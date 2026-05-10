import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import * as tar from 'tar-stream';

import {
  buildSandboxOtelEnv,
  ContainerSemaphore,
  resolveContainerStartupGraceMs,
  STARTUP_GRACE_MS_LABEL,
  type ContainerInfo,
  type ContainerMetrics,
  type CreateContainerOptions,
  type ManagedContainerWithLabels,
  type SandboxContainerManager,
  type WorkspaceDiffSnapshot,
} from './container-manager.js';
import { CONTAINER_SCOPE_LABEL, resolveContainerScopeId } from './container-scope.js';

const TAG = '[KubernetesContainerManager]';
const WORKSPACE_ROOT = '/workspace';
const SERVICE_ACCOUNT_ROOT = '/var/run/secrets/kubernetes.io/serviceaccount';
const HARNESS_MEMORY_FLOOR: ReadonlyMap<string, number> = new Map([
  ['claude-agents', 2048],
  ['pi-agent', 2048],
]);

interface KubernetesContainerManagerOptions {
  namespace?: string;
  imagePrefix?: string;
  defaultCpus?: number;
  defaultMemoryMb?: number;
  defaultPidsLimit?: number;
  defaultTimeoutSec?: number;
  maxGlobalContainers?: number;
  queueTimeoutMs?: number;
  dataHostPathRoot?: string;
  podReadyTimeoutMs?: number;
  startupGraceMs?: number;
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

function sanitizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52);
}

function cpuToQuantity(cpus: number): string {
  return `${Math.max(1, Math.round(cpus * 1000))}m`;
}

function statusCodeError(statusCode: number, message: string): Error {
  return Object.assign(new KubernetesApiError(statusCode, message), { statusCode });
}

function kubePhaseToStatus(pod: KubePod | undefined): ContainerInfo['status'] {
  if (!pod) return 'created';
  if (pod.metadata?.deletionTimestamp) return 'removed';
  switch ((pod.status?.phase ?? '').toLowerCase()) {
    case 'pending':
      return 'created';
    case 'running':
      return 'running';
    case 'succeeded':
    case 'failed':
      return 'stopped';
    default:
      return 'created';
  }
}

function isAliveStatus(status: ContainerInfo['status']): boolean {
  return status === 'created' || status === 'running' || status === 'paused';
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

export class KubernetesContainerManager implements SandboxContainerManager {
  private readonly namespacePromise: Promise<string>;
  private readonly apiHost: string;
  private readonly apiPort: string;
  private readonly imagePrefix: string;
  private readonly scopeId: string;
  private readonly defaultCpus: number;
  private readonly defaultMemoryMb: number;
  private readonly defaultTimeoutSec: number;
  private readonly dataHostPathRoot: string;
  private readonly podReadyTimeoutMs: number;
  private readonly startupGraceMs: number;
  private readonly semaphore: ContainerSemaphore;
  private readonly maxGlobalContainers: number;
  private readonly records = new Map<string, ContainerRecord>();
  private readonly containerStartTimes = new Map<string, number>();
  private readonly activeByHarness = new Map<string, number>();
  private totalCreated = 0;
  private completedCount = 0;
  private lifetimeSumMs = 0;
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
    this.defaultTimeoutSec = options.defaultTimeoutSec ?? 600;
    this.dataHostPathRoot = options.dataHostPathRoot ?? process.env.CTXMILL_K8S_DATA_HOST_PATH ?? process.env.CTXMILL_DATA_DIR ?? '/var/lib/ctxmill/data';
    this.podReadyTimeoutMs = options.podReadyTimeoutMs ?? envNumber('CTXMILL_K8S_POD_READY_TIMEOUT_MS') ?? 60_000;
    this.startupGraceMs = resolveContainerStartupGraceMs(
      options.startupGraceMs
        ?? envNumber('CTXMILL_CONTAINER_STARTUP_GRACE_MS')
        ?? this.podReadyTimeoutMs + 30_000,
    );
    this.maxGlobalContainers = options.maxGlobalContainers
      ?? envNumber('CTXMILL_MAX_CONTAINERS')
      ?? 20;
    this.semaphore = new ContainerSemaphore(this.maxGlobalContainers, options.queueTimeoutMs ?? 60_000);
    this.tokenPromise = fs.readFile(`${SERVICE_ACCOUNT_ROOT}/token`, 'utf8');
    this.caPromise = fs.readFile(`${SERVICE_ACCOUNT_ROOT}/ca.crt`);
  }

  async createContainer(opts: CreateContainerOptions): Promise<ContainerInfo> {
    await this.semaphore.acquire();
    let jobCreated = false;

    try {
      const namespace = await this.namespacePromise;
      const jobName = `ctxmill-run-${sanitizeName(opts.sessionId)}`;
      const memoryMb = Math.max(opts.memoryMb ?? this.defaultMemoryMb, HARNESS_MEMORY_FLOOR.get(opts.harnessName) ?? 0);
      const timeoutSec = opts.timeoutSec ?? this.defaultTimeoutSec;
      const labels = {
        'app.kubernetes.io/name': 'ctxmill-sandbox',
        'app.kubernetes.io/part-of': 'ctxmill',
        'ctxmill.managed': 'true',
        [CONTAINER_SCOPE_LABEL]: this.scopeId,
        'ctxmill.session-id': opts.sessionId,
        ...(opts.conversationId ? { 'ctxmill.conversation-id': opts.conversationId } : {}),
        'ctxmill.agent-id': opts.agentId,
        'ctxmill.harness': opts.harnessName,
      };
      const annotations = {
        'ctxmill.started-at': new Date().toISOString(),
        'ctxmill.timeout': String(timeoutSec),
        [STARTUP_GRACE_MS_LABEL]: String(this.startupGraceMs),
      };
      const workspaceHostPath = opts.workspaceDir ?? join(this.dataHostPathRoot, 'sandbox-empty', opts.sessionId);

      console.debug(`${TAG} creating sandbox Job ${jobName} in namespace ${namespace}`);

      await fs.mkdir(workspaceHostPath, { recursive: true });
      await this.requestJson('POST', `/apis/batch/v1/namespaces/${namespace}/jobs`, {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: jobName, namespace, labels, annotations },
        spec: {
          backoffLimit: 0,
          template: {
            metadata: { labels, annotations },
            spec: {
              restartPolicy: 'Never',
              automountServiceAccountToken: false,
              terminationGracePeriodSeconds: 10,
              containers: [
                {
                  name: 'sandbox',
                  image: `${this.imagePrefix}-${opts.harnessName}:latest`,
                  imagePullPolicy: 'IfNotPresent',
                  ports: [
                    { name: 'grpc', containerPort: 50051 },
                    { name: 'tools', containerPort: 8080 },
                  ],
                  resources: {
                    requests: {
                      cpu: cpuToQuantity(opts.cpus ?? this.defaultCpus),
                      memory: `${memoryMb}Mi`,
                    },
                    limits: {
                      cpu: cpuToQuantity(opts.cpus ?? this.defaultCpus),
                      memory: `${memoryMb}Mi`,
                    },
                  },
                  env: [
                    { name: 'NODE_OPTIONS', value: `--max-old-space-size=${Math.floor(memoryMb * 0.9)}` },
                    ...buildSandboxOtelEnv(opts.harnessName).map((entry) => {
                      const separator = entry.indexOf('=');
                      return {
                        name: entry.slice(0, separator),
                        value: entry.slice(separator + 1),
                      };
                    }),
                    { name: 'SANDBOX_PORT', value: '50051' },
                    { name: 'CTXMILL_HARNESS', value: opts.harnessName },
                    { name: 'ORCHESTRATOR_URL', value: process.env.ORCHESTRATOR_CALLBACK_URL || 'http://orchestrator:3001' },
                    ...Object.entries(opts.secrets ?? {}).map(([name, value]) => ({ name, value })),
                  ],
                  volumeMounts: [
                    { name: 'workspace', mountPath: WORKSPACE_ROOT },
                  ],
                },
              ],
              volumes: [
                {
                  name: 'workspace',
                  hostPath: {
                    path: workspaceHostPath,
                    type: 'DirectoryOrCreate',
                  },
                },
              ],
            },
          },
        },
      });

      this.records.set(jobName, {
        sessionId: opts.sessionId,
        agentId: opts.agentId,
        harnessName: opts.harnessName,
        workspaceDir: workspaceHostPath,
        startedAt: Date.now(),
      });
      this.containerStartTimes.set(jobName, Date.now());
      this.incrementHarness(opts.harnessName);
      this.totalCreated++;
      jobCreated = true;

      return {
        containerId: jobName,
        containerName: jobName,
        sessionId: opts.sessionId,
        agentId: opts.agentId,
        harnessName: opts.harnessName,
        status: 'created',
        startedAt: new Date(),
      };
    } finally {
      if (!jobCreated) {
        this.semaphore.release();
      }
    }
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
    this.releaseOwnedContainerSlot(containerId);
  }

  async removeContainer(containerId: string, _force?: boolean): Promise<void> {
    await this.deleteJob(containerId);
    this.releaseOwnedContainerSlot(containerId);
  }

  async extractWorkspaceDiff(containerId: string): Promise<WorkspaceDiffSnapshot | null> {
    const workspaceDir = await this.workspaceDirFor(containerId);
    if (!workspaceDir) return null;
    const archive = await this.createWorkspaceArchive(workspaceDir);
    return archive.length > 0 ? { archive, deletedPaths: [] } : null;
  }

  async extractContainerDiff(containerId: string): Promise<Buffer | null> {
    const snapshot = await this.extractWorkspaceDiff(containerId);
    return snapshot?.archive ?? null;
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

    for (const deletedPath of options?.deletedPaths ?? []) {
      const target = resolve(workspaceRoot, deletedPath);
      if (!target.startsWith(`${workspaceRoot}/`)) {
        throw new Error(`Workspace deletion rejected unsafe path: ${deletedPath}`);
      }
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
    return pod ? this.podToContainerInfo(this.jobNameFromPod(pod) ?? `ctxmill-run-${sanitizeName(sessionId)}`, pod) : null;
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

  async getContainerByLabel(label: string, value: string): Promise<ContainerInfo | null> {
    const pod = await this.findPodBySelector(`${label}=${value},${CONTAINER_SCOPE_LABEL}=${this.scopeId}`)
      ?? await this.findPodBySelector(`${label}=${value}`);
    return pod ? this.podToContainerInfo(this.jobNameFromPod(pod) ?? pod.metadata?.name ?? '', pod) : null;
  }

  async isContainerAlive(containerId: string): Promise<boolean> {
    const pod = await this.findPod(containerId);
    if (!pod) return false;
    return isAliveStatus(kubePhaseToStatus(pod));
  }

  async ensureNetwork(): Promise<void> {
    return;
  }

  getActiveCount(): number {
    return this.semaphore.getActive();
  }

  getQueuedCount(): number {
    return this.semaphore.getQueued();
  }

  getPeakCount(): number {
    return this.semaphore.getPeak();
  }

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
      averageLifetimeMs: this.completedCount > 0 ? Math.round(this.lifetimeSumMs / this.completedCount) : 0,
      maxGlobalContainers: this.maxGlobalContainers,
    };
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
      status: kubePhaseToStatus(pod),
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

  private incrementHarness(harnessName: string): void {
    this.activeByHarness.set(harnessName, (this.activeByHarness.get(harnessName) ?? 0) + 1);
  }

  private releaseOwnedContainerSlot(containerId: string): void {
    const record = this.records.get(containerId);
    if (!record) {
      return;
    }

    this.semaphore.release();
    const startTime = this.containerStartTimes.get(containerId);
    if (startTime !== undefined) {
      this.completedCount++;
      this.lifetimeSumMs += Date.now() - startTime;
      this.containerStartTimes.delete(containerId);
    }
    const current = this.activeByHarness.get(record.harnessName) ?? 0;
    if (current <= 1) {
      this.activeByHarness.delete(record.harnessName);
    } else {
      this.activeByHarness.set(record.harnessName, current - 1);
    }
    this.records.delete(containerId);
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
      if (entry.name === 'node_modules' || entry.name === '.cache' || entry.name === '.npm' || entry.name === '.bun') {
        continue;
      }
      const child = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
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
        const name = String(header.name ?? '').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
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
