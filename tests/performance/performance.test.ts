import { describe, expect, it } from 'vitest';

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
  parsePerformanceProfile,
} from './src/profile.js';
import {
  percentile,
  summarizeTurnSamples,
  type TurnSample,
} from './src/stats.js';

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
      timings: {
        admissionMs: { count: 2, p50: 20, min: 10, max: 30 },
        timeToFirstTokenMs: { count: 1, p50: 100 },
        completionMs: { count: 2, p50: 450 },
      },
    });
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
});

describe('performance profile', () => {
  it('accepts a bounded dev2 stage and applies safe defaults', () => {
    expect(parsePerformanceProfile({
      schemaVersion: 1,
      name: 'dev2-smoke',
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
      }],
    })).toMatchObject({
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
      }],
    })).toThrow(/concurrency 6 exceeds safety.maxConcurrency 5/);
  });
});
