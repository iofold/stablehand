import { join } from 'node:path';
import { CONTAINER_SCOPE_LABEL } from '../container-scope.js';
import { parsePositiveMs } from '../../util/timing.js';
import type { ContainerInfo, ContainerManagerOptions } from './types.js';

export const STARTUP_GRACE_MS_LABEL = 'stablehand.startup-grace-ms';
export const DEFAULT_CONTAINER_STARTUP_GRACE_MS = 90_000;

const WORKSPACE_ROOT = '/workspace';
const HARNESS_MEMORY_FLOOR: ReadonlyMap<string, number> = new Map([
  ['claude-agents', 2048],
  ['pi-agent', 2048],
]);

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
  /** The session's egress lease token; the sandbox presents it to the egress proxy (ctx-3aef). */
  egressLeaseToken?: string;
}

export interface SandboxRuntimeResources {
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
  timeoutSec: number;
}

export type SandboxRuntimeDefaults = SandboxRuntimeResources;

const DEFAULT_SANDBOX_RUNTIME_RESOURCES: Readonly<SandboxRuntimeResources> = {
  cpus: 1,
  memoryMb: 1024,
  pidsLimit: 256,
  timeoutSec: 600,
};

export function resolveSandboxRuntimeDefaults(
  options: ContainerManagerOptions = {},
): SandboxRuntimeDefaults {
  return {
    cpus: options.defaultCpus ?? DEFAULT_SANDBOX_RUNTIME_RESOURCES.cpus,
    memoryMb: options.defaultMemoryMb ?? DEFAULT_SANDBOX_RUNTIME_RESOURCES.memoryMb,
    pidsLimit: options.defaultPidsLimit ?? DEFAULT_SANDBOX_RUNTIME_RESOURCES.pidsLimit,
    timeoutSec: options.defaultTimeoutSec ?? DEFAULT_SANDBOX_RUNTIME_RESOURCES.timeoutSec,
  };
}

interface RuntimeContainerInfoInput {
  containerId: string;
  containerName: string;
  labels: Record<string, string>;
  status: ContainerInfo['status'];
  startedAt?: string;
  networkIp?: string;
}

export function runtimeLabelsToContainerInfo(input: RuntimeContainerInfoInput): ContainerInfo {
  return {
    containerId: input.containerId,
    containerName: input.containerName,
    sessionId: input.labels['stablehand.sandbox-session-id'] ?? '',
    agentId: input.labels['stablehand.agent-id'] ?? '',
    harnessName: input.labels['stablehand.harness'] ?? '',
    status: input.status,
    ...(input.startedAt ? { startedAt: new Date(input.startedAt) } : {}),
    ...(input.networkIp ? { networkIp: input.networkIp } : {}),
  };
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
  /** Volume holding the egress proxy's public CA; mounted read-only into every sandbox. */
  egressCaVolume?: string;
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
  imagePullPolicy?: KubernetesImagePullPolicy;
}

export type KubernetesImagePullPolicy = 'Always' | 'IfNotPresent' | 'Never';

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
          imagePullPolicy: KubernetesImagePullPolicy;
          ports: Array<{ name: string; containerPort: number }>;
          resources: {
            requests: { cpu: string; memory: string };
            limits: { cpu: string; memory: string };
          };
          env: Array<{ name: string; value: string }>;
          envFrom?: Array<{ secretRef: { name: string } }>;
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

export interface KubernetesSecretManifest {
  apiVersion: 'v1';
  kind: 'Secret';
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
  };
  type: 'Opaque';
  stringData: Record<string, string>;
}

export interface KubernetesJobSpec {
  jobName: string;
  workspaceHostPath: string;
  resources: SandboxRuntimeResources;
  manifest: KubernetesJobManifest;
  secretManifest?: KubernetesSecretManifest;
}

export function resolveContainerStartupGraceMs(explicitMs?: number): number {
  return parsePositiveMs(explicitMs)
    ?? parsePositiveMs(process.env.STABLEHAND_CONTAINER_STARTUP_GRACE_MS)
    ?? DEFAULT_CONTAINER_STARTUP_GRACE_MS;
}

export interface SandboxOtelIdentity {
  sessionId: string;
  agentId: string;
  conversationId?: string;
}

function otelResourceValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/=/g, '\\=');
}

export function buildSandboxOtelEnv(
  harnessName: string,
  identity?: SandboxOtelIdentity,
): string[] {
  const tracesExporter = process.env.STABLEHAND_SANDBOX_OTEL_TRACES_EXPORTER
    ?? process.env.OTEL_TRACES_EXPORTER
    ?? 'none';
  const metricsExporter = process.env.STABLEHAND_SANDBOX_OTEL_METRICS_EXPORTER
    ?? process.env.OTEL_METRICS_EXPORTER
    ?? 'none';
  const logsExporter = process.env.STABLEHAND_SANDBOX_OTEL_LOGS_EXPORTER
    ?? process.env.OTEL_LOGS_EXPORTER
    ?? 'none';
  const endpoint = process.env.STABLEHAND_SANDBOX_OTEL_EXPORTER_OTLP_ENDPOINT
    ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ?? 'http://host.docker.internal:4318';
  const protocol = process.env.STABLEHAND_SANDBOX_OTEL_EXPORTER_OTLP_PROTOCOL
    ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL
    ?? 'http/protobuf';
  const resourceDetectors = process.env.STABLEHAND_SANDBOX_OTEL_NODE_RESOURCE_DETECTORS
    ?? process.env.OTEL_NODE_RESOURCE_DETECTORS
    ?? 'env,host,os';
  const logLevel = process.env.STABLEHAND_SANDBOX_OTEL_LOG_LEVEL
    ?? process.env.OTEL_LOG_LEVEL
    ?? 'error';
  const serviceNamePrefix = process.env.STABLEHAND_SANDBOX_OTEL_SERVICE_NAME_PREFIX
    ?? 'stablehand-sandbox';
  const baseResourceAttributes = process.env.STABLEHAND_SANDBOX_OTEL_RESOURCE_ATTRIBUTES
    ?? process.env.OTEL_RESOURCE_ATTRIBUTES
    ?? 'deployment.environment=local,service.namespace=stablehand';
  const resourceAttributes = [
    baseResourceAttributes,
    'stablehand.component=sandbox',
    `stablehand.harness=${harnessName}`,
    ...(identity
      ? [
          `stablehand.session.id=${otelResourceValue(identity.sessionId)}`,
          `stablehand.agent.id=${otelResourceValue(identity.agentId)}`,
          ...(identity.conversationId
            ? [`stablehand.conversation.id=${otelResourceValue(identity.conversationId)}`]
            : []),
        ]
      : []),
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

export function kubernetesSandboxSecretName(jobName: string): string {
  return sanitizeKubernetesName(`${jobName}-env`);
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
  // Deploys that import commit-tagged harness images pin the tag via
  // STABLEHAND_SANDBOX_IMAGE_TAG (ctx-wvq6); local stacks use :latest.
  const tag = process.env.STABLEHAND_SANDBOX_IMAGE_TAG || 'latest';
  return `${imagePrefix}-${harnessName}:${tag}`;
}

function commonRuntimeLabels(
  options: SandboxRuntimeCreateOptions,
  scopeId: string,
): Record<string, string> {
  return {
    'stablehand.managed': 'true',
    [CONTAINER_SCOPE_LABEL]: scopeId,
    'stablehand.sandbox-session-id': options.sessionId,
    ...(options.conversationId ? { 'stablehand.conversation-id': options.conversationId } : {}),
    'stablehand.agent-id': options.agentId,
    'stablehand.harness': options.harnessName,
  };
}

function runtimeAnnotations(
  resources: SandboxRuntimeResources,
  startedAtIso: string,
  startupGraceMs: number,
): Record<string, string> {
  return {
    'stablehand.started-at': startedAtIso,
    'stablehand.timeout': String(resources.timeoutSec),
    [STARTUP_GRACE_MS_LABEL]: String(startupGraceMs),
  };
}

/** Where the egress proxy's public CA is mounted inside a sandbox. */
export const SANDBOX_EGRESS_CA_DIR = '/etc/stablehand/egress-ca';
export const SANDBOX_EGRESS_CA_PATH = `${SANDBOX_EGRESS_CA_DIR}/egress-ca.pem`;
/** Hosts a sandbox reaches directly on the internal agents network, never via the proxy. */
export const SANDBOX_EGRESS_DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1,orchestrator,minio,litellm,host.docker.internal';

/** The proxy variables that carry a session's egress lease. */
export const SANDBOX_PROXY_ENV_KEYS: ReadonlySet<string> = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
]);

export interface SandboxEgressLease {
  sessionId: string;
  token: string;
}

type EgressEnv = Readonly<Record<string, string | undefined>>;

/** Hosts a sandbox reaches directly instead of through the egress proxy. */
export function resolveSandboxNoProxy(env: EgressEnv = process.env): string {
  return env.STABLEHAND_SANDBOX_NO_PROXY?.trim() || SANDBOX_EGRESS_DEFAULT_NO_PROXY;
}

/**
 * The proxy URL with the session lease as its credentials (`http://<sessionId>:<token>@host:port`),
 * which is how curl, git, Python, Node and grpc-js send `Proxy-Authorization`. A URL that cannot
 * carry credentials is returned unchanged; the lease listener then answers 407, so the
 * misconfiguration shows instead of passing silently.
 */
export function sandboxProxyUrl(proxyUrl: string, lease?: SandboxEgressLease): string {
  if (!lease || !URL.canParse(proxyUrl)) return proxyUrl;
  const url = new URL(proxyUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return proxyUrl;
  return `${url.protocol}//${encodeURIComponent(lease.sessionId)}:${encodeURIComponent(lease.token)}@${url.host}`;
}

function sandboxEgressLease(options: SandboxRuntimeCreateOptions): SandboxEgressLease | undefined {
  return options.egressLeaseToken
    ? { sessionId: options.sessionId, token: options.egressLeaseToken }
    : undefined;
}

/**
 * Sandbox egress environment (ctx-2ctd). When `STABLEHAND_SANDBOX_EGRESS_PROXY_URL` is set
 * the sandbox's only route out is the egress proxy: every HTTP client family reads the
 * proxy and the deployment CA from these variables (Node fetch and undici via
 * NODE_USE_ENV_PROXY, grpc-js via https_proxy/no_proxy, curl, git, Python requests).
 * With a lease (ctx-3aef) the proxy URL carries the session's credentials, so the proxy
 * applies that session's agent egress rules.
 * The browse tool wires Chromium separately from `STABLEHAND_EGRESS_CA` and the proxy URL.
 */
export function buildSandboxEgressEnv(
  env: EgressEnv = process.env,
  lease?: SandboxEgressLease,
): string[] {
  const configuredUrl = env.STABLEHAND_SANDBOX_EGRESS_PROXY_URL?.trim();
  if (!configuredUrl) return [];
  const proxyUrl = sandboxProxyUrl(configuredUrl, lease);
  const noProxy = resolveSandboxNoProxy(env);
  return [
    `HTTP_PROXY=${proxyUrl}`,
    `HTTPS_PROXY=${proxyUrl}`,
    `http_proxy=${proxyUrl}`,
    `https_proxy=${proxyUrl}`,
    `NO_PROXY=${noProxy}`,
    `no_proxy=${noProxy}`,
    'NODE_USE_ENV_PROXY=1',
    `STABLEHAND_EGRESS_CA=${SANDBOX_EGRESS_CA_PATH}`,
    `NODE_EXTRA_CA_CERTS=${SANDBOX_EGRESS_CA_PATH}`,
    `SSL_CERT_FILE=${SANDBOX_EGRESS_CA_PATH}`,
    `REQUESTS_CA_BUNDLE=${SANDBOX_EGRESS_CA_PATH}`,
    `CURL_CA_BUNDLE=${SANDBOX_EGRESS_CA_PATH}`,
    `GIT_SSL_CAINFO=${SANDBOX_EGRESS_CA_PATH}`,
  ];
}

function envKey(entry: string): string {
  return entry.slice(0, entry.indexOf('='));
}

/** Egress variables that carry the session lease; Kubernetes keeps them in the per-Job Secret. */
function leasedEgressEnv(options: SandboxRuntimeCreateOptions): string[] {
  const lease = sandboxEgressLease(options);
  return lease
    ? buildSandboxEgressEnv(process.env, lease).filter((entry) => SANDBOX_PROXY_ENV_KEYS.has(envKey(entry)))
    : [];
}

function sandboxEnv(
  options: SandboxRuntimeCreateOptions,
  resources: SandboxRuntimeResources,
  orchestratorUrl: string,
  sandboxOtelEnv?: string[],
  includeSecrets = true,
): string[] {
  const egressEnv = buildSandboxEgressEnv(process.env, sandboxEgressLease(options));
  const leased = new Set(leasedEgressEnv(options).map(envKey));
  return [
    `NODE_OPTIONS=--max-old-space-size=${Math.floor(resources.memoryMb * 0.9)}`,
    ...(sandboxOtelEnv ?? buildSandboxOtelEnv(options.harnessName, {
      sessionId: options.sessionId,
      agentId: options.agentId,
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    })),
    'SANDBOX_PORT=50051',
    `STABLEHAND_HARNESS=${options.harnessName}`,
    `ORCHESTRATOR_URL=${orchestratorUrl}`,
    // ADR 025: how long a turn outlives an unreachable orchestrator.
    ...(process.env.STABLEHAND_TURN_ORPHAN_GRACE_MS
      ? [`STABLEHAND_TURN_ORPHAN_GRACE_MS=${process.env.STABLEHAND_TURN_ORPHAN_GRACE_MS}`]
      : []),
    ...(includeSecrets ? egressEnv : egressEnv.filter((entry) => !leased.has(envKey(entry)))),
    ...(includeSecrets
      ? Object.entries(options.secrets ?? {}).map(([key, value]) => `${key}=${value}`)
      : []),
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
  const containerName = `stablehand-sandbox-${input.options.sessionId}`;
  const dataRoot = input.dataRoot ?? '/app/project/.stablehand';
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

  if (input.egressCaVolume) {
    volumeMounts.push({
      Type: 'volume',
      Source: input.egressCaVolume,
      Target: SANDBOX_EGRESS_CA_DIR,
      ReadOnly: true,
    });
  }
  // On the internal agents network the embedded DNS cannot forward to the internet, so a
  // client that resolves names itself instead of using the proxy would otherwise hang for
  // minutes before failing. Fail fast; proxied clients never resolve remote names locally.
  const egressDnsOptions = buildSandboxEgressEnv().length > 0 ? ['timeout:2', 'attempts:1'] : undefined;

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
        ...(egressDnsOptions ? { DnsOptions: egressDnsOptions } : {}),
      },
      Env: sandboxEnv(input.options, resources, input.orchestratorUrl, input.sandboxOtelEnv),
    },
  };
}

export function buildKubernetesJobSpec(input: KubernetesJobSpecInput): KubernetesJobSpec {
  const resources = resolveResources(input.options, input.defaults);
  const jobName = `stablehand-sandbox-${sanitizeKubernetesName(input.options.sessionId)}`;
  const labels = {
    'app.kubernetes.io/name': 'stablehand-sandbox',
    'app.kubernetes.io/part-of': 'stablehand',
    ...commonRuntimeLabels(input.options, input.scopeId),
  };
  const annotations = runtimeAnnotations(resources, input.startedAtIso, input.startupGraceMs);
  const workspaceHostPath = input.options.workspaceDir
    ?? join(input.dataHostPathRoot, 'sandbox-empty', input.options.sessionId);
  const secretEntries = [
    ...Object.entries(input.options.secrets ?? {}),
    ...leasedEgressEnv(input.options).map((entry): [string, string] => [
      envKey(entry),
      entry.slice(entry.indexOf('=') + 1),
    ]),
  ];
  const secretName = kubernetesSandboxSecretName(jobName);
  const env = kubernetesEnv(sandboxEnv(
    input.options,
    resources,
    input.orchestratorUrl,
    input.sandboxOtelEnv,
    false,
  ));
  const secretManifest = secretEntries.length > 0
    ? {
        apiVersion: 'v1' as const,
        kind: 'Secret' as const,
        metadata: { name: secretName, namespace: input.namespace, labels },
        type: 'Opaque' as const,
        stringData: Object.fromEntries(secretEntries),
      }
    : undefined;

  return {
    jobName,
    workspaceHostPath,
    resources,
    ...(secretManifest ? { secretManifest } : {}),
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
                imagePullPolicy: input.imagePullPolicy ?? 'IfNotPresent',
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
                ...(secretManifest
                  ? { envFrom: [{ secretRef: { name: secretName } }] }
                  : {}),
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
