import { describe, expect, it, vi } from 'vitest';

import { createTestTurnStartupService } from './turn-startup-test-helper.js';

/**
 * ctx-z5k0 regression: the admission-time concurrency reservation must be
 * returned when a prepared turn is handed to the dispatcher. The durable
 * queued row is the entire handoff — dispatchQueuedTurn takes its own
 * reservation at claim time — so holding the admission reservation leaks one
 * unit per admitted turn and permanently starves the agent once the leak
 * reaches maxConcurrentSessionsPerAgent (observed on dev2 2026-08-13: every
 * dispatch returned silent no_capacity with zero live sessions).
 */
describe('requestDispatch concurrency reservation handoff', () => {
  const preparedStart = (release: () => void) => ({
    agentDef: { id: 'agent-1', name: 'a', harness: 'langgraph', harnessConfig: {} },
    conversationId: 'conv-1',
    turnId: 'turn-1',
    messageId: 'msg-1',
    messages: [],
    mode: 'interactive' as const,
    taskDescription: 'hi',
    concurrencyReservation: { agentId: 'agent-1', id: 'res-1', release },
    // launchPreparedTurn requires turnSecrets-compatible shape; requestDispatch
    // itself never opens it.
    turnSecrets: {},
  });

  it('releases the admission reservation when handing off to the dispatcher', () => {
    const service = createTestTurnStartupService();
    const release = vi.fn();
    const kick = vi.fn();
    service.setDispatchKick(kick);

    service.requestDispatch(preparedStart(release) as never, 'agent-1');

    expect(kick).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps the reservation on the legacy direct-launch path', async () => {
    const executeTurn = vi.fn(async () => {});
    const service = createTestTurnStartupService({
      agentTurnService: { executeTurn } as never,
    });
    const release = vi.fn();

    // No dispatch kick configured: requestDispatch falls back to direct launch,
    // where executeTurn owns the reservation lifecycle.
    service.requestDispatch(preparedStart(release) as never, 'agent-1');
    await vi.waitFor(() => expect(executeTurn).toHaveBeenCalledTimes(1));

    expect(release).not.toHaveBeenCalled();
    const passed = (executeTurn.mock.calls as unknown[][])[0]?.[0] as
      | { concurrencyReservation?: { id: string } }
      | undefined;
    expect(passed?.concurrencyReservation?.id).toBe('res-1');
  });
});
