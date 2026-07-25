export interface KubernetesNodeQuantity {
  name: string;
  cpu: string;
  memory: string;
}

export interface KubernetesPodMetric {
  name: string;
  labels: Record<string, string>;
  containers: Array<{
    name: string;
    cpu: string;
    memory: string;
  }>;
}

export interface KubernetesResourceSample {
  timestamp: string;
  nodeAllocatable: KubernetesNodeQuantity[];
  nodeMetrics: KubernetesNodeQuantity[];
  podMetrics: KubernetesPodMetric[];
  pendingSandboxPods: number;
  activeSandboxJobs: number;
}

export interface KubernetesResourceSummary {
  samples: number;
  peakNodeCpuPercent: number;
  peakNodeMemoryPercent: number;
  peakSandboxPods: number;
  peakPendingSandboxPods: number;
  peakActiveSandboxJobs: number;
  peakSandboxCpuCores: number;
  peakSandboxMemoryBytes: number;
  peakOrchestratorCpuCores: number;
  peakOrchestratorMemoryBytes: number;
}

const CPU_FACTORS: Readonly<Record<string, number>> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  '': 1,
};

const MEMORY_FACTORS: Readonly<Record<string, number>> = {
  '': 1,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  K: 1_000,
  M: 1_000 ** 2,
  G: 1_000 ** 3,
  T: 1_000 ** 4,
};

function parseQuantity(
  value: string,
  pattern: RegExp,
  factors: Readonly<Record<string, number>>,
  kind: string,
): number {
  const match = pattern.exec(value.trim());
  if (!match) throw new Error(`Invalid Kubernetes ${kind} quantity: ${value}`);
  const factor = factors[match[2] ?? ''];
  if (factor === undefined) {
    throw new Error(`Unsupported Kubernetes ${kind} unit: ${match[2]}`);
  }
  return Number(match[1]) * factor;
}

export function parseCpuCores(value: string): number {
  return parseQuantity(value, /^([0-9]+(?:\.[0-9]+)?)(n|u|m)?$/, CPU_FACTORS, 'CPU');
}

export function parseMemoryBytes(value: string): number {
  return parseQuantity(
    value,
    /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/,
    MEMORY_FACTORS,
    'memory',
  );
}

export function summarizeKubernetesSamples(
  samples: readonly KubernetesResourceSample[],
): KubernetesResourceSummary {
  const summary: KubernetesResourceSummary = {
    samples: samples.length,
    peakNodeCpuPercent: 0,
    peakNodeMemoryPercent: 0,
    peakSandboxPods: 0,
    peakPendingSandboxPods: 0,
    peakActiveSandboxJobs: 0,
    peakSandboxCpuCores: 0,
    peakSandboxMemoryBytes: 0,
    peakOrchestratorCpuCores: 0,
    peakOrchestratorMemoryBytes: 0,
  };

  for (const sample of samples) {
    const allocatable = new Map(
      sample.nodeAllocatable.map((node) => [node.name, node]),
    );
    for (const usage of sample.nodeMetrics) {
      const capacity = allocatable.get(usage.name);
      if (!capacity) continue;
      summary.peakNodeCpuPercent = Math.max(
        summary.peakNodeCpuPercent,
        (parseCpuCores(usage.cpu) / parseCpuCores(capacity.cpu)) * 100,
      );
      summary.peakNodeMemoryPercent = Math.max(
        summary.peakNodeMemoryPercent,
        (parseMemoryBytes(usage.memory) / parseMemoryBytes(capacity.memory)) * 100,
      );
    }

    let sandboxPods = 0;
    let sandboxCpuCores = 0;
    let sandboxMemoryBytes = 0;
    let orchestratorCpuCores = 0;
    let orchestratorMemoryBytes = 0;
    for (const pod of sample.podMetrics) {
      const cpu = pod.containers.reduce(
        (total, container) => total + parseCpuCores(container.cpu),
        0,
      );
      const memory = pod.containers.reduce(
        (total, container) => total + parseMemoryBytes(container.memory),
        0,
      );
      if (pod.labels['ctxmill.sandbox-session-id']) {
        sandboxPods++;
        sandboxCpuCores += cpu;
        sandboxMemoryBytes += memory;
      }
      if (
        pod.labels.app === 'ctxmill-orchestrator'
        || pod.labels['app.kubernetes.io/name'] === 'orchestrator'
      ) {
        orchestratorCpuCores += cpu;
        orchestratorMemoryBytes += memory;
      }
    }
    summary.peakSandboxPods = Math.max(summary.peakSandboxPods, sandboxPods);
    summary.peakPendingSandboxPods = Math.max(
      summary.peakPendingSandboxPods,
      sample.pendingSandboxPods,
    );
    summary.peakActiveSandboxJobs = Math.max(
      summary.peakActiveSandboxJobs,
      sample.activeSandboxJobs,
    );
    summary.peakSandboxCpuCores = Math.max(
      summary.peakSandboxCpuCores,
      sandboxCpuCores,
    );
    summary.peakSandboxMemoryBytes = Math.max(
      summary.peakSandboxMemoryBytes,
      sandboxMemoryBytes,
    );
    summary.peakOrchestratorCpuCores = Math.max(
      summary.peakOrchestratorCpuCores,
      orchestratorCpuCores,
    );
    summary.peakOrchestratorMemoryBytes = Math.max(
      summary.peakOrchestratorMemoryBytes,
      orchestratorMemoryBytes,
    );
  }

  return summary;
}
