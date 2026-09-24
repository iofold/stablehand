import type {
  KubernetesResourceSummary,
} from './kubernetes.js';
import type {
  PerformanceRunResult,
} from './runner.js';

function fixed(value: number | undefined, digits = 1): string {
  return value === undefined ? 'n/a' : value.toFixed(digits);
}

function p95(
  result: PerformanceRunResult['stages'][number],
  field: string,
): string {
  return fixed(result.summary.timings[field]?.p95);
}

function megabytes(bytes: number): string {
  return fixed(bytes / (1024 ** 2));
}

export function renderPerformanceReport(
  result: PerformanceRunResult,
  kubernetes?: KubernetesResourceSummary,
): string {
  const lines = [
    `# STABLEHAND performance run ${result.runId}`,
    '',
    `Profile: ${result.profile}`,
    `Target: ${result.target.apiBase}`,
    `Window: ${result.startedAt} to ${result.completedAt}`,
    `Planned load: ${result.plan.totalTurns} STABLEHAND turns `
      + `(${result.plan.warmupTurns} warmup), about `
      + `${result.plan.estimatedModelCalls} model calls`,
    `Model gateway: ${result.modelGateway
      ? `${result.modelGateway.state} (${result.modelGateway.profile ?? 'no profile'}, `
        + `${result.modelGateway.revision ?? 'no revision'})`
      : 'unavailable'}`,
    `Clock offset: ${fixed(result.clock.estimate.offsetMs)} ms `
      + `(uncertainty ${fixed(result.clock.estimate.uncertaintyMs)} ms)`,
    '',
    '## Stage results',
    '',
    '| Stage | Harness | Model routes | Mode | Concurrency | SSE clients/agent | Turns | Error rate | Time to first token p95 | Completion p95 | Restore p95 | Turns/s | Events/s | SSE deliveries/s |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const stage of result.stages) {
    const plan = result.plan.stages.find((candidate) =>
      candidate.name === stage.stage.name);
    const modelRoutes = plan?.modelRoutes
      .map((route) => `${route.provider}/${route.model}`)
      .join(', ') || 'unknown';
    lines.push(
      `| ${stage.stage.name} | ${stage.stage.harness} `
      + `| ${modelRoutes} `
      + `| ${stage.stage.sessionMode} `
      + `| ${stage.stage.concurrency} | ${stage.stage.sseClientsPerAgent} `
      + `| ${stage.summary.turns} `
      + `| ${fixed(stage.summary.errorRate * 100)}% `
      + `| ${p95(stage, 'timeToFirstTokenMs')} ms `
      + `| ${p95(stage, 'completionMs')} ms `
      + `| ${p95(stage, 'restoreMs')} ms `
      + `| ${fixed(stage.turnsPerSecond, 2)} `
      + `| ${fixed(stage.eventsPerSecond, 2)} `
      + `| ${fixed(stage.sseDeliveriesPerSecond, 2)} |`,
    );
  }

  lines.push('', '## Correctness and usage', '');
  for (const stage of result.stages) {
    lines.push(
      `- ${stage.stage.name}: SSE fanout mismatches `
      + `${stage.summary.sseFanoutMismatches}; `
      + `${stage.summary.usage.totalTokens} tokens; `
      + `$${fixed(stage.summary.usage.knownCostUsd, 6)} known cost; `
      + `${stage.summary.usage.unpricedTurns} unpriced turn(s).`,
    );
  }

  if (kubernetes) {
    lines.push(
      '',
      '## Kubernetes resources',
      '',
      `- Samples: ${kubernetes.samples}`,
      `- Peak node CPU: ${fixed(kubernetes.peakNodeCpuPercent)}%`,
      `- Peak node memory: ${fixed(kubernetes.peakNodeMemoryPercent)}%`,
      `- Peak sandbox pods: ${kubernetes.peakSandboxPods} `
        + `(pending ${kubernetes.peakPendingSandboxPods}, sustained pending `
        + `${kubernetes.peakPendingSandboxPodsAfterGrace}, active jobs `
        + `${kubernetes.peakActiveSandboxJobs})`,
      `- Peak sandbox usage: ${fixed(kubernetes.peakSandboxCpuCores, 3)} CPU cores, `
        + `${megabytes(kubernetes.peakSandboxMemoryBytes)} MiB`,
      `- Peak orchestrator usage: ${fixed(kubernetes.peakOrchestratorCpuCores, 3)} CPU cores, `
        + `${megabytes(kubernetes.peakOrchestratorMemoryBytes)} MiB`,
      `- Peak model gateway usage: ${fixed(kubernetes.peakModelGatewayCpuCores, 3)} CPU cores, `
        + `${megabytes(kubernetes.peakModelGatewayMemoryBytes)} MiB`,
    );
  }

  lines.push(
    '',
    'The raw turn, Kubernetes, and trace files are the audit evidence. A capacity claim '
      + 'is valid only for the exact profile, models, provider routes, node shape, and '
      + 'safety ceilings recorded by this run.',
    '',
  );
  return lines.join('\n');
}
