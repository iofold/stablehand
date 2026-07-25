import { describe, expect, it, vi } from 'vitest';

import type {
  PerformanceAttributes,
  PerformancePhase,
} from '../../../observability/performance.js';
import { SessionRuntimeFactory } from '../session-runtime-factory.js';

describe('SessionRuntimeFactory performance instrumentation', () => {
  it('measures failed cold-session creation with harness correlation', async () => {
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
    const factory = new SessionRuntimeFactory({
      containerManager: {
        createContainer: vi.fn().mockRejectedValue(new Error('capacity unavailable')),
        startContainer: vi.fn(),
        stopContainer: vi.fn(),
        removeContainer: vi.fn(),
      },
      db: {
        createSandboxSession: vi.fn(),
      },
      buildSandboxSecrets: vi.fn().mockResolvedValue({}),
      resolveToolsForAgent: vi.fn().mockReturnValue([]),
      checkConcurrencyLimit: vi.fn(),
      resolveRuntimeDefinitionHash: vi.fn().mockResolvedValue('definition-hash'),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      performance,
    });

    await expect(factory.createFreshSession(
      'conversation-1',
      {
        name: 'agent-1',
        harness: 'pi-agent',
        harnessConfig: {},
        systemPrompt: 'test',
        tools: [],
      },
      'agent-1',
    )).rejects.toThrow('capacity unavailable');

    expect(measured).toEqual(expect.arrayContaining([
      {
        phase: 'session.create',
        attributes: expect.objectContaining({
          'ctxmill.harness': 'pi-agent',
          'ctxmill.agent.id': 'agent-1',
          'ctxmill.conversation.id': 'conversation-1',
          'ctxmill.session.state': 'cold',
        }),
        outcome: 'error',
      },
    ]));
  });
});
