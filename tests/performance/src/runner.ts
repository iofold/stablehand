import { randomUUID } from 'node:crypto';

import type {
  CtxmillControlClient,
} from '../../../packages/client/src/index.js';

import {
  estimateClockOffset,
  type ClockOffsetEstimate,
  type ClockProbe,
} from './clock.js';
import {
  reconcileBenchmarkAgents,
} from './agents.js';
import type {
  PerformanceProfile,
  PerformanceStage,
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
  conversationId: string;
  turnId?: string;
  prompt: string;
  timeoutMs: number;
  clockOffsetMs: number;
  now?: () => number;
  signal?: AbortSignal;
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
        conversationId: options.conversationId,
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
      || response.conversationId !== options.conversationId
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
    return {
      runId: options.runId,
      stageName: options.stageName,
      turnId,
      agentId: options.agentId,
      conversationId: options.conversationId,
      sandboxSessionId: detail.turn.sandboxSessionId,
      harness: options.harness,
      outcome: terminalOutcome(detail.turn.status),
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
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      totalTokens: usage?.totalTokens,
      knownCostUsd: usage?.cost.knownUsd,
      totalCostUsd: usage?.cost.totalUsd ?? undefined,
      costCoverage: usage?.cost.coverage,
      error: detail.turn.error,
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
  'agents' | 'turns' | 'sandboxSessions' | 'health' | 'agentEvents'
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
  schemaVersion: 1;
  runId: string;
  profile: string;
  target: PerformanceProfile['target'];
  startedAt: string;
  completedAt: string;
  clock: PerformanceRunClock;
  stages: PerformanceStageResult[];
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
  conversationId: string;
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

      const laneConversations = Array.from(
        { length: stage.concurrency },
        () => randomUUID(),
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
              stageName: `${stage.name}:warmup`,
              harness: stage.harness,
              agentId: agent.id,
              conversationId: laneConversations[lane]!,
              prompt: stage.prompt,
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
            laneSessions[lane] = sample.sandboxSessionId;
            cleanupSessions.set(sample.sandboxSessionId, {
              agentId: agent.id,
              sandboxSessionId: sample.sandboxSessionId,
            });
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
              ? randomUUID()
              : laneConversations[lane]!;
            let restoreMs: number | undefined;
            if (stage.sessionMode === 'resume') {
              const restoreStartedAt = now();
              await options.client.sandboxSessions.restore(
                agent.id,
                laneSessions[lane]!,
                { signal: options.signal, timeoutMs: stage.timeoutMs },
              );
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
      if (stage.sessionMode !== 'resume') {
        await Promise.allSettled(
          Array.from(cleanupSessions.values(), (session) =>
            options.client.sandboxSessions.kill(
              session.agentId,
              session.sandboxSessionId,
              { timeoutMs: stage.timeoutMs },
            )),
        );
      }
      await Promise.allSettled(
        Array.from(hubs.values(), (hub) => hub.stop()),
      );
    }
  }

  const completedAtMs = now();
  return {
    schemaVersion: 1,
    runId,
    profile: options.profile.name,
    target: options.profile.target,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    clock,
    stages,
  };
}
