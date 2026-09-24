import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSessionTurnExecutor } from '../session-turn-service.js';
import type { SessionEvent, SessionTurnSessionManager } from '../session-turn-service.js';
import type { AgentSessionEvent } from '../../events/types.js';
import type { AgentDefinition, Message } from '@stablehand/sandbox-daemon';

function createTestAgentDef(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: 'test-agent',
    harness: 'langgraph',
    harnessConfig: { provider: 'openai', model: 'gpt-4o' },
    systemPrompt: 'You are a test agent.',
    tools: ['read_file'],
    ...overrides,
  };
}

function createTestMessages(): Message[] {
  return [{
    id: 'msg-1',
    agentId: 'test-agent',
    role: 'user',
    content: 'Hello, test!',
    createdAt: new Date(),
  }];
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function createMockSessionManager(events: SessionEvent[] = []): SessionTurnSessionManager & {
  ensureSession: ReturnType<typeof vi.fn>;
  killSession: ReturnType<typeof vi.fn>;
} {
  return {
    ensureSession: vi.fn(async () => ({ sessionId: 'session-1' })),
    deliverTurn: async function* () {
      for (const e of events) {
        yield e;
      }
    },
    killSession: vi.fn(async () => {}),
    suspendSession: vi.fn(async () => {}),
  };
}

async function collectEvents(gen: AsyncGenerator<AgentSessionEvent>): Promise<AgentSessionEvent[]> {
  const events: AgentSessionEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe('SandboxRunService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('happy path', () => {
    it('should call ensureSession with correct conversationId and agentDef', async () => {
      const sm = createMockSessionManager();
      const service = createSessionTurnExecutor({ sessionManager: sm, logger: silentLogger });
      const agentDef = createTestAgentDef();

      await collectEvents(service.executeSessionTurn(agentDef, 'conv-1', createTestMessages(), 'turn-1'));

      expect(sm.ensureSession).toHaveBeenCalledWith('conv-1', agentDef, agentDef.name);
    });

    it('forwards exact turn secrets without attaching them to the agent definition', async () => {
      const messages = createTestMessages();
      const deliverTurn = vi.fn(async function* () {
        yield* [];
      });
      const sm: SessionTurnSessionManager = {
        ensureSession: vi.fn(async () => ({ sessionId: 'unused-session' })),
        deliverTurn: deliverTurn as SessionTurnSessionManager['deliverTurn'],
      };
      const service = createSessionTurnExecutor({ sessionManager: sm, logger: silentLogger });
      const agentDef = createTestAgentDef();

      await collectEvents(service.executeSessionTurn(
        agentDef,
        'conv-1',
        messages,
        'turn-secret-a',
        {
          existingSessionId: 'session-warm',
          turnSecrets: {
            PILOT_TURN_OWNERSHIP_TOKEN: 'ownership-a',
            PILOT_API_BASE: 'http://pilot-api:3000',
          },
        },
      ));

      expect(sm.ensureSession).not.toHaveBeenCalled();
      expect(deliverTurn).toHaveBeenCalledWith(
        'session-warm',
        messages,
        'turn-secret-a',
        {
          turnSecrets: {
            PILOT_TURN_OWNERSHIP_TOKEN: 'ownership-a',
            PILOT_API_BASE: 'http://pilot-api:3000',
          },
        },
      );
    });

    it('should yield AgentSessionEvents from ag_ui_event session events', async () => {
      const aguiEvent: AgentSessionEvent = { type: 'RUN_STARTED', timestamp: 100, runId: 'turn-1' };
      const sm = createMockSessionManager([{ type: 'ag_ui_event', event: aguiEvent }]);
      const service = createSessionTurnExecutor({ sessionManager: sm, logger: silentLogger });

      const events = await collectEvents(
        service.executeSessionTurn(createTestAgentDef(), 'conv-1', createTestMessages(), 'turn-1'),
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toBe(aguiEvent);
    });

    it('should convert message_committed to MESSAGE_COMMITTED AgentSessionEvent', async () => {
      const sm = createMockSessionManager([{
        type: 'message_committed',
        role: 'assistant',
        content: 'Here is your answer.',
        turnId: 'turn-1',
        messageSeq: 0,
      }]);
      const service = createSessionTurnExecutor({ sessionManager: sm, logger: silentLogger });

      const events = await collectEvents(
        service.executeSessionTurn(createTestAgentDef(), 'conv-1', createTestMessages(), 'turn-1'),
      );

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('MESSAGE_COMMITTED');
      expect((events[0] as Record<string, unknown>).content).toBe('Here is your answer.');
      expect((events[0] as Record<string, unknown>).role).toBe('assistant');
      expect(events[0].runId).toBe('turn-1');
    });

    it('should set runId to the turnId in MESSAGE_COMMITTED events', async () => {
      const sm = createMockSessionManager([{
        type: 'message_committed',
        role: 'assistant',
        content: 'Done.',
        turnId: 'my-turn-id',
        messageSeq: 3,
      }]);
      const service = createSessionTurnExecutor({ sessionManager: sm, logger: silentLogger });

      const events = await collectEvents(
        service.executeSessionTurn(createTestAgentDef(), 'conv-1', createTestMessages(), 'my-turn-id'),
      );

      expect(events[0].runId).toBe('my-turn-id');
      expect((events[0] as Record<string, unknown>).messageSeq).toBe(3);
    });

    it('should preserve toolCalls and toolCallId in message_committed conversion', async () => {
      const sm = createMockSessionManager([{
        type: 'message_committed',
        role: 'tool',
        content: '',
        toolCallId: 'tc-99',
        turnId: 'turn-1',
        messageSeq: 1,
      }]);
      const service = createSessionTurnExecutor({ sessionManager: sm, logger: silentLogger });

      const events = await collectEvents(
        service.executeSessionTurn(createTestAgentDef(), 'conv-1', createTestMessages(), 'turn-1'),
      );

      expect(events[0].type).toBe('MESSAGE_COMMITTED');
      expect((events[0] as Record<string, unknown>).toolCallId).toBe('tc-99');
    });

    it('should yield events in order from mixed session events', async () => {
      const e1: AgentSessionEvent = { type: 'RUN_STARTED', timestamp: 1, runId: 'turn-1' };
      const e2: AgentSessionEvent = { type: 'RUN_FINISHED', timestamp: 2, runId: 'turn-1' };
      const sm = createMockSessionManager([
        { type: 'ag_ui_event', event: e1 },
        { type: 'message_committed', role: 'assistant', content: 'Done.', turnId: 'turn-1', messageSeq: 0 },
        { type: 'ag_ui_event', event: e2 },
      ]);
      const service = createSessionTurnExecutor({ sessionManager: sm, logger: silentLogger });

      const events = await collectEvents(
        service.executeSessionTurn(createTestAgentDef(), 'conv-1', createTestMessages(), 'turn-1'),
      );

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('RUN_STARTED');
      expect(events[1].type).toBe('MESSAGE_COMMITTED');
      expect(events[2].type).toBe('RUN_FINISHED');
    });

    it('should yield no events when deliverTurn yields nothing', async () => {
      const sm = createMockSessionManager([]);
      const service = createSessionTurnExecutor({ sessionManager: sm, logger: silentLogger });

      const events = await collectEvents(
        service.executeSessionTurn(createTestAgentDef(), 'conv-1', createTestMessages(), 'turn-1'),
      );

      expect(events).toHaveLength(0);
      expect(sm.ensureSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('abort signal', () => {
    it('should not call deliverTurn when signal is already aborted', async () => {
      const sm = createMockSessionManager();
      const deliverSpy = vi.spyOn(sm, 'deliverTurn' as never);
      const service = createSessionTurnExecutor({ sessionManager: sm, logger: silentLogger });
      const controller = new AbortController();
      controller.abort();

      const events = await collectEvents(
        service.executeSessionTurn(
          createTestAgentDef(),
          'conv-1',
          createTestMessages(),
          'turn-1',
          { signal: controller.signal },
        ),
      );

      expect(events).toHaveLength(0);
      expect(deliverSpy).not.toHaveBeenCalled();
    });

    it('should abort an idle deliverTurn stream through the executor adapter', async () => {
      const controller = new AbortController();
      let deliveredSignal: AbortSignal | undefined;
      let markStreamEntered!: () => void;
      let releaseIdleStream: (() => void) | undefined;
      const streamEntered = new Promise<void>((resolve) => {
        markStreamEntered = resolve;
      });
      const sm: SessionTurnSessionManager = {
        ensureSession: vi.fn(async () => ({ sessionId: 'session-idle' })),
        deliverTurn: async function* (_sessionId, _messages, _turnId, options) {
          deliveredSignal = options?.signal;
          markStreamEntered();
          await new Promise<void>((resolve) => {
            if (!options?.signal) {
              releaseIdleStream = resolve;
              return;
            }
            if (options.signal.aborted) {
              resolve();
              return;
            }
            options.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          yield* [];
        },
      };
      const service = createSessionTurnExecutor({ sessionManager: sm, logger: silentLogger });
      const execution = collectEvents(
        service.executeSessionTurn(
          createTestAgentDef(),
          'conv-1',
          createTestMessages(),
          'turn-idle',
          { signal: controller.signal },
        ),
      );

      await streamEntered;
      controller.abort();

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        execution.then(() => 'completed' as const),
        new Promise<'timed-out'>((resolve) => {
          timeout = setTimeout(() => resolve('timed-out'), 250);
        }),
      ]);
      if (timeout) {
        clearTimeout(timeout);
      }

      try {
        expect(outcome).toBe('completed');
        expect(deliveredSignal).toBe(controller.signal);
      } finally {
        releaseIdleStream?.();
        await execution;
      }
    });

    it('should preserve session when signal fires during streaming', async () => {
      const controller = new AbortController();
      const sm: SessionTurnSessionManager & { killSession: ReturnType<typeof vi.fn> } = {
        ensureSession: vi.fn(async () => ({ sessionId: 'session-abc' })),
        deliverTurn: async function* () {
          controller.abort();
          yield {
            type: 'ag_ui_event' as const,
            event: { type: 'RUN_STARTED', timestamp: 1, runId: 'turn-1' } as AgentSessionEvent,
      };
        },
        killSession: vi.fn(async () => {}),
        suspendSession: vi.fn(async () => {}),
      };
      const service = createSessionTurnExecutor({ sessionManager: sm, logger: silentLogger });

      await collectEvents(
        service.executeSessionTurn(
          createTestAgentDef(),
          'conv-1',
          createTestMessages(),
          'turn-1',
          { signal: controller.signal },
        ),
      );

      expect(sm.killSession).not.toHaveBeenCalled();
    });

    it('should not kill session when signal is not aborted', async () => {
      const sm = createMockSessionManager([
        { type: 'ag_ui_event', event: { type: 'RUN_FINISHED', timestamp: 1, runId: 'turn-1' } as AgentSessionEvent },
      ]);
      const service = createSessionTurnExecutor({ sessionManager: sm, logger: silentLogger });

      await collectEvents(
        service.executeSessionTurn(createTestAgentDef(), 'conv-1', createTestMessages(), 'turn-1'),
      );

      expect(sm.killSession).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should propagate errors from ensureSession', async () => {
      const sm: SessionTurnSessionManager = {
        ensureSession: vi.fn(async () => { throw new Error('Session init failed'); }),
        deliverTurn: (async function* () {}) as SessionTurnSessionManager['deliverTurn'],
        killSession: vi.fn(async () => {}),
        suspendSession: vi.fn(async () => {}),
      };
      const service = createSessionTurnExecutor({ sessionManager: sm, logger: silentLogger });

      await expect(
        collectEvents(service.executeSessionTurn(createTestAgentDef(), 'conv-1', createTestMessages(), 'turn-1')),
      ).rejects.toThrow('Session init failed');
    });

    it('should propagate errors from deliverTurn', async () => {
      const sm: SessionTurnSessionManager = {
        ensureSession: vi.fn(async () => ({ sessionId: 'session-1' })),
        deliverTurn: async function* () {
          if (Date.now() < 0) {
            yield { type: 'ag_ui_event', event: { type: 'RUN_STARTED', timestamp: 0, runId: 'turn-1' } as AgentSessionEvent };
          }
          throw new Error('Stream disconnected');
        },
        killSession: vi.fn(async () => {}),
        suspendSession: vi.fn(async () => {}),
      };
      const service = createSessionTurnExecutor({ sessionManager: sm, logger: silentLogger });

      await expect(
        collectEvents(service.executeSessionTurn(createTestAgentDef(), 'conv-1', createTestMessages(), 'turn-1')),
      ).rejects.toThrow('Stream disconnected');
    });
  });
});
