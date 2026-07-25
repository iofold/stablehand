#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
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
  createCtxmillControlClient,
} from '../../packages/client/src/index.js';
import {
  summarizeKubernetesSamples,
  type KubernetesResourceSample,
} from './src/kubernetes.js';
import { parsePerformanceProfile } from './src/profile.js';
import { renderPerformanceReport } from './src/report.js';
import {
  runPerformanceProfile,
  type PerformanceRunResult,
} from './src/runner.js';

function usage(): never {
  process.stderr.write(
    'Usage:\n'
      + '  bun tests/performance/cli.ts run --profile <profile.json> --output <directory>\n'
      + '  bun tests/performance/cli.ts finalize --result <run.json> '
      + '--kubernetes <kubernetes.jsonl> --output <directory>\n',
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

function installAbortFileMonitor(
  controller: AbortController,
): ReturnType<typeof setInterval> | undefined {
  const abortFile = process.env.CTXMILL_PERF_ABORT_FILE;
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
  const token = process.env.CTXMILL_API_TOKEN;
  if (!token) {
    throw new Error('CTXMILL_API_TOKEN is required');
  }

  const profile = parsePerformanceProfile(await readJson(profilePath));
  await mkdir(output, { recursive: true, mode: 0o700 });
  const runId = process.env.CTXMILL_PERF_RUN_ID ?? randomUUID();
  const controller = new AbortController();
  const onSignal = () => controller.abort(new Error('Load runner interrupted'));
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const monitor = installAbortFileMonitor(controller);
  const turnsPath = `${output}/turns.jsonl`;
  await writeFile(turnsPath, '', { mode: 0o600 });

  try {
    const client = createCtxmillControlClient({
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
    await writeFile(
      `${output}/failure.json`,
      `${JSON.stringify({
        runId,
        failedAt: new Date().toISOString(),
        error: normalized.message,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    throw normalized;
  } finally {
    if (monitor) clearInterval(monitor);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
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

async function main(): Promise<void> {
  const command = process.argv[2];
  const parsed = parseArgs({
    args: process.argv.slice(3),
    options: {
      profile: { type: 'string' },
      output: { type: 'string' },
      result: { type: 'string' },
      kubernetes: { type: 'string' },
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
  usage();
}

await main().catch((error) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  process.stderr.write(`Performance runner failed: ${normalized.message}\n`);
  process.exitCode = 1;
});
