import { describe, expect, test, vi } from 'vitest';

import type { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import { buildAgentDefinition } from '../../packages/ctxmill/src/orchestrator/agent-definition.js';
import { RunStartupService } from '../../packages/ctxmill/src/orchestrator/run-startup-service.js';

type StoredAgent = NonNullable<Awaited<ReturnType<DatabaseRepository['getAgent']>>>;

function createService() {
  return new RunStartupService({
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  });
}

function createAgent(overrides: Partial<StoredAgent> = {}): StoredAgent {
  return {
    id: 'agent-1',
    name: 'assistant',
    harness: 'langgraph',
    harnessConfig: '{"model":"gpt-5.4-mini"}',
    systemPrompt: 'You are helpful.',
    tools: ['search'],
    description: 'Agent description',
    workspaceDir: '/tmp/project/agents/assistant',
    status: 'ready',
    manifest: null,
    version: 1,
    metadata: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createExecutionMocks() {
  const db = {
    addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    createConversation: vi.fn().mockResolvedValue({ id: 'conv-new', agentId: 'agent-1' }),
    createTurn: vi.fn().mockImplementation(async (input: { id?: string }) => ({ id: input.id ?? 'turn-1' })),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn().mockResolvedValue(createAgent()),
    getConversation: vi.fn().mockResolvedValue({ id: 'conv-existing', agentId: 'agent-1' }),
    getMessages: vi.fn().mockResolvedValue([
      {
        id: 'msg-user-1',
        agentId: 'agent-1',
        conversationId: 'conv-existing',
        role: 'user',
        content: 'hello',
        createdAt: Date.now(),
      },
    ]),
    getTurn: vi.fn().mockResolvedValue(null),
    updateTurn: vi.fn().mockResolvedValue(undefined),
    finalizeTurnIfOpen: vi.fn().mockResolvedValue(true),
  } satisfies Parameters<RunStartupService['configureExecution']>[0]['db'];

  const eventBus = {
    emit: vi.fn(),
  };

  const sessionManager: {
    checkConcurrencyLimit: ReturnType<typeof vi.fn>;
    reserveConcurrencySlot?: ReturnType<typeof vi.fn>;
  } = {
    checkConcurrencyLimit: vi.fn(),
  };

  const agentSessionService = {
    executeSession: vi.fn().mockResolvedValue(undefined),
  };

  return {
    db,
    eventBus,
    sessionManager,
    agentSessionService,
  };
}

describe('RunStartupService', () => {
  describe('prepareRunStart', () => {
    test('creates a conversation for a fresh interactive run and emits canonical startup events', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      mocks.db.getMessages.mockResolvedValue([
        {
          id: 'msg-user-1',
          agentId: 'agent-1',
          conversationId: 'conv-new',
          role: 'user',
          content: 'hello there',
          createdAt: Date.now(),
        },
      ]);

      service.configureExecution(mocks);

      const start = await service.prepareRunStart({
        agent: createAgent(),
        agentId: 'agent-1',
        content: 'hello there',
        mode: 'interactive',
      });

      expect(mocks.db.createConversation).toHaveBeenCalledWith('agent-1');
      expect(mocks.db.addMessage).toHaveBeenCalledWith({
        agentId: 'agent-1',
        conversationId: 'conv-new',
        role: 'user',
        content: 'hello there',
      });
      expect(mocks.sessionManager.checkConcurrencyLimit).toHaveBeenCalledWith('agent-1');
      expect(mocks.eventBus.emit).toHaveBeenNthCalledWith(1, 'user.message', expect.objectContaining({
        agentId: 'agent-1',
        conversationId: 'conv-new',
        messageId: 'msg-1',
        content: 'hello there',
      }));
      expect(mocks.eventBus.emit).toHaveBeenNthCalledWith(2, 'turn.pending', expect.objectContaining({
        turnId: 'turn-1',
        agentId: 'agent-1',
        conversationId: 'conv-new',
        mode: 'interactive',
      }));
      expect(start).toMatchObject({
        conversationId: 'conv-new',
        turnId: 'turn-1',
        messageId: 'msg-1',
        mode: 'interactive',
        taskDescription: 'hello there',
      });
    });

    test('reserves a startup concurrency slot when supported and passes it to execution', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      const reservation = {
        agentId: 'agent-1',
        id: 'reservation-1',
        release: vi.fn(),
      };
      mocks.sessionManager.reserveConcurrencySlot = vi.fn().mockReturnValue(reservation);
      service.configureExecution(mocks);

      const start = await service.prepareRunStart({
        agent: createAgent(),
        agentId: 'agent-1',
        content: 'hello there',
        mode: 'interactive',
      });
      await service.launchPreparedRun(start, 'agent-1');

      expect(mocks.sessionManager.reserveConcurrencySlot).toHaveBeenCalledWith('agent-1');
      expect(mocks.sessionManager.checkConcurrencyLimit).not.toHaveBeenCalled();
      expect(mocks.agentSessionService.executeSession).toHaveBeenCalledWith(expect.objectContaining({
        concurrencyReservation: reservation,
      }));
    });

    test('reuses an existing conversation and suppresses user.message when requested', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      mocks.db.getMessages.mockResolvedValue([
        {
          id: 'msg-user-1',
          agentId: 'agent-1',
          conversationId: 'conv-existing',
          role: 'user',
          content: 'background task',
          createdAt: Date.now(),
        },
      ]);
      service.configureExecution(mocks);

      const start = await service.prepareRunStart({
        agent: createAgent(),
        agentId: 'agent-1',
        content: 'background task',
        mode: 'background',
        conversationId: 'conv-existing',
        requestedTurnId: 'turn-custom',
        emitUserMessageEvent: false,
      });

      expect(mocks.db.getConversation).toHaveBeenCalledWith('conv-existing');
      expect(mocks.db.createTurn).toHaveBeenCalledWith({
        id: 'turn-custom',
        agentId: 'agent-1',
        conversationId: 'conv-existing',
        mode: 'background',
        status: 'queued',
        userMessageId: 'msg-1',
        taskDescription: 'background task',
      });
      expect(mocks.eventBus.emit).toHaveBeenCalledTimes(1);
      expect(mocks.eventBus.emit).toHaveBeenCalledWith('turn.pending', expect.objectContaining({
        turnId: 'turn-custom',
        conversationId: 'conv-existing',
        mode: 'background',
        taskDescription: 'background task',
      }));
      expect(start.turnId).toBe('turn-custom');
    });

    test('creates a missing requested conversation id only when explicitly allowed', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      mocks.db.getConversation.mockResolvedValue(undefined);
      mocks.db.createConversation.mockResolvedValue({ id: 'client-thread-1', agentId: 'agent-1' });
      service.configureExecution(mocks);

      const start = await service.prepareRunStart({
        agent: createAgent(),
        agentId: 'agent-1',
        content: 'hello there',
        mode: 'interactive',
        conversationId: 'client-thread-1',
        createMissingConversationWithRequestedId: true,
      });

      expect(mocks.db.createConversation).toHaveBeenCalledWith('agent-1', 'client-thread-1');
      expect(start.conversationId).toBe('client-thread-1');
    });

    test('rejects missing requested conversation ids unless creation is enabled', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      mocks.db.getConversation.mockResolvedValue(undefined);
      service.configureExecution(mocks);

      await expect(service.prepareRunStart({
        agent: createAgent(),
        agentId: 'agent-1',
        content: 'hello there',
        mode: 'interactive',
        conversationId: 'client-thread-1',
      })).rejects.toThrow('Conversation client-thread-1 not found for agent agent-1');

      expect(mocks.db.createConversation).not.toHaveBeenCalled();
    });

    test('rejects missing required existing conversation ids', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      service.configureExecution(mocks);

      await expect(service.prepareRunStart({
        agent: createAgent(),
        agentId: 'agent-1',
        content: 'hello there',
        mode: 'interactive',
        requireExistingConversation: true,
      })).rejects.toThrow('Conversation id is required');
    });

    test('rejects conversations owned by another agent', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      mocks.db.getConversation.mockResolvedValue({ id: 'conv-existing', agentId: 'agent-2' });
      service.configureExecution(mocks);

      await expect(service.prepareRunStart({
        agent: createAgent(),
        agentId: 'agent-1',
        content: 'hello there',
        mode: 'interactive',
        conversationId: 'conv-existing',
      })).rejects.toThrow('Conversation conv-existing not found for agent agent-1');
    });

    test('rejects duplicate requested turn ids before mutating conversation state', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      mocks.db.getTurn.mockResolvedValue({ id: 'turn-custom' });
      service.configureExecution(mocks);

      await expect(service.prepareRunStart({
        agent: createAgent(),
        agentId: 'agent-1',
        content: 'hello there',
        mode: 'interactive',
        conversationId: 'conv-existing',
        requestedTurnId: 'turn-custom',
      })).rejects.toThrow('Turn already exists for id turn-custom');

      expect(mocks.db.addMessage).not.toHaveBeenCalled();
      expect(mocks.db.createTurn).not.toHaveBeenCalled();
    });

    test('rolls back the user message when turn creation fails after message persistence', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      mocks.sessionManager.checkConcurrencyLimit.mockImplementation(() => {
        throw new Error('limit reached');
      });
      service.configureExecution(mocks);

      await expect(service.prepareRunStart({
        agent: createAgent(),
        agentId: 'agent-1',
        content: 'hello there',
        mode: 'interactive',
      })).rejects.toThrow('limit reached');

      expect(mocks.db.deleteMessage).toHaveBeenCalledWith('msg-1');
      expect(mocks.db.createTurn).not.toHaveBeenCalled();
    });




    test('cleans up created startup state when durable event persistence fails', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      const durableBus = {
        emit: vi.fn(),
        emitAsync: vi.fn().mockRejectedValue(new Error('event persistence failed')),
      };
      service.configureExecution({
        ...mocks,
        eventBus: durableBus,
      });

      await expect(service.prepareRunStart({
        agent: createAgent(),
        agentId: 'agent-1',
        content: 'hello there',
        mode: 'interactive',
      })).rejects.toThrow('event persistence failed');

      expect(durableBus.emitAsync).toHaveBeenCalledWith('user.message', expect.objectContaining({
        agentId: 'agent-1',
        messageId: 'msg-1',
      }));
      expect(mocks.db.finalizeTurnIfOpen).toHaveBeenCalledWith('turn-1', expect.objectContaining({
        error: 'event persistence failed',
        completedAt: expect.any(Number),
      }));
      expect(mocks.db.deleteMessage).toHaveBeenCalledWith('msg-1');
      expect(mocks.db.getMessages).not.toHaveBeenCalled();
    });

    test('marks the turn failed and rolls back the user message when post-createTurn startup work fails', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      mocks.db.getMessages.mockRejectedValue(new Error('message load failed'));
      service.configureExecution(mocks);

      await expect(service.prepareRunStart({
        agent: createAgent(),
        agentId: 'agent-1',
        content: 'hello there',
        mode: 'interactive',
      })).rejects.toThrow('message load failed');

      expect(mocks.db.createTurn).toHaveBeenCalledTimes(1);
      expect(mocks.db.finalizeTurnIfOpen).toHaveBeenCalledWith('turn-1', expect.objectContaining({
        error: 'message load failed',
        completedAt: expect.any(Number),
      }));
      expect(mocks.db.deleteMessage).toHaveBeenCalledWith('msg-1');
    });

    test('marks the turn failed and rolls back the user message when durable startup event persistence fails', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      const persistEvent = vi.fn().mockImplementation(async (type: string) => {
        if (type === 'turn.pending') {
          throw new Error('event store unavailable');
        }
      });
      const eventBus = new TypedEventBus({ persistEvent });
      const listener = vi.fn();
      eventBus.on('turn.pending', listener);

      service.configureExecution({
        ...mocks,
        eventBus,
      });

      await expect(service.prepareRunStart({
        agent: createAgent(),
        agentId: 'agent-1',
        content: 'hello there',
        mode: 'interactive',
        emitUserMessageEvent: false,
      })).rejects.toThrow('event store unavailable');

      expect(mocks.db.createTurn).toHaveBeenCalledTimes(1);
      expect(listener).not.toHaveBeenCalled();
      expect(mocks.db.finalizeTurnIfOpen).toHaveBeenCalledWith('turn-1', expect.objectContaining({
        error: 'event store unavailable',
        completedAt: expect.any(Number),
      }));
      expect(mocks.db.deleteMessage).toHaveBeenCalledWith('msg-1');
    });
  });

  describe('launchPreparedRun', () => {
    test('passes the canonical conversation and turn ids through to executeSession', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      service.configureExecution(mocks);

      await service.launchPreparedRun({
        agentDef: buildAgentDefinition(createAgent()),
        conversationId: 'conv-1',
        turnId: 'turn-1',
        messageId: 'msg-1',
        messages: [],
        mode: 'background',
        taskDescription: 'hello',
      }, 'agent-1');

      expect(mocks.agentSessionService.executeSession).toHaveBeenCalledWith({
        agentDef: expect.objectContaining({ name: 'assistant' }),
        messages: [],
        agentId: 'agent-1',
        conversationId: 'conv-1',
        sessionId: 'turn-1',
        mode: 'background',
        taskDescription: 'hello',
      });
    });

    test('swallows executeSession errors after persisting the turn error by default', async () => {
      const service = createService();
      const executeSession = vi.fn().mockRejectedValue(new Error('boom'));
      const finalizeTurnIfOpen = vi.fn().mockResolvedValue(true);

      service.configureExecution({
        db: {
          addMessage: vi.fn(),
          createConversation: vi.fn(),
          createTurn: vi.fn(),
          deleteMessage: vi.fn(),
          getAgent: vi.fn(),
          getConversation: vi.fn(),
          getMessages: vi.fn(),
          getTurn: vi.fn(),
          updateTurn: vi.fn().mockResolvedValue(undefined),
          finalizeTurnIfOpen,
        } as unknown as Parameters<typeof service.configureExecution>[0]['db'],
        agentSessionService: { executeSession },
      });

      await expect(service.launchPreparedRun({
        agentDef: buildAgentDefinition(createAgent()),
        conversationId: 'conv-1',
        turnId: 'turn-1',
        messageId: 'msg-1',
        messages: [],
        mode: 'interactive',
        taskDescription: 'hello',
      }, 'agent-1')).resolves.toBeUndefined();

      expect(finalizeTurnIfOpen).toHaveBeenCalledWith('turn-1', expect.objectContaining({ error: 'boom' }));
    });

    test('never rejects: onSuccess fires only after a clean completion (ctx-smm)', async () => {
      const service = createService();
      const onSuccess = vi.fn();

      const configure = (executeSession: ReturnType<typeof vi.fn>) => {
        service.configureExecution({
          db: {
            addMessage: vi.fn(),
            createConversation: vi.fn(),
            createTurn: vi.fn(),
            deleteMessage: vi.fn(),
            getAgent: vi.fn(),
            getConversation: vi.fn(),
            getMessages: vi.fn(),
            getTurn: vi.fn(),
            updateTurn: vi.fn().mockResolvedValue(undefined),
            finalizeTurnIfOpen: vi.fn().mockResolvedValue(true),
          } as unknown as Parameters<typeof service.configureExecution>[0]['db'],
          agentSessionService: { executeSession },
        });
      };
      const start = {
        agentDef: buildAgentDefinition(createAgent()),
        conversationId: 'conv-1',
        turnId: 'turn-1',
        messageId: 'msg-1',
        messages: [],
        mode: 'interactive' as const,
        taskDescription: 'hello',
      };

      configure(vi.fn().mockResolvedValue(undefined));
      await expect(service.launchPreparedRun(start, 'agent-1', { onSuccess })).resolves.toBeUndefined();
      expect(onSuccess).toHaveBeenCalledTimes(1);

      onSuccess.mockClear();
      configure(vi.fn().mockRejectedValue(new Error('boom')));
      await expect(service.launchPreparedRun(start, 'agent-1', { onSuccess })).resolves.toBeUndefined();
      expect(onSuccess).not.toHaveBeenCalled();
    });

    test('a throwing onSuccess hook does not mark the turn failed', async () => {
      const service = createService();
      const updateTurn = vi.fn().mockResolvedValue(undefined);

      service.configureExecution({
        db: {
          addMessage: vi.fn(),
          createConversation: vi.fn(),
          createTurn: vi.fn(),
          deleteMessage: vi.fn(),
          getAgent: vi.fn(),
          getConversation: vi.fn(),
          getMessages: vi.fn(),
          getTurn: vi.fn(),
          updateTurn,
          finalizeTurnIfOpen: vi.fn().mockResolvedValue(true),
        } as unknown as Parameters<typeof service.configureExecution>[0]['db'],
        agentSessionService: { executeSession: vi.fn().mockResolvedValue(undefined) },
      });

      await expect(service.launchPreparedRun({
        agentDef: buildAgentDefinition(createAgent()),
        conversationId: 'conv-1',
        turnId: 'turn-1',
        messageId: 'msg-1',
        messages: [],
        mode: 'interactive',
        taskDescription: 'hello',
      }, 'agent-1', { onSuccess: () => { throw new Error('hook failure'); } })).resolves.toBeUndefined();

      expect(updateTurn).not.toHaveBeenCalled();
    });

    test('passes suppressTurnStartedEvent through to executeSession for redispatch-safe launches', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      service.configureExecution(mocks);

      await service.launchPreparedRun({
        agentDef: buildAgentDefinition(createAgent()),
        conversationId: 'conv-1',
        turnId: 'turn-1',
        messageId: 'msg-1',
        messages: [],
        mode: 'interactive',
        taskDescription: 'hello',
        suppressTurnStartedEvent: true,
      }, 'agent-1');

      expect(mocks.agentSessionService.executeSession).toHaveBeenCalledWith(expect.objectContaining({
        suppressTurnStartedEvent: true,
      }));
    });
  });

  describe('redispatchQueuedRun', () => {
    test('relaunches an existing queued turn without creating startup state', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      const reservation = {
        agentId: 'agent-1',
        id: 'reservation-queued',
        release: vi.fn(),
      };
      mocks.sessionManager.reserveConcurrencySlot = vi.fn().mockReturnValue(reservation);
      service.configureExecution(mocks);

      await service.redispatchQueuedRun({
        turnId: 'turn-queued',
        agentId: 'agent-1',
        conversationId: 'conv-existing',
        mode: 'interactive',
        taskDescription: 'queued prompt',
        userMessageId: 'msg-1',
        messages: [],
        emitTurnStarted: false,
      });

      expect(mocks.db.addMessage).not.toHaveBeenCalled();
      expect(mocks.db.createTurn).not.toHaveBeenCalled();
      expect(mocks.sessionManager.reserveConcurrencySlot).toHaveBeenCalledWith('agent-1');
      expect(mocks.agentSessionService.executeSession).toHaveBeenCalledWith(expect.objectContaining({
        agentDef: expect.objectContaining({ name: 'assistant' }),
        messages: [],
        agentId: 'agent-1',
        conversationId: 'conv-existing',
        sessionId: 'turn-queued',
        mode: 'interactive',
        taskDescription: 'queued prompt',
        concurrencyReservation: reservation,
        suppressTurnStartedEvent: true,
      }));
    });
  });
});
