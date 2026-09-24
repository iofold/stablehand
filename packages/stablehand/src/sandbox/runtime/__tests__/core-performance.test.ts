import { describe, expect, it, vi } from 'vitest';

import type {
  PerformanceAttributes,
  PerformanceMeasurement,
  PerformancePhase,
} from '../../../observability/performance.js';
import {
  SandboxContainerCore,
  type SandboxRuntimeDriver,
} from '../core.js';

function createPerformanceRecorder() {
  const observations: Array<{
    phase: PerformancePhase;
    attributes: PerformanceAttributes;
    outcome?: string;
  }> = [];
  const start = vi.fn((
    phase: PerformancePhase,
    attributes: PerformanceAttributes,
  ): PerformanceMeasurement => {
    const observation = { phase, attributes, outcome: undefined as string | undefined };
    observations.push(observation);
    return {
      setAttribute: vi.fn(),
      end: vi.fn((outcome = 'ok') => {
        observation.outcome = outcome;
        return { phase, durationMs: 1, outcome };
      }),
    };
  });
  const measure = vi.fn(async <T>(
    phase: PerformancePhase,
    attributes: PerformanceAttributes,
    operation: () => Promise<T>,
  ): Promise<T> => {
    observations.push({ phase, attributes, outcome: 'ok' });
    return operation();
  });

  return { observations, performance: { start, measure } };
}

function createDriver() {
  return {
    createContainer: vi.fn().mockResolvedValue({
      containerId: 'container-1',
      containerName: 'stablehand-session-1',
      sessionId: 'session-1',
      agentId: 'agent-1',
      harnessName: 'langgraph',
      status: 'created',
    }),
  } as unknown as SandboxRuntimeDriver;
}

describe('SandboxContainerCore performance instrumentation', () => {
  it('measures semaphore queue time separately from runtime creation', async () => {
    const recorder = createPerformanceRecorder();
    const core = new SandboxContainerCore({
      driver: createDriver(),
      maxGlobalContainers: 2,
      queueTimeoutMs: 1_000,
      loggerTag: '[test]',
      runtime: 'kubernetes',
      performance: recorder.performance,
    });

    await core.createContainer({
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      agentId: 'agent-1',
      harnessName: 'langgraph',
    });

    expect(recorder.observations).toEqual([
      {
        phase: 'sandbox.queue',
        attributes: expect.objectContaining({
          'stablehand.runtime': 'kubernetes',
          'stablehand.harness': 'langgraph',
          'stablehand.session.id': 'session-1',
        }),
        outcome: 'ok',
      },
      {
        phase: 'sandbox.create',
        attributes: expect.objectContaining({
          'stablehand.runtime': 'kubernetes',
          'stablehand.harness': 'langgraph',
          'stablehand.session.id': 'session-1',
        }),
        outcome: 'ok',
      },
    ]);
  });
});
