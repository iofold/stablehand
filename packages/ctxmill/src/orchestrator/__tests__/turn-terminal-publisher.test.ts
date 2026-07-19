import { describe, expect, it, vi } from 'vitest';

const PENDING_TURN = {
  id: 'turn-1',
  sandboxSessionId: 'sandbox-1',
  agentId: 'agent-1',
  conversationId: 'conv-1',
  mode: 'interactive',
  taskDescription: 'test',
  status: 'error' as const,
  userMessageId: null,
  startedAt: 100,
  completedAt: 150,
  error: 'boom',
  inputTokens: 3,
  outputTokens: 4,
  totalTokens: 7,
  costUsd: null,
  nextMessageSeq: 0,
  terminalPublishedSeq: null,
  tags: {},
};

describe('terminal publication recovery', () => {
  it('rebuilds every unpublished terminal row through awaited durable emit', async () => {
    const publisherModule = await import('../turn-terminal-publisher.js').catch(() => null);
    expect(publisherModule).not.toBeNull();
    expect(publisherModule?.reconcilePendingTerminalPublishesOnStartup).toBeTypeOf('function');
    if (!publisherModule) return;

    const db = {
      getTurnsPendingCanonicalTerminalPublish: vi.fn().mockResolvedValue([
        PENDING_TURN,
        {
          ...PENDING_TURN,
          id: 'turn-2',
          status: 'completed',
          error: null,
          completedAt: 300,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
        },
      ]),
    };
    const eventBus = { emitAsync: vi.fn().mockResolvedValue(undefined) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const rebuilt = await publisherModule.reconcilePendingTerminalPublishesOnStartup({
      db,
      eventBus,
      logger,
    });

    expect(rebuilt).toBe(2);
    expect(eventBus.emitAsync).toHaveBeenNthCalledWith(1, 'turn.completed', {
      turnId: 'turn-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      status: 'error',
      error: 'boom',
      durationMs: 50,
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      timestamp: 150,
    });
    expect(eventBus.emitAsync).toHaveBeenNthCalledWith(2, 'turn.completed', {
      turnId: 'turn-2',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      status: 'completed',
      durationMs: 200,
      timestamp: 300,
    });
    expect(logger.info).toHaveBeenCalledWith(
      '[TurnTerminalPublisher] rebuilt %d canonical terminal event(s) from durable rows',
      2,
    );
  });
});
