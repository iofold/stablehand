import { describe, expect, it, vi } from 'vitest';

import { createTriggerRunCallback, triggerConversationId } from '../container.js';
import type { DatabaseRepository } from '../../database/repository.js';
import type { TurnStartupService } from '../../orchestrator/turn-startup-service.js';
import type { TypedEventBus } from '../../events/bus.js';

describe('createTriggerRunCallback', () => {
  it('preserves trigger depth on trigger.fired events after a background run completes', async () => {
    const agent = { id: 'agent-1', harness: 'langgraph' } as NonNullable<Awaited<ReturnType<DatabaseRepository['getAgent']>>>;
    const preparedRun = { turnId: 'turn-1' } as Awaited<ReturnType<TurnStartupService['prepareTurnStart']>>;
    const db: Pick<DatabaseRepository, 'getAgent'> = {
      getAgent: vi.fn().mockResolvedValue(agent),
    };
    const turnStartupService: Pick<TurnStartupService, 'prepareTurnStart' | 'requestDispatch'> = {
      prepareTurnStart: vi.fn().mockResolvedValue(preparedRun),
      requestDispatch: vi.fn((_start: unknown, _agentId: string, options?: { onSuccess?: () => void }) => {
        options?.onSuccess?.();
      }),
    };
    const eventBus: Pick<TypedEventBus, 'emit'> = {
      emit: vi.fn(),
    };

    const callback = createTriggerRunCallback({ db, turnStartupService, eventBus });
    await callback('agent-1', 'follow-up task', 'trigger-1', 3);
    await Promise.resolve();

    expect(turnStartupService.prepareTurnStart).toHaveBeenCalledWith(expect.objectContaining({
      agent,
      agentId: 'agent-1',
      content: 'follow-up task',
      mode: 'background',
      emitUserMessageEvent: false,
    }));
    expect(turnStartupService.requestDispatch).toHaveBeenCalledWith(
      preparedRun,
      'agent-1',
      { onSuccess: expect.any(Function) },
    );
    expect(eventBus.emit).toHaveBeenCalledWith('trigger.fired', expect.objectContaining({
      triggerId: 'trigger-1',
      agentId: 'agent-1',
      turnId: 'turn-1',
      _triggerDepth: 3,
    }));
  });

  it('passes inherited trigger and event tags to the turn it starts (ctx-89id)', async () => {
    const agent = { id: 'agent-1', harness: 'langgraph' } as NonNullable<Awaited<ReturnType<DatabaseRepository['getAgent']>>>;
    const preparedRun = { turnId: 'turn-1' } as Awaited<ReturnType<TurnStartupService['prepareTurnStart']>>;
    const db: Pick<DatabaseRepository, 'getAgent'> = {
      getAgent: vi.fn().mockResolvedValue(agent),
    };
    const turnStartupService: Pick<TurnStartupService, 'prepareTurnStart' | 'requestDispatch'> = {
      prepareTurnStart: vi.fn().mockResolvedValue(preparedRun),
      requestDispatch: vi.fn(),
    };
    const eventBus: Pick<TypedEventBus, 'emit'> = { emit: vi.fn() };

    const callback = createTriggerRunCallback({ db, turnStartupService, eventBus });
    await callback('agent-1', 'task', 'trigger-1', 1, 7, { tags: { campaign: 'bugfarm-1' } });
    await callback('agent-1', 'task', 'trigger-1', 1, 8);

    // Inherited tags never fail a firing that continues an existing thread.
    expect(turnStartupService.prepareTurnStart).toHaveBeenNthCalledWith(1, expect.objectContaining({
      tags: { campaign: 'bugfarm-1' },
      keepConversationTags: true,
    }));
    expect(turnStartupService.prepareTurnStart).toHaveBeenNthCalledWith(2, expect.not.objectContaining({
      tags: expect.anything(),
    }));
  });

  it('omits trigger depth when the source event was not already inside a cascade', async () => {
    const agent = { id: 'agent-1', harness: 'langgraph' } as NonNullable<Awaited<ReturnType<DatabaseRepository['getAgent']>>>;
    const preparedRun = { turnId: 'turn-1' } as Awaited<ReturnType<TurnStartupService['prepareTurnStart']>>;
    const db: Pick<DatabaseRepository, 'getAgent'> = {
      getAgent: vi.fn().mockResolvedValue(agent),
    };
    const turnStartupService: Pick<TurnStartupService, 'prepareTurnStart' | 'requestDispatch'> = {
      prepareTurnStart: vi.fn().mockResolvedValue(preparedRun),
      requestDispatch: vi.fn((_start: unknown, _agentId: string, options?: { onSuccess?: () => void }) => {
        options?.onSuccess?.();
      }),
    };
    const eventBus: Pick<TypedEventBus, 'emit'> = {
      emit: vi.fn(),
    };

    const callback = createTriggerRunCallback({ db, turnStartupService, eventBus });
    await callback('agent-1', 'follow-up task', 'trigger-1');
    await Promise.resolve();

    expect(eventBus.emit).toHaveBeenCalledWith('trigger.fired', expect.not.objectContaining({
      _triggerDepth: expect.anything(),
    }));
  });

  it('continues the derived conversation when the firing carries a thread key', async () => {
    const agent = { id: 'agent-1', harness: 'langgraph' } as NonNullable<Awaited<ReturnType<DatabaseRepository['getAgent']>>>;
    const preparedRun = { turnId: 'turn-1' } as Awaited<ReturnType<TurnStartupService['prepareTurnStart']>>;
    const db: Pick<DatabaseRepository, 'getAgent'> = {
      getAgent: vi.fn().mockResolvedValue(agent),
    };
    const turnStartupService: Pick<TurnStartupService, 'prepareTurnStart' | 'requestDispatch'> = {
      prepareTurnStart: vi.fn().mockResolvedValue(preparedRun),
      requestDispatch: vi.fn(),
    };
    const eventBus: Pick<TypedEventBus, 'emit'> = { emit: vi.fn() };

    const callback = createTriggerRunCallback({ db, turnStartupService, eventBus });
    await callback('agent-1', 'reply to this', 'trigger-1', 1, 7, { conversationKey: '<root@example.com>' });
    await callback('agent-1', 'no thread', 'trigger-1', 1, 8);

    const conversationId = triggerConversationId('agent-1', '<root@example.com>');
    expect(conversationId).toMatch(/^thread-[0-9a-f]{32}$/);
    expect(triggerConversationId('agent-2', '<root@example.com>')).not.toBe(conversationId);
    expect(triggerConversationId('agent-1', '<root@example.com>')).toBe(conversationId);
    expect(turnStartupService.prepareTurnStart).toHaveBeenNthCalledWith(1, expect.objectContaining({
      content: 'reply to this',
      conversationId,
      createMissingConversationWithRequestedId: true,
    }));
    expect(turnStartupService.prepareTurnStart).toHaveBeenNthCalledWith(2, expect.not.objectContaining({
      conversationId: expect.anything(),
    }));
  });
});
