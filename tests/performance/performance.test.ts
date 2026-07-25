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
  parsePerformanceProfile,
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
import { executeMeasuredTurn } from './src/runner.js';
import {
  parseCpuCores,
  parseMemoryBytes,
  summarizeKubernetesSamples,
} from './src/kubernetes.js';
import { renderPerformanceReport } from './src/report.js';
import type {
  AgentEventStreamItem,
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
        harnessConfig: {
          provider: 'openai',
          model: 'gpt-5.4-mini',
          apiKeyRef: '$secret:OPENAI_API_KEY',
        },
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
    expect(result.observation.firstTokenAtMs).toBeLessThan(
      result.observation.terminalAtMs!,
    );
    await hub.stop();
  });
});

describe('measured turn execution', () => {
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
      }],
      pendingSandboxPods: 1,
      activeSandboxJobs: 2,
    }]);

    expect(summary).toMatchObject({
      samples: 1,
      peakNodeCpuPercent: 50,
      peakNodeMemoryPercent: 25,
      peakSandboxPods: 1,
      peakPendingSandboxPods: 1,
      peakActiveSandboxJobs: 2,
      peakSandboxCpuCores: 0.75,
      peakOrchestratorCpuCores: 0.5,
    });
  });
});

describe('performance report', () => {
  it('renders TTFT, resume, throughput, fanout, and resource evidence', () => {
    const report = renderPerformanceReport({
      schemaVersion: 1,
      runId: 'run-1',
      profile: 'dev2-smoke',
      target: {
        apiBase: 'https://stablehand.staging.example.com/api',
        kubernetesNamespace: 'ctxmill',
      },
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
            unpricedTurns: 0,
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
      peakPendingSandboxPods: 0,
      peakActiveSandboxJobs: 1,
      peakSandboxCpuCores: 0.75,
      peakSandboxMemoryBytes: 512 * 1024 * 1024,
      peakOrchestratorCpuCores: 0.5,
      peakOrchestratorMemoryBytes: 300 * 1024 * 1024,
    });

    expect(report).toContain('Time to first token');
    expect(report).toContain('Restore p95');
    expect(report).toContain('SSE fanout mismatches');
    expect(report).toContain('Peak node CPU');
  });
});
