import { describe, expect, it, vi } from 'vitest';

import type {
  PerformanceAttributes,
  PerformancePhase,
} from '../../../observability/performance.js';
import type { SandboxSessionRow } from '../../../database/repository.js';
import { SessionRecoveryCoordinator } from '../session-recovery-coordinator.js';

describe('SessionRecoveryCoordinator performance instrumentation', () => {
  it('measures checkpoint restore attempts with session correlation', async () => {
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
    const coordinator = new SessionRecoveryCoordinator({
      performance,
    } as never);
    const session = {
      id: 'session-1',
      conversationId: 'conversation-1',
      agentId: 'agent-1',
      harnessName: 'langgraph',
      status: 'ACTIVE',
    } as unknown as SandboxSessionRow;

    await expect(coordinator.restoreFromCheckpointOnce(session, {
      name: 'agent-1',
      harness: 'langgraph',
      harnessConfig: {},
      systemPrompt: 'test',
      tools: [],
    })).rejects.toThrow(/requires CHECKPOINTED status/);

    expect(measured).toEqual([{
      phase: 'session.restore',
      attributes: expect.objectContaining({
        'ctxmill.harness': 'langgraph',
        'ctxmill.session.id': 'session-1',
        'ctxmill.agent.id': 'agent-1',
        'ctxmill.conversation.id': 'conversation-1',
        'ctxmill.session.state': 'checkpointed',
      }),
      outcome: 'error',
    }]);
  });
});
