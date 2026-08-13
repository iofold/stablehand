import { randomUUID } from 'node:crypto';

import type {
  CtxmillControlClient,
} from '../../../packages/client/src/index.js';
import type {
  ModelGatewayStatus,
} from '../../../packages/contracts/src/index.js';

import {
  estimateClockOffset,
  type ClockOffsetEstimate,
  type ClockProbe,
} from './clock.js';
import {
  isManagedBenchmarkAgent,
  reconcileBenchmarkAgents,
} from './agents.js';
import {
  assertModelGatewayRequirement,
  summarizePerformancePlan,
  type PerformancePlan,
  type PerformanceProfile,
  type PerformanceStage,
} from './profile.js';
import { mapConcurrent } from './pool.js';
import {
  AgentStreamHub,
  type TurnStreamResult,
} from './stream-hub.js';
import {
  summarizeTurnSamples,
  type TurnSample,
  type TurnSampleSummary,
} from './stats.js';

type TurnClient = Pick<CtxmillControlClient, 'turns'>;
type SandboxSessionClient = Pick<
  CtxmillControlClient['sandboxSessions'],
  'list' | 'kill'
>;

interface TurnTrackingHub {
  trackTurn(turnId: string, timeoutMs: number): Promise<TurnStreamResult>;
  cancelTurn(turnId: string, error: unknown): void;
}

interface ExecuteMeasuredTurnOptions {
  client: TurnClient;
  hub: TurnTrackingHub;
  runId: string;
  stageName: string;
  harness: TurnSample['harness'];
  agentId: string;
  conversationId?: string;
  turnId?: string;
  prompt: string;
  expectedOutput?: string;
  timeoutMs: number;
  clockOffsetMs: number;
  now?: () => number;
  signal?: AbortSignal;
}

export async function cleanupManagedSessions(
  client: SandboxSessionClient,
  agentIds: ReadonlySet<string>,
  timeoutMs: number,
): Promise<number> {
  const active = await client.list({ status: 'active' }, { timeoutMs });
  const owned = active.filter((session) => agentIds.has(session.agentId));
  await Promise.all(
    owned.map((session) =>
      client.kill(session.agentId, session.id, { timeoutMs })),
  );
  return owned.length;
}

type ManagedBenchmarkClient = Pick<
  CtxmillControlClient,
  'agents' | 'sandboxSessions'
>;

export async function cleanupAllManagedSessions(
  client: ManagedBenchmarkClient,
  timeoutMs: number,
): Promise<number> {
  const agents = await client.agents.list({ timeoutMs });
  const managedAgentIds = new Set(
    agents
      .filter((agent) => isManagedBenchmarkAgent(agent.metadata))
      .map((agent) => agent.id),
  );
  return cleanupManagedSessions(
    client.sandboxSessions,
    managedAgentIds,
    timeoutMs,
  );
}

function terminalOutcome(
  status: string,
): TurnSample['outcome'] {
  switch (status) {
    case 'COMPLETED':
      return 'completed';
    case 'CANCELLED':
      return 'cancelled';
    case 'ERROR':
      return 'error';
    default:
      return 'timeout';
  }
}

function elapsed(
  timestamp: number | undefined,
  startedAt: number,
): number | undefined {
  return timestamp === undefined ? undefined : Math.max(0, timestamp - startedAt);
}

export async function executeMeasuredTurn(
  options: ExecuteMeasuredTurnOptions,
): Promise<TurnSample> {
  const now = options.now ?? Date.now;
  const turnId = options.turnId ?? randomUUID();
  const terminalPromise = options.hub.trackTurn(turnId, options.timeoutMs);
  const submittedAt = now();

  try {
    const response = await options.client.turns.startConversationTurn(
      options.agentId,
      {
        content: options.prompt,
        ...(options.conversationId
          ? { conversationId: options.conversationId }
          : {}),
        requestedTurnId: turnId,
        tags: {
          'ctxmill.performance.run_id': options.runId,
          'ctxmill.performance.stage': options.stageName,
        },
      },
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        idempotencyKey: turnId,
      },
    );
    const admittedAt = now();
    if (
      response.turnId !== turnId
      || (
        options.conversationId !== undefined
        && response.conversationId !== options.conversationId
      )
    ) {
      throw new Error(
        `Turn admission identity mismatch: requested ${turnId}/${options.conversationId}, `
        + `received ${response.turnId}/${response.conversationId}`,
      );
    }

    const streamed = await terminalPromise;
    const detail = await options.client.turns.get(
      options.agentId,
      turnId,
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      },
    );
    const { observation } = streamed;
    const usage = detail.turn.usage;
    const terminal = terminalOutcome(detail.turn.status);
    const assistantMessage = [...detail.messages]
      .reverse()
      .find((message) => message.role === 'assistant');
    // Output integrity is judged against what the platform actually streamed,
    // not against model obedience: persisted-vs-streamed divergence is real
    // corruption (the kdue class) and fails hard, while a model deviating from
    // the exact echo prompt (~1% for gpt-oss under reasoning; dev2 wave
    // evidence 2026-08-13: platform persisted the lone "_OK" delta faithfully
    // end-to-end) is recorded as a deviation, not a platform failure.
    let outputError: string | undefined;
    let modelEchoDeviation = false;
    if (terminal === 'completed' && options.expectedOutput !== undefined) {
      const persisted = assistantMessage?.content.trim() ?? '';
      const streamedText = observation.streamedAssistantText?.trim();
      if (persisted.length === 0) {
        outputError = 'Expected exact assistant output was not persisted';
      } else if (streamedText !== undefined && persisted !== streamedText) {
        outputError = 'Persisted assistant output diverged from streamed deltas';
      } else if (persisted !== options.expectedOutput.trim()) {
        modelEchoDeviation = true;
        console.warn(
          `[perf] model deviated from exact echo on turn ${turnId} `
          + `(expected ${JSON.stringify(options.expectedOutput.trim())}, `
          + `got ${JSON.stringify(persisted)}); platform stream/persistence agree`,
        );
      }
    }
    return {
      runId: options.runId,
      stageName: options.stageName,
      turnId,
      agentId: options.agentId,
      conversationId: response.conversationId,
      sandboxSessionId: detail.turn.sandboxSessionId,
      harness: options.harness,
      outcome: outputError ? 'error' : terminal,
      admissionMs: admittedAt - submittedAt,
      timeToFirstEventMs: elapsed(observation.firstEventAtMs, submittedAt),
      timeToRunStartedMs: elapsed(observation.runStartedAtMs, submittedAt),
      timeToFirstTokenMs: elapsed(observation.firstTokenAtMs, submittedAt),
      completionMs: elapsed(observation.terminalAtMs, submittedAt),
      serverToClientFirstEventLagMs:
        observation.firstServerEventAtMs === undefined
          ? undefined
          : observation.firstEventAtMs!
            + options.clockOffsetMs
            - observation.firstServerEventAtMs,
      serverToClientTerminalLagMs:
        observation.terminalServerEventAtMs === undefined
          ? undefined
          : observation.terminalAtMs!
            + options.clockOffsetMs
            - observation.terminalServerEventAtMs,
      eventCount: observation.eventCount ?? 0,
      sseClientEventCounts: streamed.clientEventCounts,
      sseClientEventSequences: streamed.clientEventSequences,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      totalTokens: usage?.totalTokens,
      modelCallsObserved: usage?.modelCalls.observed,
      modelCallsCostKnown: usage?.modelCalls.costKnown,
      modelCallsExpected: usage?.modelCalls.expected,
      knownCostUsd: usage?.cost.knownUsd,
      totalCostUsd: usage?.cost.totalUsd ?? undefined,
      costCoverage: usage?.cost.coverage,
      error: detail.turn.error ?? outputError,
      ...(modelEchoDeviation ? { modelEchoDeviation } : {}),
    };
  } catch (error) {
    options.hub.cancelTurn(turnId, error);
    await terminalPromise.catch(() => undefined);
    throw error;
  }
}

export interface PerformanceRunClock {
  estimate: ClockOffsetEstimate;
  probes: ClockProbe[];
}

type PerformanceControlClient = Pick<
  CtxmillControlClient,
  | 'agents'
  | 'turns'
  | 'sandboxSessions'
  | 'health'
  | 'agentEvents'
  | 'modelGateway'
>;

export interface PerformanceStageResult {
  stage: PerformanceStage;
  startedAt: string;
  completedAt: string;
  wallMs: number;
  turnsPerSecond: number;
  eventsPerSecond: number;
  sseDeliveriesPerSecond: number;
  samples: TurnSample[];
  summary: TurnSampleSummary;
}

export interface PerformanceRunResult {
  schemaVersion: 2;
  runId: string;
  profile: string;
  target: PerformanceProfile['target'];
  requirements: PerformanceProfile['requirements'];
  plan: PerformancePlan;
  modelGateway: ModelGatewayStatus | null;
  startedAt: string;
  completedAt: string;
  clock: PerformanceRunClock;
  stages: PerformanceStageResult[];
}

export async function refreshPerformanceRunUsage(
  client: TurnClient,
  result: PerformanceRunResult,
): Promise<PerformanceRunResult> {
  const stages: PerformanceStageResult[] = [];
  for (const stage of result.stages) {
    const samples = await mapConcurrent(stage.samples, 20, async (sample) => {
      const detail = await client.turns.get(sample.agentId, sample.turnId);
      const usage = detail.turn.usage;
      if (!usage) return sample;
      return {
        ...sample,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        modelCallsObserved: usage.modelCalls.observed,
        modelCallsCostKnown: usage.modelCalls.costKnown,
        modelCallsExpected: usage.modelCalls.expected,
        knownCostUsd: usage.cost.knownUsd,
        totalCostUsd: usage.cost.totalUsd ?? undefined,
        costCoverage: usage.cost.coverage,
      };
    });
    stages.push({
      ...stage,
      samples,
      summary: summarizeTurnSamples(samples),
    });
  }
  return { ...result, stages };
}

interface RunPerformanceProfileOptions {
  client: PerformanceControlClient;
  profile: PerformanceProfile;
  runId?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  onSample?: (sample: TurnSample) => void | Promise<void>;
  onStage?: (stage: PerformanceStageResult) => void | Promise<void>;
}

async function calibrateClock(
  client: Pick<CtxmillControlClient, 'health'>,
  now: () => number,
  signal?: AbortSignal,
): Promise<PerformanceRunClock> {
  const probes: ClockProbe[] = [];
  for (let index = 0; index < 5; index++) {
    const sentAtMs = now();
    const health = await client.health.get({
      signal,
      timeoutMs: 10_000,
    });
    const receivedAtMs = now();
    const serverAtMs = Date.parse(health.timestamp);
    if (!Number.isFinite(serverAtMs)) {
      throw new Error(`Health endpoint returned invalid timestamp ${health.timestamp}`);
    }
    probes.push({ sentAtMs, receivedAtMs, serverAtMs });
  }
  return { probes, estimate: estimateClockOffset(probes) };
}

function errorSample(input: {
  runId: string;
  stage: PerformanceStage;
  agentId: string;
  conversationId?: string;
  turnId: string;
  iteration: number;
  lane: number;
  startedAt: number;
  completedAt: number;
  error: unknown;
}): TurnSample {
  const error = input.error instanceof Error
    ? input.error.message
    : String(input.error);
  return {
    runId: input.runId,
    stageName: input.stage.name,
    turnId: input.turnId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    harness: input.stage.harness,
    iteration: input.iteration,
    lane: input.lane,
    outcome: 'error',
    completionMs: Math.max(0, input.completedAt - input.startedAt),
    eventCount: 0,
    error,
  };
}

export async function runPerformanceProfile(
  options: RunPerformanceProfileOptions,
): Promise<PerformanceRunResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep
    ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const runId = options.runId ?? randomUUID();
  const startedAtMs = now();
  let modelGateway: ModelGatewayStatus | null = null;
  try {
    modelGateway = await options.client.modelGateway.status({
      signal: options.signal,
      timeoutMs: 10_000,
    });
  } catch (error) {
    if (options.profile.requirements.modelGateway === 'required') {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to inspect required model gateway: ${message}`, {
        cause: error,
      });
    }
  }
  assertModelGatewayRequirement(options.profile, modelGateway);
  const clock = await calibrateClock(options.client, now, options.signal);
  const stages: PerformanceStageResult[] = [];

  for (const stage of options.profile.stages) {
    options.signal?.throwIfAborted();
    const stageStartedAt = now();
    const agents = await reconcileBenchmarkAgents(options.client, stage);
    const laneAgents = Array.from(
      { length: stage.concurrency },
      (_, lane) => agents[stage.topology === 'hot-agent' ? 0 : lane]!,
    );
    const hubs = new Map<string, AgentStreamHub>();
    const cleanupSessions = new Map<
      string,
      { agentId: string; sandboxSessionId: string }
    >();
    const activeResumeSessions = new Map<
      string,
      { agentId: string; sandboxSessionId: string }
    >();

    try {
      for (const agent of agents) {
        const hub = new AgentStreamHub({
          agentId: agent.id,
          clients: stage.sseClientsPerAgent,
          stream: (input) => options.client.agentEvents.stream({
            ...input,
            timeoutMs: stage.timeoutMs,
          }),
        });
        hubs.set(agent.id, hub);
      }
      await Promise.all(
        Array.from(hubs.values(), (hub) => hub.start(stage.timeoutMs)),
      );

      const laneConversations: Array<string | undefined> = Array.from(
        { length: stage.concurrency },
        () => undefined,
      );
      const laneSessions: Array<string | undefined> = Array.from(
        { length: stage.concurrency },
        () => undefined,
      );

      for (let warmup = 0; warmup < stage.warmupTurns; warmup++) {
        await mapConcurrent(
          laneAgents,
          stage.concurrency,
          async (agent, lane) => {
            const sample = await executeMeasuredTurn({
              client: options.client,
              hub: hubs.get(agent.id)!,
              runId,
              stageName: stage.name,
              harness: stage.harness,
              agentId: agent.id,
              conversationId: laneConversations[lane]!,
              prompt: stage.prompt,
              expectedOutput: options.profile.expectedOutput,
              timeoutMs: stage.timeoutMs,
              clockOffsetMs: clock.estimate.offsetMs,
              signal: options.signal,
            });
            if (sample.outcome !== 'completed' || !sample.sandboxSessionId) {
              throw new Error(
                `Warmup turn ${sample.turnId} failed for stage ${stage.name}: `
                + `${sample.error ?? sample.outcome}`,
              );
            }
            if (!sample.conversationId) {
              throw new Error(
                `Warmup turn ${sample.turnId} did not return a conversation ID`,
              );
            }
            laneConversations[lane] = sample.conversationId;
            laneSessions[lane] = sample.sandboxSessionId;
            cleanupSessions.set(sample.sandboxSessionId, {
              agentId: agent.id,
              sandboxSessionId: sample.sandboxSessionId,
            });
            if (stage.sessionMode === 'resume') {
              activeResumeSessions.set(sample.sandboxSessionId, {
                agentId: agent.id,
                sandboxSessionId: sample.sandboxSessionId,
              });
            }
          },
        );
      }

      if (stage.sessionMode === 'resume') {
        await mapConcurrent(
          laneAgents,
          stage.concurrency,
          async (agent, lane) => {
            await options.client.sandboxSessions.suspend(
              agent.id,
              laneSessions[lane]!,
              { signal: options.signal, timeoutMs: stage.timeoutMs },
            );
            activeResumeSessions.delete(laneSessions[lane]!);
          },
        );
      }

      const samples: TurnSample[] = [];
      for (let iteration = 0; iteration < stage.iterations; iteration++) {
        options.signal?.throwIfAborted();
        const iterationSamples = await mapConcurrent(
          laneAgents,
          stage.concurrency,
          async (agent, lane): Promise<TurnSample> => {
            const conversationId = stage.sessionMode === 'cold'
              ? undefined
              : laneConversations[lane];
            let restoreMs: number | undefined;
            if (stage.sessionMode === 'resume') {
              const restoreStartedAt = now();
              await options.client.sandboxSessions.restore(
                agent.id,
                laneSessions[lane]!,
                { signal: options.signal, timeoutMs: stage.timeoutMs },
              );
              activeResumeSessions.set(laneSessions[lane]!, {
                agentId: agent.id,
                sandboxSessionId: laneSessions[lane]!,
              });
              restoreMs = now() - restoreStartedAt;
            }

            const turnId = randomUUID();
            const turnStartedAt = now();
            let sample: TurnSample;
            try {
              sample = await executeMeasuredTurn({
                client: options.client,
                hub: hubs.get(agent.id)!,
                runId,
                stageName: stage.name,
                harness: stage.harness,
                agentId: agent.id,
                conversationId,
                turnId,
                prompt: stage.prompt,
                expectedOutput: options.profile.expectedOutput,
                timeoutMs: stage.timeoutMs,
                clockOffsetMs: clock.estimate.offsetMs,
                signal: options.signal,
              });
            } catch (error) {
              sample = errorSample({
                runId,
                stage,
                agentId: agent.id,
                conversationId,
                turnId,
                iteration,
                lane,
                startedAt: turnStartedAt,
                completedAt: now(),
                error,
              });
            }
            sample.iteration = iteration;
            sample.lane = lane;
            sample.restoreMs = restoreMs;
            if (sample.sandboxSessionId) {
              cleanupSessions.set(sample.sandboxSessionId, {
                agentId: agent.id,
                sandboxSessionId: sample.sandboxSessionId,
              });
            }

            if (
              stage.sessionMode === 'resume'
              && sample.sandboxSessionId
              && sample.outcome === 'completed'
            ) {
              const suspendStartedAt = now();
              await options.client.sandboxSessions.suspend(
                agent.id,
                sample.sandboxSessionId,
                { signal: options.signal, timeoutMs: stage.timeoutMs },
              );
              sample.suspendMs = now() - suspendStartedAt;
              laneSessions[lane] = sample.sandboxSessionId;
              activeResumeSessions.delete(sample.sandboxSessionId);
            }
            if (
              stage.sessionMode === 'cold'
              && sample.sandboxSessionId
            ) {
              await options.client.sandboxSessions.kill(
                agent.id,
                sample.sandboxSessionId,
                { signal: options.signal, timeoutMs: stage.timeoutMs },
              );
              cleanupSessions.delete(sample.sandboxSessionId);
            }
            return sample;
          },
        );
        for (const sample of iterationSamples) {
          samples.push(sample);
          await options.onSample?.(sample);
        }

        const interim = summarizeTurnSamples(samples);
        if (interim.errorRate > options.profile.safety.abortErrorRate) {
          throw new Error(
            `Aborting stage ${stage.name}: error rate ${interim.errorRate.toFixed(3)} `
            + `exceeds safety limit ${options.profile.safety.abortErrorRate}`,
          );
        }
        if (stage.settleMs > 0) await sleep(stage.settleMs);
      }

      const stageCompletedAt = now();
      const wallMs = Math.max(1, stageCompletedAt - stageStartedAt);
      const summary = summarizeTurnSamples(samples);
      const result: PerformanceStageResult = {
        stage,
        startedAt: new Date(stageStartedAt).toISOString(),
        completedAt: new Date(stageCompletedAt).toISOString(),
        wallMs,
        turnsPerSecond: samples.length / (wallMs / 1_000),
        eventsPerSecond: summary.totalEvents / (wallMs / 1_000),
        sseDeliveriesPerSecond:
          summary.totalSseDeliveries / (wallMs / 1_000),
        samples,
        summary,
      };
      stages.push(result);
      await options.onStage?.(result);
    } finally {
      if (stage.sessionMode === 'resume') {
        await Promise.allSettled(
          Array.from(activeResumeSessions.values(), (session) =>
            options.client.sandboxSessions.suspend(
              session.agentId,
              session.sandboxSessionId,
              { timeoutMs: stage.timeoutMs },
            )),
        );
      } else {
        await Promise.allSettled(
          Array.from(cleanupSessions.values(), (session) =>
            options.client.sandboxSessions.kill(
              session.agentId,
              session.sandboxSessionId,
              { timeoutMs: stage.timeoutMs },
            )),
        );
      }
      await Promise.allSettled([
        cleanupManagedSessions(
          options.client.sandboxSessions,
          new Set(agents.map((agent) => agent.id)),
          stage.timeoutMs,
        ),
      ]);
      await Promise.allSettled(
        Array.from(hubs.values(), (hub) => hub.stop()),
      );
    }
  }

  const completedAtMs = now();
  return {
    schemaVersion: 2,
    runId,
    profile: options.profile.name,
    target: options.profile.target,
    requirements: options.profile.requirements,
    plan: summarizePerformancePlan(options.profile),
    modelGateway,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    clock,
    stages,
  };
}
