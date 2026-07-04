import { describe, expect, it, vi } from 'vitest';

import { createTriggerRunCallback } from '../container.js';
import type { DatabaseRepository } from '../../database/repository.js';
import type { RunStartupService } from '../../orchestrator/run-startup-service.js';
import type { TypedEventBus } from '../../events/bus.js';

describe('createTriggerRunCallback', () => {
  it('preserves trigger depth on trigger.fired events after a background run completes', async () => {
    const agent = { id: 'agent-1' } as NonNullable<Awaited<ReturnType<DatabaseRepository['getAgent']>>>;
    const preparedRun = { turnId: 'turn-1' } as Awaited<ReturnType<RunStartupService['prepareRunStart']>>;
    const db: Pick<DatabaseRepository, 'getAgent'> = {
      getAgent: vi.fn().mockResolvedValue(agent),
    };
    const runStartupService: Pick<RunStartupService, 'prepareRunStart' | 'launchPreparedRun'> = {
      prepareRunStart: vi.fn().mockResolvedValue(preparedRun),
      launchPreparedRun: vi.fn(async (_start: unknown, _agentId: string, options?: { onSuccess?: () => void }) => {
        options?.onSuccess?.();
      }),
    };
    const eventBus: Pick<TypedEventBus, 'emit'> = {
      emit: vi.fn(),
    };

    const callback = createTriggerRunCallback({ db, runStartupService, eventBus });
    await callback('agent-1', 'follow-up task', 'trigger-1', 3);
    await Promise.resolve();

    expect(runStartupService.prepareRunStart).toHaveBeenCalledWith(expect.objectContaining({
      agent,
      agentId: 'agent-1',
      content: 'follow-up task',
      mode: 'background',
      emitUserMessageEvent: false,
    }));
    expect(runStartupService.launchPreparedRun).toHaveBeenCalledWith(
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

  it('omits trigger depth when the source event was not already inside a cascade', async () => {
    const agent = { id: 'agent-1' } as NonNullable<Awaited<ReturnType<DatabaseRepository['getAgent']>>>;
    const preparedRun = { turnId: 'turn-1' } as Awaited<ReturnType<RunStartupService['prepareRunStart']>>;
    const db: Pick<DatabaseRepository, 'getAgent'> = {
      getAgent: vi.fn().mockResolvedValue(agent),
    };
    const runStartupService: Pick<RunStartupService, 'prepareRunStart' | 'launchPreparedRun'> = {
      prepareRunStart: vi.fn().mockResolvedValue(preparedRun),
      launchPreparedRun: vi.fn(async (_start: unknown, _agentId: string, options?: { onSuccess?: () => void }) => {
        options?.onSuccess?.();
      }),
    };
    const eventBus: Pick<TypedEventBus, 'emit'> = {
      emit: vi.fn(),
    };

    const callback = createTriggerRunCallback({ db, runStartupService, eventBus });
    await callback('agent-1', 'follow-up task', 'trigger-1');
    await Promise.resolve();

    expect(eventBus.emit).toHaveBeenCalledWith('trigger.fired', expect.not.objectContaining({
      _triggerDepth: expect.anything(),
    }));
  });
});
