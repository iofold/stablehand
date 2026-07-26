import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  estimateClockOffset,
  type ClockProbe,
} from './src/clock.js';
import {
  eventTurnId,
  observeTurnEvent,
  type TurnEventObservation,
} from './src/events.js';
import {
  assertModelGatewayRequirement,
  parsePerformanceProfile,
  summarizePerformancePlan,
} from './src/profile.js';
import {
  percentile,
  summarizeTurnSamples,
  type TurnSample,
} from './src/stats.js';
import {
  benchmarkAgentInput,
  benchmarkAgentName,
} from './src/agents.js';
import { mapConcurrent } from './src/pool.js';
import { AgentStreamHub } from './src/stream-hub.js';
import {
  cleanupAllManagedSessions,
  cleanupManagedSessions,
  executeMeasuredTurn,
  refreshPerformanceRunUsage,
  runPerformanceProfile,
} from './src/runner.js';
import {
  parseCpuCores,
  parseMemoryBytes,
  summarizeKubernetesSamples,
} from './src/kubernetes.js';
import {
  buildCapacityWaveProfile,
  evaluateCapacityWave,
  parseCapacityRamp,
  summarizeCapacityEvidence,
} from './src/capacity.js';
import { renderPerformanceReport } from './src/report.js';
import {
  CtxmillControlClient,
  type AgentEventStreamItem,
} from '../../packages/client/src/index.js';

describe('performance statistics', () => {
  it('calculates interpolated percentiles without mutating samples', () => {
    const values = [40, 10, 30, 20];

    expect(percentile(values, 0.5)).toBe(25);
    expect(percentile(values, 0.95)).toBeCloseTo(38.5);
    expect(values).toEqual([40, 10, 30, 20]);
  });

  it('summarizes successful and failed turns while ignoring absent timings', () => {
    const samples: TurnSample[] = [
      {
        turnId: 'turn-1',
        agentId: 'agent-1',
        harness: 'langgraph',
        outcome: 'completed',
        admissionMs: 10,
        timeToFirstTokenMs: 100,
        completionMs: 400,
        eventCount: 8,
      },
      {
        turnId: 'turn-2',
        agentId: 'agent-2',
        harness: 'langgraph',
        outcome: 'error',
        admissionMs: 30,
        completionMs: 500,
        eventCount: 2,
        error: 'provider unavailable',
      },
    ];

    expect(summarizeTurnSamples(samples)).toMatchObject({
      turns: 2,
      completed: 1,
      failed: 1,
      errorRate: 0.5,
      totalEvents: 10,
      totalSseDeliveries: 10,
      timings: {
        admissionMs: { count: 2, p50: 20, min: 10, max: 30 },
        timeToFirstTokenMs: { count: 1, p50: 100 },
        completionMs: { count: 2, p50: 450 },
      },
    });
  });

  it('detects equal-count SSE consumers with different event sequences', () => {
    const sample: TurnSample = {
      turnId: 'turn-1',
      agentId: 'agent-1',
      harness: 'langgraph',
      outcome: 'completed',
      eventCount: 2,
      sseClientEventCounts: [2, 2],
      sseClientEventSequences: [
        ['event-1:RUN_STARTED', 'event-2:RUN_FINISHED'],
        ['event-1:RUN_STARTED', 'event-3:RUN_FINISHED'],
      ],
    };

    expect(summarizeTurnSamples([sample]).sseFanoutMismatches).toBe(1);
  });
});

describe('clock calibration', () => {
  it('uses midpoint offsets and reports median uncertainty', () => {
    const probes: ClockProbe[] = [
      { sentAtMs: 1_000, receivedAtMs: 1_020, serverAtMs: 1_060 },
      { sentAtMs: 2_000, receivedAtMs: 2_010, serverAtMs: 2_055 },
      { sentAtMs: 3_000, receivedAtMs: 3_040, serverAtMs: 3_070 },
    ];

    expect(estimateClockOffset(probes)).toEqual({
      offsetMs: 50,
      uncertaintyMs: 10,
      samples: 3,
    });
  });
});

describe('stream event observation', () => {
  it('extracts canonical and custom turn identities', () => {
    expect(eventTurnId({
      type: 'TEXT_MESSAGE_CONTENT',
      runId: 'turn-run',
      threadId: 'conversation-1',
      messageId: 'message-1',
      delta: 'hello',
    })).toBe('turn-run');
    expect(eventTurnId({
      type: 'CUSTOM',
      name: 'ctxmill.turn.pending',
      turnId: 'turn-custom',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'interactive',
      timestamp: 1,
    })).toBe('turn-custom');
  });

  it('records first-event, run-started, first-token and terminal timestamps once', () => {
    const observation: TurnEventObservation = {};

    observeTurnEvent(observation, {
      type: 'RUN_STARTED',
      runId: 'turn-1',
      threadId: 'conversation-1',
      timestamp: 10,
    }, 100);
    observeTurnEvent(observation, {
      type: 'TEXT_MESSAGE_CONTENT',
      runId: 'turn-1',
      threadId: 'conversation-1',
      messageId: 'message-1',
      delta: 'hello',
      timestamp: 20,
    }, 120);
    observeTurnEvent(observation, {
      type: 'TEXT_MESSAGE_CONTENT',
      runId: 'turn-1',
      threadId: 'conversation-1',
      messageId: 'message-1',
      delta: ' again',
      timestamp: 21,
    }, 125);
    observeTurnEvent(observation, {
      type: 'RUN_FINISHED',
      runId: 'turn-1',
      threadId: 'conversation-1',
      usage: null,
      timestamp: 30,
    }, 160);

    expect(observation).toEqual({
      firstEventAtMs: 100,
      runStartedAtMs: 100,
      firstTokenAtMs: 120,
      terminalAtMs: 160,
      firstServerEventAtMs: 10,
      terminalServerEventAtMs: 30,
      eventCount: 4,
      terminalType: 'RUN_FINISHED',
    });
  });

  it('uses RUN_FINISHED as the authoritative terminal after RUN_ERROR', () => {
    const observation: TurnEventObservation = {};

    observeTurnEvent(observation, {
      type: 'RUN_ERROR',
      runId: 'turn-1',
      threadId: 'conversation-1',
      message: 'provider rejected the request',
      timestamp: 30,
    }, 160);

    expect(observation.terminalAtMs).toBeUndefined();
    expect(observation.terminalType).toBeUndefined();

    observeTurnEvent(observation, {
      type: 'RUN_FINISHED',
      runId: 'turn-1',
      threadId: 'conversation-1',
      usage: null,
      timestamp: 31,
    }, 170);

    expect(observation).toMatchObject({
      terminalAtMs: 170,
      terminalServerEventAtMs: 31,
      terminalType: 'RUN_FINISHED',
    });
  });

  it('does not count the echoed user message as time to first token', () => {
    const observation: TurnEventObservation = {};

    observeTurnEvent(observation, {
      type: 'TEXT_MESSAGE_CONTENT',
      runId: 'turn-1',
      threadId: 'conversation-1',
      messageId: 'user-message-1',
      delta: 'hello',
      timestamp: 10,
    }, 100);
    observeTurnEvent(observation, {
      type: 'RUN_STARTED',
      runId: 'turn-1',
      threadId: 'conversation-1',
      timestamp: 20,
    }, 120);
    observeTurnEvent(observation, {
      type: 'TEXT_MESSAGE_CONTENT',
      runId: 'turn-1',
      threadId: 'conversation-1',
      messageId: 'assistant-message-1',
      delta: 'world',
      timestamp: 30,
    }, 140);

    expect(observation.firstEventAtMs).toBe(100);
    expect(observation.runStartedAtMs).toBe(120);
    expect(observation.firstTokenAtMs).toBe(140);
  });
});

describe('performance profile', () => {
  it('accepts a bounded dev2 stage and applies safe defaults', () => {
    expect(parsePerformanceProfile({
      schemaVersion: 1,
      name: 'dev2-smoke',
      expectedOutput: 'BENCHMARK_OK',
      target: {
        apiBase: 'https://stablehand.staging.example.com/api',
        kubernetesNamespace: 'ctxmill',
      },
      stages: [{
        name: 'langgraph-cold',
        harness: 'langgraph',
        agentPrefix: 'perf-langgraph',
        topology: 'unique-agents',
        sessionMode: 'cold',
        concurrency: 2,
        iterations: 1,
        sseClientsPerAgent: 1,
        prompt: 'Reply with exactly BENCHMARK_OK.',
        harnessConfig: {
          provider: 'openai',
          model: 'gpt-5.4-mini',
          apiKeyRef: '$secret:OPENAI_API_KEY',
        },
      }],
    })).toMatchObject({
      expectedOutput: 'BENCHMARK_OK',
      safety: {
        maxConcurrency: 5,
        abortErrorRate: 0.05,
      },
      stages: [{
        timeoutMs: 120_000,
        settleMs: 2_000,
      }],
    });
  });

  it('rejects stages above the declared safety ceiling', () => {
    expect(() => parsePerformanceProfile({
      schemaVersion: 1,
      name: 'unsafe',
      target: {
        apiBase: 'https://stablehand.staging.example.com/api',
        kubernetesNamespace: 'ctxmill',
      },
      safety: { maxConcurrency: 5 },
      stages: [{
        name: 'too-wide',
        harness: 'pi-agent',
        agentPrefix: 'perf-pi',
        topology: 'unique-agents',
        sessionMode: 'cold',
        concurrency: 6,
        iterations: 1,
        sseClientsPerAgent: 1,
        prompt: 'hello',
        harnessConfig: {
          provider: 'openai',
          model: 'gpt-5.4-mini',
          apiKeyRef: '$secret:OPENAI_API_KEY',
        },
      }],
    })).toThrow(/concurrency 6 exceeds safety.maxConcurrency 5/);
  });

  it('requires an explicit prewarm turn for warm and resume stages', () => {
    expect(() => parsePerformanceProfile({
      schemaVersion: 1,
      name: 'unwarmed',
      target: {
        apiBase: 'https://stablehand.staging.example.com/api',
        kubernetesNamespace: 'ctxmill',
      },
      stages: [{
        name: 'resume',
        harness: 'langgraph',
        agentPrefix: 'perf-langgraph',
        topology: 'unique-agents',
        sessionMode: 'resume',
        concurrency: 1,
        iterations: 1,
        sseClientsPerAgent: 1,
        prompt: 'hello',
        harnessConfig: {
          provider: 'openai',
          model: 'gpt-5.4-mini',
          apiKeyRef: '$secret:OPENAI_API_KEY',
        },
      }],
    })).toThrow(/requires warmupTurns >= 1/);
  });

  it('rejects harness config drift before mutating a remote agent', () => {
    expect(() => parsePerformanceProfile({
      schemaVersion: 1,
      name: 'invalid-claude-config',
      target: {
        apiBase: 'https://stablehand.staging.example.com/api',
        kubernetesNamespace: 'ctxmill',
      },
      stages: [{
        name: 'claude-cold',
        harness: 'claude-agents',
        agentPrefix: 'perf-claude',
        topology: 'unique-agents',
        sessionMode: 'cold',
        concurrency: 1,
        iterations: 1,
        sseClientsPerAgent: 1,
        prompt: 'Reply with exactly BENCHMARK_OK.',
        harnessConfig: {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          maxTokens: 1024,
        },
      }],
    })).toThrow(/Invalid harnessConfig for stage "claude-cold"/);
  });

  it('plans measured, warmup, model-call, and SSE load before execution', () => {
    const profile = parsePerformanceProfile({
      schemaVersion: 1,
      name: 'model-matrix',
      target: {
        apiBase: 'https://stablehand.staging.example.com/api',
        kubernetesNamespace: 'ctxmill',
      },
      requirements: { modelGateway: 'required' },
      safety: {
        maxConcurrency: 3,
        maxTurns: 20,
        maxEstimatedModelCalls: 40,
      },
      stages: [{
        name: 'deepagents-mixed',
        harness: 'langgraph',
        agentPrefix: 'perf-deepagents-mixed',
        topology: 'unique-agents',
        sessionMode: 'warm',
        concurrency: 3,
        iterations: 2,
        warmupTurns: 1,
        expectedModelCallsPerTurn: 4,
        sseClientsPerAgent: 2,
        prompt: 'Delegate once, then reply.',
        harnessConfig: {
          provider: 'openai',
          model: 'gpt-5.4-mini',
          subagents: [{
            name: 'glm-reviewer',
            description: 'Review with GLM.',
            systemPrompt: 'Review concisely.',
            provider: 'openai',
            model: 'cf-glm-5.2',
          }],
        },
      }],
    });

    expect(summarizePerformancePlan(profile)).toEqual({
      stages: [{
        name: 'deepagents-mixed',
        harness: 'langgraph',
        modelRoutes: [
          { provider: 'openai', model: 'gpt-5.4-mini' },
          { provider: 'openai', model: 'cf-glm-5.2' },
        ],
        concurrency: 3,
        measuredTurns: 6,
        warmupTurns: 3,
        totalTurns: 9,
        estimatedModelCalls: 36,
        sseConnections: 6,
      }],
      measuredTurns: 6,
      warmupTurns: 3,
      totalTurns: 9,
      estimatedModelCalls: 36,
      peakConcurrency: 3,
      peakSseConnections: 6,
    });
  });

  it('rejects profiles whose total turn plan exceeds the declared ceiling', () => {
    expect(() => parsePerformanceProfile({
      schemaVersion: 1,
      name: 'too-many-turns',
      target: {
        apiBase: 'https://stablehand.staging.example.com/api',
        kubernetesNamespace: 'ctxmill',
      },
      safety: { maxTurns: 5 },
      stages: [{
        name: 'pi-c3',
        harness: 'pi-agent',
        agentPrefix: 'perf-pi',
        topology: 'unique-agents',
        sessionMode: 'cold',
        concurrency: 3,
        iterations: 2,
        sseClientsPerAgent: 1,
        prompt: 'hello',
        harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
      }],
    })).toThrow(/planned turns 6 exceeds safety.maxTurns 5/);
  });

  it('requires a healthy model gateway when a profile declares one', () => {
    const profile = parsePerformanceProfile({
      schemaVersion: 1,
      name: 'gateway-required',
      target: {
        apiBase: 'https://stablehand.staging.example.com/api',
        kubernetesNamespace: 'ctxmill',
      },
      requirements: { modelGateway: 'required' },
      stages: [{
        name: 'glm',
        harness: 'pi-agent',
        agentPrefix: 'perf-glm',
        topology: 'unique-agents',
        sessionMode: 'cold',
        concurrency: 1,
        iterations: 1,
        sseClientsPerAgent: 1,
        prompt: 'hello',
        harnessConfig: { provider: 'openai', model: 'cf-glm-5.2' },
      }],
    });

    expect(() => assertModelGatewayRequirement(profile, {
      enabled: false,
      profile: null,
      revision: null,
      state: 'disabled',
      watermarkAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lagMs: null,
      lastError: null,
      pendingCalls: 0,
      unpricedCalls: 0,
      quarantinedTransactions: 0,
      orphanTransactions: 0,
    })).toThrow(/requires a healthy model gateway.*disabled/);
  });

  it('fails a required-gateway run before clock probes or agent mutations', async () => {
    const requestedUrls: string[] = [];
    const client = new CtxmillControlClient({
      apiBase: 'https://ctxmill.example/api',
      fetch: async (input) => {
        requestedUrls.push(String(input));
        return new Response(JSON.stringify({
          enabled: false,
          profile: null,
          revision: null,
          state: 'disabled',
          watermarkAt: null,
          lastAttemptAt: null,
          lastSuccessAt: null,
          lagMs: null,
          lastError: null,
          pendingCalls: 0,
          unpricedCalls: 0,
          quarantinedTransactions: 0,
          orphanTransactions: 0,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const profile = parsePerformanceProfile({
      schemaVersion: 1,
      name: 'gateway-preflight',
      target: {
        apiBase: 'https://ctxmill.example/api',
        kubernetesNamespace: 'ctxmill',
      },
      requirements: { modelGateway: 'required' },
      stages: [{
        name: 'glm',
        harness: 'pi-agent',
        agentPrefix: 'perf-glm',
        topology: 'unique-agents',
        sessionMode: 'cold',
        concurrency: 1,
        iterations: 1,
        sseClientsPerAgent: 1,
        prompt: 'hello',
        harnessConfig: { provider: 'openai', model: 'cf-glm-5.2' },
      }],
    });

    await expect(runPerformanceProfile({ client, profile })).rejects.toThrow(
      /requires a healthy model gateway.*disabled/,
    );
    expect(requestedUrls).toEqual([
      'https://ctxmill.example/api/model-gateway/status',
    ]);
  });

  it('ships a current frontier matrix and cheaper volumetric plans', () => {
    const readProfile = (name: string) => parsePerformanceProfile(JSON.parse(
      readFileSync(new URL(`./profiles/${name}.json`, import.meta.url), 'utf8'),
    ));
    const matrix = summarizePerformancePlan(readProfile('dev2-model-matrix'));
    const smoke = readProfile('dev2-smoke');
    const capacity = readProfile('dev2-capacity');
    const fanout = readProfile('dev2-sse-fanout');
    const scale = readProfile('dev2-scale-10');
    const scalePlan = summarizePerformancePlan(scale);
    const gatewayProfiles = [
      smoke,
      capacity,
      fanout,
      scale,
    ];

    expect(new Set(matrix.stages.map((stage) => stage.harness))).toEqual(
      new Set(['langgraph', 'pi-agent']),
    );
    expect(matrix.stages.some((stage) =>
      stage.modelRoutes.some((route) => route.model === 'cf-glm-5.2'))).toBe(true);
    const matrixRoutes = new Set(matrix.stages.flatMap((stage) =>
      stage.modelRoutes.map((route) => `${route.provider}/${route.model}`)));
    expect([...matrixRoutes]).toEqual(expect.arrayContaining([
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.6-luna',
      'anthropic/claude-sonnet-5',
      'anthropic/claude-opus-5',
      'anthropic/claude-haiku-4-5',
      'google/gemini-3.6-flash',
      'google/gemini-3.5-flash-lite',
      'openai/cf-glm-5.2',
    ]));
    expect([...matrixRoutes]).not.toEqual(expect.arrayContaining([
      'openai/gpt-5.4',
      'openai/gpt-5.4-mini',
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-opus-4-6',
    ]));
    expect(matrix).toMatchObject({
      totalTurns: 27,
      estimatedModelCalls: 31,
      peakConcurrency: 1,
    });
    const piGoogleStages = readProfile('dev2-model-matrix').stages.filter((stage) =>
      stage.harness === 'pi-agent' && stage.harnessConfig.provider === 'google');
    expect(piGoogleStages).not.toHaveLength(0);
    expect(piGoogleStages.every((stage) =>
      Number(stage.harnessConfig.maxTokens) >= 256
      && stage.harnessConfig.thinkingLevel === 'minimal')).toBe(true);
    const piQwenStages = readProfile('dev2-model-matrix').stages.filter((stage) =>
      stage.harness === 'pi-agent' && stage.harnessConfig.model === 'cf-qwen3-30b');
    expect(piQwenStages).not.toHaveLength(0);
    expect(piQwenStages.every((stage) =>
      Number(stage.harnessConfig.maxTokens) >= 1024)).toBe(true);
    const volumetricStages = [capacity, fanout, scale]
      .flatMap((profile) => profile.stages)
      .filter((stage) => stage.harness !== 'claude-agents');
    expect(volumetricStages.every((stage) =>
      stage.harnessConfig.provider === 'openai'
      && stage.harnessConfig.model === 'cf-gpt-oss-120b')).toBe(true);
    expect(volumetricStages.every((stage) =>
      stage.harnessConfig.maxTokens === 64)).toBe(true);
    expect(volumetricStages.filter((stage) => stage.harness === 'langgraph')
      .every((stage) => stage.harnessConfig.reasoning === 'off')).toBe(true);
    expect(volumetricStages.filter((stage) => stage.harness === 'pi-agent')
      .every((stage) => stage.harnessConfig.reasoning === true
        && stage.harnessConfig.thinkingLevel === 'minimal')).toBe(true);
    const smokeLangGraphLunaStages = smoke.stages.filter((stage) =>
      stage.harness === 'langgraph'
      && stage.harnessConfig.model === 'gpt-5.6-luna');
    expect(smokeLangGraphLunaStages).not.toHaveLength(0);
    expect(smokeLangGraphLunaStages.every((stage) =>
      stage.harnessConfig.maxTokens === 128
      && stage.harnessConfig.reasoning === 'off')).toBe(true);
    const smokePiLunaStages = smoke.stages.filter((stage) =>
      stage.harness === 'pi-agent'
      && stage.harnessConfig.model === 'gpt-5.6-luna');
    expect(smokePiLunaStages).not.toHaveLength(0);
    expect(smokePiLunaStages.every((stage) =>
      stage.harnessConfig.maxTokens === 128
      && stage.harnessConfig.thinkingLevel === 'minimal')).toBe(true);
    const smokeClaudeStages = smoke.stages.filter((stage) =>
      stage.harness === 'claude-agents');
    expect(smokeClaudeStages).not.toHaveLength(0);
    expect(smokeClaudeStages.every((stage) =>
      Object.keys(stage.harnessConfig).sort().join(',') === 'model,provider')).toBe(true);
    expect(gatewayProfiles.every((profile) =>
      profile.requirements.modelGateway === 'required')).toBe(true);
    expect(gatewayProfiles.flatMap((profile) => profile.stages).every((stage) =>
      stage.harnessConfig.apiKeyRef == null
      && stage.harnessConfig.baseUrl == null)).toBe(true);
    expect(scale.requirements.minGlobalContainers).toBe(10);
    expect(scalePlan).toMatchObject({
      totalTurns: 262,
      estimatedModelCalls: 262,
      peakConcurrency: 10,
      peakSseConnections: 20,
    });
  });

  it('ships a monotonic adaptive ramp through the global ceiling', () => {
    const ramp = parseCapacityRamp(JSON.parse(readFileSync(
      new URL('./profiles/dev2-adaptive-capacity.json', import.meta.url),
      'utf8',
    )));

    expect(ramp.levels).toEqual([1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 80, 100]);
    expect(ramp.maxGlobalContainers).toBe(100);
    expect(new Set(ramp.harnesses.map((stage) => stage.harness))).toEqual(
      new Set(['langgraph', 'pi-agent']),
    );
    expect(ramp.harnesses.every((stage) =>
      stage.harnessConfig.provider === 'openai'
      && stage.harnessConfig.model === 'cf-gpt-oss-120b')).toBe(true);
    expect(ramp.confirmationRuns).toBe(3);
    expect(ramp.gates.minSandboxMetricCoverage).toBe(0.8);
    const wave = buildCapacityWaveProfile(ramp, 8, 2);
    expect(wave).toMatchObject({
      name: 'dev2-adaptive-capacity-c8-r2',
      requirements: { modelGateway: 'required', minGlobalContainers: 8 },
      safety: { maxConcurrency: 8, maxTurns: 16 },
      stages: [
        { harness: 'langgraph', concurrency: 8, iterations: 1 },
        { harness: 'pi-agent', concurrency: 8, iterations: 1 },
      ],
    });
    const controller = readFileSync(
      new URL('./scripts/run-dev2-adaptive-capacity.sh', import.meta.url),
      'utf8',
    );
    expect(controller).toContain('set_limit "$temporary_limit"');
    expect(controller).toContain('ensure_clean_boundary');
    expect(controller).toContain('cli.ts" cleanup');
    expect(controller).toContain('--api-base "$api_base"');
    expect(controller).toContain("trap 'exit 143' TERM");
    expect(controller).toContain('trap - EXIT INT TERM');
    expect(controller).toContain('set_limit "$highest_passed"');
    expect(controller).not.toContain('\\${');

    const sampler = readFileSync(
      new URL('./scripts/sample-dev2-kubernetes.sh', import.meta.url),
      'utf8',
    );
    expect(sampler).toContain('/proxy/stats/summary');
    const traceCollector = readFileSync(
      new URL('./scripts/collect-dev2-traces.sh', import.meta.url),
      'utf8',
    );
    expect(traceCollector).toContain("resources_string['ctxmill.session.id']");
  });

  it('ships bounded warm and resume parity lanes for Deep Agents and PI', () => {
    const lifecycle = parsePerformanceProfile(JSON.parse(readFileSync(
      new URL('./profiles/dev2-harness-lifecycle.json', import.meta.url),
      'utf8',
    )));
    const plan = summarizePerformancePlan(lifecycle);

    expect(new Set(lifecycle.stages.map((stage) =>
      `${stage.harness}:${stage.sessionMode}`))).toEqual(new Set([
      'langgraph:warm',
      'langgraph:resume',
      'pi-agent:warm',
      'pi-agent:resume',
    ]));
    expect(lifecycle.stages.every((stage) =>
      stage.concurrency === 1
      && stage.warmupTurns >= 1
      && stage.sseClientsPerAgent === 2)).toBe(true);
    expect(lifecycle.stages.filter((stage) => stage.harness === 'langgraph')
      .every((stage) => stage.harnessConfig.reasoning === 'off')).toBe(true);
    expect(lifecycle.stages.filter((stage) => stage.harness === 'pi-agent')
      .every((stage) => stage.harnessConfig.reasoning === true
        && stage.harnessConfig.thinkingLevel === 'minimal')).toBe(true);
    expect(plan).toMatchObject({
      measuredTurns: 8,
      warmupTurns: 4,
      totalTurns: 12,
      estimatedModelCalls: 12,
      peakConcurrency: 1,
      peakSseConnections: 2,
    });
  });
});

describe('capacity wave gates', () => {
  const healthy = {
    errorRate: 0,
    sseFanoutMismatches: 0,
    timeToFirstTokenP95Ms: 8_000,
    completionP95Ms: 12_000,
    traceTurnCoverage: 1,
    sandboxTraceCoverage: 1,
    requestedConcurrency: 8,
    peakActiveSandboxJobs: 8,
    sandboxMetricCoverage: 1,
    settledUsageCoverage: 1,
    peakNodeCpuPercent: 55,
    peakNodeMemoryPercent: 30,
    peakPendingSandboxPods: 0,
    activeSandboxJobsAfterSettle: 0,
    activeSandboxContainersAfterSettle: 0,
    queuedSandboxContainersAfterSettle: 0,
    podRestartDelta: 0,
    oomKilledContainers: 0,
    criticalLogMatches: 0,
    gatewayState: 'healthy' as const,
    gatewaySettledThroughWave: true,
    gatewayPendingCalls: 0,
    gatewayUnpricedCalls: 0,
    gatewayQuarantinedTransactions: 0,
    gatewayOrphanTransactions: 0,
    criticalEventMatches: 0,
  };

  it('advances only when correctness, capacity, telemetry, and gateway gates pass', () => {
    expect(evaluateCapacityWave(healthy, {
      maxErrorRate: 0.02,
      maxTimeToFirstTokenP95Ms: 30_000,
      maxCompletionP95Ms: 90_000,
      maxNodeCpuPercent: 75,
      maxNodeMemoryPercent: 75,
      minTraceTurnCoverage: 0.95,
      minSandboxMetricCoverage: 0.8,
    })).toEqual({ decision: 'advance', violations: [] });
  });

  it('stops and explains every unsafe signal rather than running the next wave', () => {
    const result = evaluateCapacityWave({
      ...healthy,
      errorRate: 0.1,
      sseFanoutMismatches: 1,
      traceTurnCoverage: 0.5,
      sandboxTraceCoverage: 0.5,
      peakActiveSandboxJobs: 5,
      sandboxMetricCoverage: 0.25,
      settledUsageCoverage: 0.5,
      peakPendingSandboxPods: 3,
      activeSandboxContainersAfterSettle: 2,
      queuedSandboxContainersAfterSettle: 1,
      podRestartDelta: 1,
      criticalLogMatches: 2,
      criticalEventMatches: 1,
      gatewayState: 'degraded',
      gatewaySettledThroughWave: false,
      gatewayPendingCalls: 4,
    }, {
      maxErrorRate: 0.02,
      maxTimeToFirstTokenP95Ms: 30_000,
      maxCompletionP95Ms: 90_000,
      maxNodeCpuPercent: 75,
      maxNodeMemoryPercent: 75,
      minTraceTurnCoverage: 0.95,
      minSandboxMetricCoverage: 0.8,
    });

    expect(result.decision).toBe('stop');
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.stringMatching(/error rate/),
      expect.stringMatching(/SSE fanout/),
      expect.stringMatching(/trace coverage/),
      expect.stringMatching(/sandbox trace coverage/),
      expect.stringMatching(/active sandbox jobs/),
      expect.stringMatching(/sandbox metric coverage/),
      expect.stringMatching(/settled usage coverage/),
      expect.stringMatching(/Pending sandbox pods/),
      expect.stringMatching(/active sandbox containers/),
      expect.stringMatching(/queued sandbox containers/),
      expect.stringMatching(/pod restart/),
      expect.stringMatching(/critical log/),
      expect.stringMatching(/critical Kubernetes event/),
      expect.stringMatching(/gateway state/),
      expect.stringMatching(/gateway watermark/),
      expect.stringMatching(/pending gateway calls/),
    ]));
  });

  it('derives restart, OOM, trace, log, and gateway evidence from raw artifacts', () => {
    const summary = summarizeCapacityEvidence({
      turns: [{
        turnId: 'turn-1',
        agentId: 'agent-1',
        sandboxSessionId: 'session-1',
        harness: 'langgraph',
        outcome: 'completed',
        timeToFirstTokenMs: 5_000,
        completionMs: 8_000,
        eventCount: 4,
        sseClientEventCounts: [4, 4],
        costCoverage: 'complete',
        modelCallsObserved: 1,
        modelCallsCostKnown: 1,
        modelCallsExpected: 1,
      }, {
        turnId: 'turn-2',
        agentId: 'agent-2',
        sandboxSessionId: 'session-2',
        harness: 'pi-agent',
        outcome: 'completed',
        timeToFirstTokenMs: 7_000,
        completionMs: 10_000,
        eventCount: 5,
        sseClientEventCounts: [5, 5],
        costCoverage: 'complete',
        modelCallsObserved: 1,
        modelCallsCostKnown: 1,
        modelCallsExpected: 1,
      }],
      kubernetes: {
        samples: 2,
        peakNodeCpuPercent: 60,
        peakNodeMemoryPercent: 40,
        peakSandboxPods: 2,
        peakPendingSandboxPods: 1,
        peakPendingSandboxPodsAfterGrace: 0,
        peakActiveSandboxJobs: 2,
        peakRunningSandboxPods: 2,
        sandboxMetricCoverage: 1,
        peakSandboxCpuCores: 0.5,
        peakSandboxMemoryBytes: 512,
        peakOrchestratorCpuCores: 0.2,
        peakOrchestratorMemoryBytes: 256,
        peakModelGatewayCpuCores: 0.1,
        peakModelGatewayMemoryBytes: 128,
      },
      traces: [
        { turn_id: 'turn-1', name: 'ctxmill.turn.execute' },
        { turn_id: 'turn-1', name: 'ctxmill.turn.delivery' },
        { turn_id: 'turn-2', name: 'ctxmill.turn.execute' },
        {
          name: 'POST',
          sandbox_session_id: 'session-1',
          service_name: 'ctxmill-sandbox-langgraph',
          url_path: '/ctxmill.sandbox.v1.HarnessService/DeliverTurn',
        },
      ],
      requestedConcurrency: 2,
      beforePods: { items: [{ status: { containerStatuses: [{ restartCount: 1 }] } }] },
      afterPods: { items: [{ status: { containerStatuses: [{
        restartCount: 2,
        lastState: { terminated: { reason: 'OOMKilled' } },
      }] } }] },
      afterJobs: { items: [{
        metadata: { labels: { 'ctxmill.sandbox-session-id': 'session-1' } },
        status: { active: 1 },
      }] },
      sandbox: { containers: { active: 1, queued: 2 } },
      beforeEvents: { items: [] },
      events: { items: [{ reason: 'FailedScheduling' }] },
      logs: 'healthy\nFATAL worker exited\n',
      beforeGateway: {
        state: 'healthy',
        pendingCalls: 0,
        unpricedCalls: 4,
        quarantinedTransactions: 10,
        orphanTransactions: 2,
      },
      gateway: {
        state: 'healthy',
        pendingCalls: 0,
        unpricedCalls: 5,
        quarantinedTransactions: 12,
        orphanTransactions: 2,
        watermarkAt: 2_000,
        lastSuccessAt: 2_100,
      },
      waveCompletedAtMs: 1_500,
    });

    expect(summary).toMatchObject({
      errorRate: 0,
      timeToFirstTokenP95Ms: 6_900,
      completionP95Ms: 9_900,
      traceTurnCoverage: 0.5,
      sandboxTraceCoverage: 0.5,
      requestedConcurrency: 2,
      peakActiveSandboxJobs: 2,
      sandboxMetricCoverage: 1,
      settledUsageCoverage: 1,
      peakPendingSandboxPods: 0,
      activeSandboxJobsAfterSettle: 1,
      activeSandboxContainersAfterSettle: 1,
      queuedSandboxContainersAfterSettle: 2,
      podRestartDelta: 1,
      oomKilledContainers: 1,
      criticalLogMatches: 1,
      criticalEventMatches: 1,
      gatewayState: 'healthy',
      gatewaySettledThroughWave: true,
      gatewayUnpricedCalls: 1,
      gatewayQuarantinedTransactions: 2,
      gatewayOrphanTransactions: 0,
    });
  });
});

describe('benchmark agent inventory', () => {
  it('builds owned agents from the stage harness contract', () => {
    const profile = parsePerformanceProfile({
      schemaVersion: 1,
      name: 'inventory',
      target: {
        apiBase: 'https://stablehand.staging.example.com/api',
        kubernetesNamespace: 'ctxmill',
      },
      stages: [{
        name: 'pi-cold',
        harness: 'pi-agent',
        agentPrefix: 'perf-pi',
        topology: 'unique-agents',
        sessionMode: 'cold',
        concurrency: 2,
        iterations: 1,
        sseClientsPerAgent: 1,
        prompt: 'hello',
        harnessConfig: {
          provider: 'openai',
          model: 'gpt-5.4-mini',
          apiKeyRef: '$secret:OPENAI_API_KEY',
        },
      }],
    });
    const stage = profile.stages[0]!;

    expect(benchmarkAgentName(stage, 1)).toBe('perf-pi-02');
    expect(benchmarkAgentInput(stage, 1)).toMatchObject({
      name: 'perf-pi-02',
      harness: 'pi-agent',
      harnessConfig: {
        provider: 'openai',
        model: 'gpt-5.4-mini',
      },
      tools: [],
      metadata: {
        'ctxmill.performance.managed': true,
        'ctxmill.performance.stage': 'pi-cold',
      },
    });
  });
});

describe('bounded worker pool', () => {
  it('never executes more operations than its concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const results = await mapConcurrent(
      [1, 2, 3, 4, 5],
      2,
      async (value) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return value * 2;
      },
    );

    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });
});

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.values.push(value);
    }
  }

  close(): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  async *stream(signal?: AbortSignal): AsyncGenerator<T> {
    while (!signal?.aborted) {
      const value = this.values.shift();
      if (value !== undefined) {
        yield value;
        continue;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
        signal?.addEventListener(
          'abort',
          () => resolve({ value: undefined, done: true }),
          { once: true },
        );
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

describe('agent SSE fanout hub', () => {
  it('waits for every consumer and preserves primary TTFT timestamps', async () => {
    const queues = [new AsyncQueue<AgentEventStreamItem>(), new AsyncQueue<AgentEventStreamItem>()];
    let opened = 0;
    const hub = new AgentStreamHub({
      agentId: 'agent-1',
      clients: 2,
      now: (() => {
        let value = 100;
        return () => value += 10;
      })(),
      stream: ({ signal }) => queues[opened++]!.stream(signal),
    });
    const starting = hub.start(1_000);
    for (const queue of queues) {
      queue.push({
        id: null,
        event: {
          type: 'CONNECTED',
          agentId: 'agent-1',
          latestSeq: 0,
          timestamp: 1,
        },
      });
    }
    await starting;
    const terminal = hub.trackTurn('turn-1', 1_000);
    for (const queue of queues) {
      queue.push({
        id: '000000000001',
        event: {
          type: 'RUN_STARTED',
          runId: 'turn-1',
          threadId: 'conversation-1',
          timestamp: 10,
        },
      });
      queue.push({
        id: '000000000002',
        event: {
          type: 'TEXT_MESSAGE_CONTENT',
          runId: 'turn-1',
          threadId: 'conversation-1',
          messageId: 'message-1',
          delta: 'hello',
          timestamp: 20,
        },
      });
      queue.push({
        id: '000000000003',
        event: {
          type: 'RUN_FINISHED',
          runId: 'turn-1',
          threadId: 'conversation-1',
          usage: null,
          timestamp: 30,
        },
      });
    }

    const result = await terminal;
    expect(result.observation).toMatchObject({
      eventCount: 3,
      terminalType: 'RUN_FINISHED',
    });
    expect(result.clientEventCounts).toEqual([3, 3]);
    expect(result.clientEventSequences).toEqual([
      [
        '000000000001:RUN_STARTED',
        '000000000002:TEXT_MESSAGE_CONTENT',
        '000000000003:RUN_FINISHED',
      ],
      [
        '000000000001:RUN_STARTED',
        '000000000002:TEXT_MESSAGE_CONTENT',
        '000000000003:RUN_FINISHED',
      ],
    ]);
    expect(result.observation.firstTokenAtMs).toBeLessThan(
      result.observation.terminalAtMs!,
    );
    await hub.stop();
  });

  it('collects the complete RUN_ERROR then RUN_FINISHED terminal batch for every consumer', async () => {
    const queues = [new AsyncQueue<AgentEventStreamItem>(), new AsyncQueue<AgentEventStreamItem>()];
    let opened = 0;
    const hub = new AgentStreamHub({
      agentId: 'agent-1',
      clients: 2,
      stream: ({ signal }) => queues[opened++]!.stream(signal),
    });
    const starting = hub.start(1_000);
    for (const queue of queues) {
      queue.push({
        id: null,
        event: {
          type: 'CONNECTED',
          agentId: 'agent-1',
          latestSeq: 0,
          timestamp: 1,
        },
      });
    }
    await starting;

    const terminal = hub.trackTurn('turn-1', 1_000);
    const errorEvent: AgentEventStreamItem = {
      id: '000000000001',
      event: {
        type: 'RUN_ERROR',
        runId: 'turn-1',
        threadId: 'conversation-1',
        message: 'provider rejected the request',
        timestamp: 10,
      },
    };
    const finishedEvent: AgentEventStreamItem = {
      id: '000000000002',
      event: {
        type: 'RUN_FINISHED',
        runId: 'turn-1',
        threadId: 'conversation-1',
        usage: null,
        timestamp: 11,
      },
    };

    queues[0]!.push(errorEvent);
    queues[0]!.push(finishedEvent);
    queues[1]!.push(errorEvent);
    setTimeout(() => queues[1]!.push(finishedEvent), 10);

    const result = await terminal;
    expect(result.clientEventCounts).toEqual([2, 2]);
    expect(result.clientEventSequences).toEqual([
      ['000000000001:RUN_ERROR', '000000000002:RUN_FINISHED'],
      ['000000000001:RUN_ERROR', '000000000002:RUN_FINISHED'],
    ]);
    expect(result.observation.terminalType).toBe('RUN_FINISHED');
    await hub.stop();
  });
});

describe('measured turn execution', () => {
  it('cleans sessions for every managed benchmark agent at a wave boundary', async () => {
    const kill = vi.fn().mockResolvedValue(undefined);
    const client = {
      agents: {
        list: vi.fn().mockResolvedValue([
          {
            id: 'agent-owned',
            metadata: { 'ctxmill.performance.managed': true },
          },
          { id: 'agent-other', metadata: null },
        ]),
      },
      sandboxSessions: {
        list: vi.fn().mockResolvedValue([
          { id: 'session-owned', agentId: 'agent-owned' },
          { id: 'session-other', agentId: 'agent-other' },
        ]),
        kill,
      },
    };

    await expect(cleanupAllManagedSessions(client as never, 1_000)).resolves.toBe(1);
    expect(kill).toHaveBeenCalledWith(
      'agent-owned',
      'session-owned',
      { timeoutMs: 1_000 },
    );
  });

  it('kills active benchmark sessions discovered after an aborted turn', async () => {
    const kill = vi.fn().mockResolvedValue(undefined);
    const client = {
      list: vi.fn().mockResolvedValue([
        { id: 'session-owned', agentId: 'agent-owned' },
        { id: 'session-other', agentId: 'agent-other' },
      ]),
      kill,
    };

    await cleanupManagedSessions(client as never, new Set(['agent-owned']), 1_000);

    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith(
      'agent-owned',
      'session-owned',
      { timeoutMs: 1_000 },
    );
  });

  it('lets the API allocate a new conversation and records the returned identity', async () => {
    const startConversationTurn = vi.fn().mockResolvedValue({
      messageId: 'message-1',
      turnId: 'turn-1',
      conversationId: 'conversation-created-by-api',
    });
    const client = {
      turns: {
        startConversationTurn,
        get: vi.fn().mockResolvedValue({
          turn: {
            id: 'turn-1',
            status: 'COMPLETED',
          },
          messages: [],
        }),
      },
    };
    const hub = {
      trackTurn: vi.fn().mockResolvedValue({
        observation: {
          terminalAtMs: 120,
          eventCount: 2,
          terminalType: 'RUN_FINISHED',
        },
        clientEventCounts: [2],
        heartbeatCounts: [0],
      }),
      cancelTurn: vi.fn(),
    };
    const times = [100, 110];

    const sample = await executeMeasuredTurn({
      client: client as never,
      hub,
      runId: 'run-a',
      stageName: 'langgraph-cold',
      harness: 'langgraph',
      agentId: 'agent-1',
      turnId: 'turn-1',
      prompt: 'hello',
      timeoutMs: 1_000,
      clockOffsetMs: 0,
      now: () => times.shift()!,
    });

    expect(startConversationTurn.mock.calls[0]![1]).not.toHaveProperty(
      'conversationId',
    );
    expect(sample.conversationId).toBe('conversation-created-by-api');
  });

  it('correlates admission, SSE, server timestamps, and canonical usage', async () => {
    const client = {
      turns: {
        startConversationTurn: vi.fn().mockResolvedValue({
          messageId: 'message-1',
          turnId: 'turn-1',
          conversationId: 'conversation-1',
        }),
        get: vi.fn().mockResolvedValue({
          turn: {
            id: 'turn-1',
            status: 'COMPLETED',
            usage: {
              inputTokens: 10,
              outputTokens: 4,
              totalTokens: 14,
              modelCalls: { observed: 1, costKnown: 1, expected: 1 },
              cost: {
                totalUsd: 0.001,
                knownUsd: 0.001,
                coverage: 'complete',
              },
            },
          },
          messages: [],
        }),
      },
    };
    const hub = {
      trackTurn: vi.fn().mockResolvedValue({
        observation: {
          firstEventAtMs: 130,
          runStartedAtMs: 135,
          firstTokenAtMs: 150,
          terminalAtMs: 200,
          firstServerEventAtMs: 122,
          terminalServerEventAtMs: 192,
          eventCount: 5,
          terminalType: 'RUN_FINISHED',
        },
        clientEventCounts: [5, 5],
        heartbeatCounts: [0, 0],
      }),
      cancelTurn: vi.fn(),
    };
    const times = [100, 120];

    const sample = await executeMeasuredTurn({
      client: client as never,
      hub,
      runId: 'run-a',
      stageName: 'langgraph-cold',
      harness: 'langgraph',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      prompt: 'hello',
      timeoutMs: 1_000,
      clockOffsetMs: 5,
      now: () => times.shift()!,
    });

    expect(sample).toMatchObject({
      turnId: 'turn-1',
      outcome: 'completed',
      admissionMs: 20,
      timeToFirstEventMs: 30,
      timeToRunStartedMs: 35,
      timeToFirstTokenMs: 50,
      completionMs: 100,
      serverToClientFirstEventLagMs: 13,
      serverToClientTerminalLagMs: 13,
      eventCount: 5,
      sseClientEventCounts: [5, 5],
      totalTokens: 14,
      totalCostUsd: 0.001,
      costCoverage: 'complete',
    });
  });

  it('marks a terminal turn as failed when exact assistant output is absent', async () => {
    const client = {
      turns: {
        startConversationTurn: vi.fn().mockResolvedValue({
          messageId: 'message-1',
          turnId: 'turn-1',
          conversationId: 'conversation-1',
        }),
        get: vi.fn().mockResolvedValue({
          turn: { id: 'turn-1', status: 'COMPLETED' },
          messages: [{ role: 'user', content: 'Reply with BENCHMARK_OK' }],
        }),
      },
    };
    const hub = {
      trackTurn: vi.fn().mockResolvedValue({
        observation: {
          terminalAtMs: 200,
          eventCount: 3,
          terminalType: 'RUN_FINISHED',
        },
        clientEventCounts: [3],
        heartbeatCounts: [0],
      }),
      cancelTurn: vi.fn(),
    };
    const times = [100, 120];

    const sample = await executeMeasuredTurn({
      client: client as never,
      hub,
      runId: 'run-a',
      stageName: 'exact-output',
      harness: 'langgraph',
      agentId: 'agent-1',
      turnId: 'turn-1',
      prompt: 'Reply with BENCHMARK_OK',
      expectedOutput: 'BENCHMARK_OK',
      timeoutMs: 1_000,
      clockOffsetMs: 0,
      now: () => times.shift()!,
    });

    expect(sample).toMatchObject({
      outcome: 'error',
      error: expect.stringMatching(/exact assistant output.*not persisted/i),
    });
  });

  it('refreshes settled usage and recomputes stage summaries', async () => {
    const client = {
      turns: {
        get: vi.fn().mockResolvedValue({
          turn: {
            status: 'COMPLETED',
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15,
              modelCalls: { observed: 1, costKnown: 1, expected: 1 },
              cost: {
                totalUsd: 0.002,
                knownUsd: 0.002,
                coverage: 'complete',
              },
            },
          },
          messages: [],
        }),
      },
    };
    const sample: TurnSample = {
      turnId: 'turn-1',
      agentId: 'agent-1',
      harness: 'langgraph',
      outcome: 'completed',
      eventCount: 4,
      knownCostUsd: 0,
      costCoverage: 'pending',
    };
    const result = {
      stages: [{ samples: [sample], summary: summarizeTurnSamples([sample]) }],
    };

    const refreshed = await refreshPerformanceRunUsage(
      client as never,
      result as never,
    );

    expect(refreshed.stages[0]?.samples[0]).toMatchObject({
      totalTokens: 15,
      modelCallsObserved: 1,
      modelCallsCostKnown: 1,
      modelCallsExpected: 1,
      knownCostUsd: 0.002,
      totalCostUsd: 0.002,
      costCoverage: 'complete',
    });
    expect(refreshed.stages[0]?.summary.usage).toMatchObject({
      totalTokens: 15,
      knownCostUsd: 0.002,
      pricedTurns: 1,
    });
  });
});

describe('Kubernetes resource samples', () => {
  it('normalizes Kubernetes CPU and memory quantities', () => {
    expect(parseCpuCores('250m')).toBe(0.25);
    expect(parseCpuCores('125000000n')).toBe(0.125);
    expect(parseMemoryBytes('256Mi')).toBe(256 * 1024 * 1024);
    expect(parseMemoryBytes('1Gi')).toBe(1024 * 1024 * 1024);
  });

  it('summarizes node pressure and sandbox resource peaks', () => {
    const summary = summarizeKubernetesSamples([{
      timestamp: '2026-07-25T00:00:00.000Z',
      nodeAllocatable: [{
        name: 'dev2',
        cpu: '8',
        memory: '64Gi',
      }],
      nodeMetrics: [{
        name: 'dev2',
        cpu: '4',
        memory: '16Gi',
      }],
      podMetrics: [{
        name: 'ctxmill-orchestrator-1',
        labels: { app: 'ctxmill-orchestrator' },
        containers: [{ name: 'orchestrator', cpu: '500m', memory: '300Mi' }],
      }, {
        name: 'ctxmill-session-1',
        labels: { 'ctxmill.sandbox-session-id': 'session-1' },
        containers: [{ name: 'sandbox', cpu: '750m', memory: '512Mi' }],
      }, {
        name: 'litellm-1',
        labels: { 'app.kubernetes.io/name': 'litellm' },
        containers: [{ name: 'litellm', cpu: '250m', memory: '400Mi' }],
      }],
      podMetricsSource: 'kubelet-summary',
      runningSandboxPods: 2,
      pendingSandboxPods: 1,
      activeSandboxJobs: 2,
    }]);

    expect(summary).toMatchObject({
      samples: 1,
      peakNodeCpuPercent: 50,
      peakNodeMemoryPercent: 25,
      peakSandboxPods: 1,
      peakRunningSandboxPods: 2,
      sandboxMetricCoverage: 0.5,
      peakPendingSandboxPods: 1,
      peakActiveSandboxJobs: 2,
      peakSandboxCpuCores: 0.75,
      peakOrchestratorCpuCores: 0.5,
      peakModelGatewayCpuCores: 0.25,
      peakModelGatewayMemoryBytes: 400 * 1024 * 1024,
    });
  });
});

describe('performance report', () => {
  it('renders TTFT, resume, throughput, fanout, and resource evidence', () => {
    const report = renderPerformanceReport({
      schemaVersion: 2,
      runId: 'run-1',
      profile: 'dev2-smoke',
      target: {
        apiBase: 'https://stablehand.staging.example.com/api',
        kubernetesNamespace: 'ctxmill',
      },
      requirements: { modelGateway: 'optional' },
      plan: {
        stages: [{
          name: 'resume',
          harness: 'langgraph',
          modelRoutes: [{ provider: 'openai', model: 'gpt-5.4-mini' }],
          concurrency: 1,
          measuredTurns: 1,
          warmupTurns: 1,
          totalTurns: 2,
          estimatedModelCalls: 2,
          sseConnections: 2,
        }],
        measuredTurns: 1,
        warmupTurns: 1,
        totalTurns: 2,
        estimatedModelCalls: 2,
        peakConcurrency: 1,
        peakSseConnections: 2,
      },
      modelGateway: null,
      startedAt: '2026-07-25T00:00:00.000Z',
      completedAt: '2026-07-25T00:01:00.000Z',
      clock: {
        estimate: { offsetMs: 2, uncertaintyMs: 3, samples: 5 },
        probes: [],
      },
      stages: [{
        stage: parsePerformanceProfile({
          schemaVersion: 1,
          name: 'nested',
          target: {
            apiBase: 'https://stablehand.staging.example.com/api',
            kubernetesNamespace: 'ctxmill',
          },
          stages: [{
            name: 'resume',
            harness: 'langgraph',
            agentPrefix: 'perf-lg',
            topology: 'unique-agents',
            sessionMode: 'resume',
            concurrency: 1,
            iterations: 1,
            sseClientsPerAgent: 2,
            warmupTurns: 1,
            prompt: 'hello',
            harnessConfig: {
              provider: 'openai',
              model: 'gpt-5.4-mini',
              apiKeyRef: '$secret:OPENAI_API_KEY',
            },
          }],
        }).stages[0]!,
        startedAt: '2026-07-25T00:00:00.000Z',
        completedAt: '2026-07-25T00:00:10.000Z',
        wallMs: 10_000,
        turnsPerSecond: 0.1,
        eventsPerSecond: 0.5,
        sseDeliveriesPerSecond: 1,
        samples: [],
        summary: {
          turns: 1,
          completed: 1,
          failed: 0,
          errorRate: 0,
          totalEvents: 5,
          totalSseDeliveries: 10,
          sseFanoutMismatches: 0,
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            knownCostUsd: 0.001,
            totalCostUsd: 0.001,
            pricedTurns: 1,
            pendingTurns: 0,
            partialTurns: 0,
            unpricedTurns: 0,
            modelCallsObserved: 1,
            modelCallsCostKnown: 1,
            modelCallsExpected: 1,
          },
          timings: {
            timeToFirstTokenMs: {
              count: 1, min: 100, max: 100, mean: 100, p50: 100, p95: 100, p99: 100,
            },
            restoreMs: {
              count: 1, min: 500, max: 500, mean: 500, p50: 500, p95: 500, p99: 500,
            },
          },
        },
      }],
    }, {
      samples: 1,
      peakNodeCpuPercent: 50,
      peakNodeMemoryPercent: 25,
      peakSandboxPods: 1,
      peakRunningSandboxPods: 1,
      sandboxMetricCoverage: 1,
      peakPendingSandboxPods: 0,
      peakPendingSandboxPodsAfterGrace: 0,
      peakActiveSandboxJobs: 1,
      peakSandboxCpuCores: 0.75,
      peakSandboxMemoryBytes: 512 * 1024 * 1024,
      peakOrchestratorCpuCores: 0.5,
      peakOrchestratorMemoryBytes: 300 * 1024 * 1024,
      peakModelGatewayCpuCores: 0.25,
      peakModelGatewayMemoryBytes: 400 * 1024 * 1024,
    });

    expect(report).toContain('Time to first token');
    expect(report).toContain('openai/gpt-5.4-mini');
    expect(report).toContain('Restore p95');
    expect(report).toContain('SSE fanout mismatches');
    expect(report).toContain('Peak node CPU');
  });
});
