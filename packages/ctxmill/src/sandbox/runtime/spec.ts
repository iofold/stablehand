import { join } from 'node:path';
import { CONTAINER_SCOPE_LABEL } from '../container-scope.js';

export const STARTUP_GRACE_MS_LABEL = 'ctxmill.startup-grace-ms';
export const DEFAULT_CONTAINER_STARTUP_GRACE_MS = 90_000;

const WORKSPACE_ROOT = '/workspace';
const HARNESS_MEMORY_FLOOR: ReadonlyMap<string, number> = new Map([
  ['claude-agents', 2048],
  ['pi-agent', 2048],
]);

export interface SandboxRuntimeDefaults {
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
  timeoutSec: number;
}

export interface SandboxRuntimeCreateOptions {
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

export interface SandboxRuntimeResources {
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
  timeoutSec: number;
}

export interface DockerContainerSpecInput {
  options: SandboxRuntimeCreateOptions;
  imagePrefix: string;
  scopeId: string;
  networkName: string;
  defaults: SandboxRuntimeDefaults;
  startupGraceMs: number;
  startedAtIso: string;
  orchestratorUrl: string;
  dataVolume?: string;
  dataRoot?: string;
  sandboxOtelEnv?: string[];
}

export interface DockerContainerSpec {
  containerName: string;
  resources: SandboxRuntimeResources;
  createOptions: {
    Image: string;
    name: string;
    Labels: Record<string, string>;
    HostConfig: Record<string, unknown>;
    Env: string[];
  };
}

export interface KubernetesJobSpecInput {
  options: SandboxRuntimeCreateOptions;
  namespace: string;
  imagePrefix: string;
  scopeId: string;
  defaults: SandboxRuntimeDefaults;
  startupGraceMs: number;
  startedAtIso: string;
  orchestratorUrl: string;
  dataHostPathRoot: string;
  sandboxOtelEnv?: string[];
}

export interface KubernetesJobManifest {
  apiVersion: 'batch/v1';
  kind: 'Job';
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
  };
  spec: {
    backoffLimit: number;
    template: {
      metadata: {
        labels: Record<string, string>;
        annotations: Record<string, string>;
      };
      spec: {
        restartPolicy: 'Never';
        automountServiceAccountToken: false;
        terminationGracePeriodSeconds: number;
        containers: Array<{
          name: 'sandbox';
          image: string;
          imagePullPolicy: 'IfNotPresent';
          ports: Array<{ name: string; containerPort: number }>;
          resources: {
            requests: { cpu: string; memory: string };
            limits: { cpu: string; memory: string };
          };
          env: Array<{ name: string; value: string }>;
          volumeMounts: Array<{ name: string; mountPath: string }>;
        }>;
        volumes: Array<{
          name: string;
          hostPath: { path: string; type: 'DirectoryOrCreate' };
        }>;
      };
    };
  };
}

export interface KubernetesJobSpec {
  jobName: string;
  workspaceHostPath: string;
  resources: SandboxRuntimeResources;
  manifest: KubernetesJobManifest;
}

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

export function sanitizeKubernetesName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52);
}

function cpuToQuantity(cpus: number): string {
  return `${Math.max(1, Math.round(cpus * 1000))}m`;
}

function resolveResources(
  options: SandboxRuntimeCreateOptions,
  defaults: SandboxRuntimeDefaults,
): SandboxRuntimeResources {
  const cpus = options.cpus ?? defaults.cpus;
  const harnessFloor = HARNESS_MEMORY_FLOOR.get(options.harnessName) ?? 0;
  const memoryMb = Math.max(options.memoryMb ?? defaults.memoryMb, harnessFloor);
  const pidsLimit = options.pidsLimit ?? defaults.pidsLimit;
  const timeoutSec = options.timeoutSec ?? defaults.timeoutSec;
  return { cpus, memoryMb, pidsLimit, timeoutSec };
}

function imageName(imagePrefix: string, harnessName: string): string {
  return `${imagePrefix}-${harnessName}:latest`;
}

function commonRuntimeLabels(
  options: SandboxRuntimeCreateOptions,
  scopeId: string,
): Record<string, string> {
  return {
    'ctxmill.managed': 'true',
    [CONTAINER_SCOPE_LABEL]: scopeId,
    'ctxmill.session-id': options.sessionId,
    ...(options.conversationId ? { 'ctxmill.conversation-id': options.conversationId } : {}),
    'ctxmill.agent-id': options.agentId,
    'ctxmill.harness': options.harnessName,
  };
}

function runtimeAnnotations(
  resources: SandboxRuntimeResources,
  startedAtIso: string,
  startupGraceMs: number,
): Record<string, string> {
  return {
    'ctxmill.started-at': startedAtIso,
    'ctxmill.timeout': String(resources.timeoutSec),
    [STARTUP_GRACE_MS_LABEL]: String(startupGraceMs),
  };
}

function sandboxEnv(
  options: SandboxRuntimeCreateOptions,
  resources: SandboxRuntimeResources,
  orchestratorUrl: string,
  sandboxOtelEnv?: string[],
): string[] {
  return [
    `NODE_OPTIONS=--max-old-space-size=${Math.floor(resources.memoryMb * 0.9)}`,
    ...(sandboxOtelEnv ?? buildSandboxOtelEnv(options.harnessName)),
    'SANDBOX_PORT=50051',
    `CTXMILL_HARNESS=${options.harnessName}`,
    `ORCHESTRATOR_URL=${orchestratorUrl}`,
    ...Object.entries(options.secrets ?? {}).map(([key, value]) => `${key}=${value}`),
  ];
}

function kubernetesEnv(entries: string[]): Array<{ name: string; value: string }> {
  return entries.map((entry) => {
    const separator = entry.indexOf('=');
    return {
      name: entry.slice(0, separator),
      value: entry.slice(separator + 1),
    };
  });
}

export function buildDockerContainerSpec(input: DockerContainerSpecInput): DockerContainerSpec {
  const resources = resolveResources(input.options, input.defaults);
  const containerName = `ctxmill-run-${input.options.sessionId}`;
  const dataRoot = input.dataRoot ?? '/app/project/.ctxmill';
  const binds: string[] = [];
  const volumeMounts: unknown[] = [];

  if (input.options.workspaceDir && input.dataVolume && input.options.workspaceDir.startsWith(dataRoot)) {
    const subpath = input.options.workspaceDir.slice(dataRoot.length + 1);
    volumeMounts.push({
      Type: 'volume',
      Source: input.dataVolume,
      Target: WORKSPACE_ROOT,
      ReadOnly: false,
      VolumeOptions: { Subpath: subpath },
    });
  } else if (input.options.workspaceDir) {
    binds.push(`${input.options.workspaceDir}:${WORKSPACE_ROOT}:rw`);
  }

  return {
    containerName,
    resources,
    createOptions: {
      Image: imageName(input.imagePrefix, input.options.harnessName),
      name: containerName,
      Labels: {
        ...commonRuntimeLabels(input.options, input.scopeId),
        ...runtimeAnnotations(resources, input.startedAtIso, input.startupGraceMs),
      },
      HostConfig: {
        CpuPeriod: 100_000,
        CpuQuota: resources.cpus * 100_000,
        Memory: resources.memoryMb * 1024 * 1024,
        MemorySwap: resources.memoryMb * 1024 * 1024,
        PidsLimit: resources.pidsLimit,
        NetworkMode: input.networkName,
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
      },
      Env: sandboxEnv(input.options, resources, input.orchestratorUrl, input.sandboxOtelEnv),
    },
  };
}

export function buildKubernetesJobSpec(input: KubernetesJobSpecInput): KubernetesJobSpec {
  const resources = resolveResources(input.options, input.defaults);
  const jobName = `ctxmill-run-${sanitizeKubernetesName(input.options.sessionId)}`;
  const labels = {
    'app.kubernetes.io/name': 'ctxmill-sandbox',
    'app.kubernetes.io/part-of': 'ctxmill',
    ...commonRuntimeLabels(input.options, input.scopeId),
  };
  const annotations = runtimeAnnotations(resources, input.startedAtIso, input.startupGraceMs);
  const workspaceHostPath = input.options.workspaceDir
    ?? join(input.dataHostPathRoot, 'sandbox-empty', input.options.sessionId);
  const env = kubernetesEnv(sandboxEnv(
    input.options,
    resources,
    input.orchestratorUrl,
    input.sandboxOtelEnv,
  ));

  return {
    jobName,
    workspaceHostPath,
    resources,
    manifest: {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: jobName, namespace: input.namespace, labels, annotations },
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
                image: imageName(input.imagePrefix, input.options.harnessName),
                imagePullPolicy: 'IfNotPresent',
                ports: [
                  { name: 'grpc', containerPort: 50051 },
                  { name: 'tools', containerPort: 8080 },
                ],
                resources: {
                  requests: {
                    cpu: cpuToQuantity(resources.cpus),
                    memory: `${resources.memoryMb}Mi`,
                  },
                  limits: {
                    cpu: cpuToQuantity(resources.cpus),
                    memory: `${resources.memoryMb}Mi`,
                  },
                },
                env,
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
    },
  };
}
