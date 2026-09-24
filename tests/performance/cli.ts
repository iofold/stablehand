#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { parseArgs } from 'node:util';

import {
  createStablehandControlClient,
} from '../../packages/client/src/index.js';
import {
  buildCapacityWaveProfile,
  evaluateCapacityWave,
  parseCapacityRamp,
  summarizeCapacityEvidence,
} from './src/capacity.js';
import {
  summarizeKubernetesSamples,
  type KubernetesResourceSample,
  type KubernetesResourceSummary,
} from './src/kubernetes.js';
import {
  parsePerformanceProfile,
  summarizePerformancePlan,
} from './src/profile.js';
import { renderPerformanceReport } from './src/report.js';
import {
  cleanupAllManagedSessions,
  refreshPerformanceRunUsage,
  runPerformanceProfile,
  type PerformanceRunResult,
} from './src/runner.js';
import type { TurnSample } from './src/stats.js';

function usage(): never {
  process.stderr.write(
    'Usage:\n'
      + '  bun tests/performance/cli.ts run --profile <profile.json> --output <directory>\n'
      + '  bun tests/performance/cli.ts finalize --result <run.json> '
      + '--kubernetes <kubernetes.jsonl> --output <directory>\n'
      + '  bun tests/performance/cli.ts refresh --result <run.json> '
      + '--output <directory>\n'
      + '  bun tests/performance/cli.ts plan --profile <profile.json>\n'
      + '  bun tests/performance/cli.ts wave --ramp <ramp.json> '
      + '--concurrency <count> --ordinal <count> --output <profile.json>\n'
      + '  bun tests/performance/cli.ts evaluate --ramp <ramp.json> '
      + '--output <evidence-directory>\n'
      + '  bun tests/performance/cli.ts resources --kubernetes <jsonl> '
      + '--output <evidence-directory>\n'
      + '  bun tests/performance/cli.ts cleanup --api-base <url> '
      + '[--timeout-ms <milliseconds>]\n',
  );
  process.exit(2);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

async function readText(path: string): Promise<string> {
  return existsSync(path) ? readFile(path, 'utf8') : '';
}

function installAbortFileMonitor(
  controller: AbortController,
): ReturnType<typeof setInterval> | undefined {
  const abortFile = process.env.STABLEHAND_PERF_ABORT_FILE;
  if (!abortFile) return undefined;
  const check = () => {
    if (!existsSync(abortFile) || controller.signal.aborted) return;
    const reason = readFileSync(abortFile, 'utf8').trim()
      || 'dev2 safety monitor requested an abort';
    controller.abort(new Error(reason));
  };
  check();
  const interval = setInterval(check, 500);
  interval.unref();
  return interval;
}

async function runCommand(values: Record<string, string | boolean | undefined>): Promise<void> {
  const profilePath = typeof values.profile === 'string' ? values.profile : undefined;
  const output = typeof values.output === 'string' ? values.output : undefined;
  if (!profilePath || !output) usage();
  const profile = parsePerformanceProfile(await readJson(profilePath));
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(
    `${output}/plan.json`,
    `${JSON.stringify({
      profile: profile.name,
      target: profile.target,
      requirements: profile.requirements,
      safety: profile.safety,
      plan: summarizePerformancePlan(profile),
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const token = process.env.STABLEHAND_API_TOKEN;
  if (!token) {
    throw new Error('STABLEHAND_API_TOKEN is required');
  }
  const runId = process.env.STABLEHAND_PERF_RUN_ID ?? randomUUID();
  const controller = new AbortController();
  const onSignal = () => controller.abort(new Error('Load runner interrupted'));
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const monitor = installAbortFileMonitor(controller);
  const turnsPath = `${output}/turns.jsonl`;
  const startedAt = new Date().toISOString();
  await writeFile(turnsPath, '', { mode: 0o600 });

  try {
    const client = createStablehandControlClient({
      apiBase: profile.target.apiBase,
      token,
      timeoutMs: Math.max(...profile.stages.map((stage) => stage.timeoutMs)),
      retry: { maxAttempts: 3, baseDelayMs: 100 },
    });
    const result = await runPerformanceProfile({
      client,
      profile,
      runId,
      signal: controller.signal,
      onSample: (sample) =>
        appendFile(turnsPath, `${JSON.stringify(sample)}\n`, { mode: 0o600 }),
    });
    await writeFile(
      `${output}/run.json`,
      `${JSON.stringify(result, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      `${output}/turn-ids.txt`,
      `${result.stages.flatMap((stage) =>
        stage.samples.map((sample) => sample.turnId)).join('\n')}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      `${output}/report.md`,
      renderPerformanceReport(result),
      { mode: 0o600 },
    );
    process.stdout.write(`${JSON.stringify({
      runId: result.runId,
      output,
      stages: result.stages.length,
      turns: result.stages.reduce(
        (total, stage) => total + stage.summary.turns,
        0,
      ),
    })}\n`);
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    const failedAt = new Date().toISOString();
    const partialTurns = await readJsonLines<TurnSample>(turnsPath);
    await writeFile(
      `${output}/failure.json`,
      `${JSON.stringify({
        runId,
        startedAt,
        failedAt,
        error: normalized.message,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      `${output}/turn-ids.txt`,
      `${partialTurns.map((sample) => sample.turnId).join('\n')}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      `${output}/trace-window.json`,
      `${JSON.stringify({ startedAt, completedAt: failedAt, stages: [] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    throw normalized;
  } finally {
    if (monitor) clearInterval(monitor);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

async function planCommand(
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const profilePath = typeof values.profile === 'string' ? values.profile : undefined;
  if (!profilePath) usage();
  const profile = parsePerformanceProfile(await readJson(profilePath));
  process.stdout.write(`${JSON.stringify({
    profile: profile.name,
    target: profile.target,
    requirements: profile.requirements,
    safety: profile.safety,
    plan: summarizePerformancePlan(profile),
  }, null, 2)}\n`);
}

async function finalizeCommand(
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const resultPath = typeof values.result === 'string' ? values.result : undefined;
  const kubernetesPath = typeof values.kubernetes === 'string'
    ? values.kubernetes
    : undefined;
  const output = typeof values.output === 'string' ? values.output : undefined;
  if (!resultPath || !kubernetesPath || !output) usage();

  const result = await readJson(resultPath) as PerformanceRunResult;
  const kubernetes = summarizeKubernetesSamples(
    await readJsonLines<KubernetesResourceSample>(kubernetesPath),
  );
  await writeFile(
    `${output}/kubernetes-summary.json`,
    `${JSON.stringify(kubernetes, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    `${output}/report.md`,
    renderPerformanceReport(result, kubernetes),
    { mode: 0o600 },
  );
}

async function refreshCommand(
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const resultPath = typeof values.result === 'string' ? values.result : undefined;
  const output = typeof values.output === 'string' ? values.output : undefined;
  if (!resultPath || !output) usage();
  const token = process.env.STABLEHAND_API_TOKEN;
  if (!token) throw new Error('STABLEHAND_API_TOKEN is required');

  const result = await readJson(resultPath) as PerformanceRunResult;
  const client = createStablehandControlClient({
    apiBase: result.target.apiBase,
    token,
    timeoutMs: 60_000,
    retry: { maxAttempts: 3, baseDelayMs: 100 },
  });
  const refreshed = await refreshPerformanceRunUsage(client, result);
  const samples = refreshed.stages.flatMap((stage) => stage.samples);
  await writeFile(
    `${output}/run.json`,
    `${JSON.stringify(refreshed, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    `${output}/turns.jsonl`,
    samples.map((sample) => JSON.stringify(sample)).join('\n') + '\n',
    { mode: 0o600 },
  );
  await writeFile(
    `${output}/report.md`,
    renderPerformanceReport(refreshed),
    { mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify({ refreshedTurns: samples.length })}\n`);
}

async function resourcesCommand(
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const kubernetesPath = typeof values.kubernetes === 'string'
    ? values.kubernetes
    : undefined;
  const output = typeof values.output === 'string' ? values.output : undefined;
  if (!kubernetesPath || !output) usage();
  const kubernetes = summarizeKubernetesSamples(
    await readJsonLines<KubernetesResourceSample>(kubernetesPath),
  );
  await writeFile(
    `${output}/kubernetes-summary.json`,
    `${JSON.stringify(kubernetes, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function cleanupCommand(
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const apiBase = typeof values['api-base'] === 'string'
    ? values['api-base']
    : undefined;
  const timeoutMs = typeof values['timeout-ms'] === 'string'
    ? Number(values['timeout-ms'])
    : 60_000;
  if (!apiBase || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) usage();
  const token = process.env.STABLEHAND_API_TOKEN;
  if (!token) throw new Error('STABLEHAND_API_TOKEN is required');

  const client = createStablehandControlClient({
    apiBase,
    token,
    timeoutMs,
    retry: { maxAttempts: 3, baseDelayMs: 100 },
  });
  const killedSessions = await cleanupAllManagedSessions(client, timeoutMs);
  process.stdout.write(`${JSON.stringify({ killedSessions })}\n`);
}

async function waveCommand(
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const rampPath = typeof values.ramp === 'string' ? values.ramp : undefined;
  const concurrency = typeof values.concurrency === 'string'
    ? Number(values.concurrency)
    : Number.NaN;
  const ordinal = typeof values.ordinal === 'string'
    ? Number(values.ordinal)
    : Number.NaN;
  const output = typeof values.output === 'string' ? values.output : undefined;
  if (
    !rampPath
    || !output
    || !Number.isSafeInteger(concurrency)
    || !Number.isSafeInteger(ordinal)
    || ordinal < 1
  ) usage();
  const ramp = parseCapacityRamp(await readJson(rampPath));
  const profile = buildCapacityWaveProfile(ramp, concurrency, ordinal);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
}

async function evaluateCommand(
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const rampPath = typeof values.ramp === 'string' ? values.ramp : undefined;
  const output = typeof values.output === 'string' ? values.output : undefined;
  if (!rampPath || !output) usage();
  const ramp = parseCapacityRamp(await readJson(rampPath));
  const profile = parsePerformanceProfile(await readJson(`${output}/profile.json`));
  const waveWindow = await readJson(
    existsSync(`${output}/run.json`)
      ? `${output}/run.json`
      : `${output}/trace-window.json`,
  ) as { completedAt: string };
  const kubernetes = await readJson(
    `${output}/kubernetes-summary.json`,
  ) as KubernetesResourceSummary;
  const logs = await Promise.all(
    ['orchestrator', 'litellm', 'litellm-db', 'postgres', 'minio']
      .map((component) => readText(`${output}/${component}.log`)),
  );
  const observation = summarizeCapacityEvidence({
    turns: await readJsonLines<TurnSample>(`${output}/turns.jsonl`),
    requestedConcurrency: profile.safety.maxConcurrency,
    kubernetes,
    traces: await readJsonLines(`${output}/traces.jsonl`),
    beforePods: await readJson(`${output}/before-pods.json`) as never,
    afterPods: await readJson(`${output}/after-pods.json`) as never,
    afterJobs: await readJson(`${output}/after-jobs.json`) as never,
    sandbox: await readJson(`${output}/sandbox-metrics-after.json`) as never,
    beforeEvents: await readJson(`${output}/before-events.json`) as never,
    events: await readJson(`${output}/after-events.json`) as never,
    logs: logs.join('\n'),
    beforeGateway: await readJson(`${output}/gateway-before.json`) as never,
    gateway: await readJson(`${output}/gateway-after.json`) as never,
    waveCompletedAtMs: Date.parse(waveWindow.completedAt),
  });
  const decision = evaluateCapacityWave(observation, ramp.gates);
  await writeFile(
    `${output}/capacity-observation.json`,
    `${JSON.stringify(observation, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    `${output}/capacity-decision.json`,
    `${JSON.stringify(decision, null, 2)}\n`,
    { mode: 0o600 },
  );
  await appendFile(
    `${output}/report.md`,
    '\n## Capacity gate\n\n'
      + `Decision: **${decision.decision.toUpperCase()}**\n\n`
      + (decision.violations.length === 0
        ? 'All correctness, capacity, telemetry, and gateway gates passed.\n'
        : decision.violations.map((violation) => `- ${violation}`).join('\n') + '\n'),
    { mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify(decision)}\n`);
  if (decision.decision === 'stop') process.exitCode = 3;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const parsed = parseArgs({
    args: process.argv.slice(3),
    options: {
      profile: { type: 'string' },
      output: { type: 'string' },
      result: { type: 'string' },
      kubernetes: { type: 'string' },
      ramp: { type: 'string' },
      concurrency: { type: 'string' },
      ordinal: { type: 'string' },
      'api-base': { type: 'string' },
      'timeout-ms': { type: 'string' },
    },
    strict: true,
  });
  if (command === 'run') {
    await runCommand(parsed.values);
    return;
  }
  if (command === 'finalize') {
    await finalizeCommand(parsed.values);
    return;
  }
  if (command === 'refresh') {
    await refreshCommand(parsed.values);
    return;
  }
  if (command === 'plan') {
    await planCommand(parsed.values);
    return;
  }
  if (command === 'wave') {
    await waveCommand(parsed.values);
    return;
  }
  if (command === 'evaluate') {
    await evaluateCommand(parsed.values);
    return;
  }
  if (command === 'resources') {
    await resourcesCommand(parsed.values);
    return;
  }
  if (command === 'cleanup') {
    await cleanupCommand(parsed.values);
    return;
  }
  usage();
}

await main().catch((error) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  process.stderr.write(`Performance runner failed: ${normalized.message}\n`);
  process.exitCode = 1;
});
