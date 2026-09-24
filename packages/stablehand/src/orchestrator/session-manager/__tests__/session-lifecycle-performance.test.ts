import { describe, expect, it, vi } from 'vitest';

import type {
  PerformanceAttributes,
  PerformancePhase,
} from '../../../observability/performance.js';
import { SessionLifecycleService } from '../session-lifecycle-service.js';

describe('SessionLifecycleService performance instrumentation', () => {
  it('measures checkpoint attempts even when the active session is missing', async () => {
    const measured: Array<{
      phase: PerformancePhase;
      attributes: PerformanceAttributes;
      outcome?: string;
    }> = [];
    const performance = {
      measure: vi.fn(async <T>(
        phase: PerformancePhase,
        attributes: PerformanceAttributes,
        operation: () => Promise<T>,
      ): Promise<T> => {
        const observation = { phase, attributes, outcome: undefined as string | undefined };
        measured.push(observation);
        try {
          const result = await operation();
          observation.outcome = 'ok';
          return result;
        } catch (error) {
          observation.outcome = 'error';
          throw error;
        }
      }),
    };
    const service = new SessionLifecycleService({
      stateStore: {
        getSessionById: vi.fn().mockReturnValue(undefined),
      },
      performance,
    } as never);

    await expect(service.suspendSession(
      'session-1',
      'performance-test',
    )).rejects.toThrow(/not found in active sessions/);

    expect(measured).toEqual([{
      phase: 'checkpoint.suspend',
      attributes: expect.objectContaining({
        'stablehand.session.id': 'session-1',
        'stablehand.checkpoint.reason': 'performance-test',
      }),
      outcome: 'error',
    }]);
  });
});
