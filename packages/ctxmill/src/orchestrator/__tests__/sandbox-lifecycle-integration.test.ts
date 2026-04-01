import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionTurnService, type SandboxSessionManager, type SessionEvent } from '../session-turn-service.js';
import { TypedEventBus } from '../../events/bus.js';
import type { AgentDefinition, Message } from '../../types.js';

function createTestBus(options?: ConstructorParameters<typeof TypedEventBus>[0]): TypedEventBus {
  return new TypedEventBus(options);
}

function msg(content: string, role = 'user'): Message {
  return { id: `m-${Date.now()}`, role, content, agentId: 'a-1', createdAt: Date.now() } as unknown as Message;
}

function aguiWrap(event: Record<string, unknown>): SessionEvent {
  return { type: 'ag_ui_event', event } as SessionEvent;
}

function createMockSessionManager(): SandboxSessionManager {
  return {
    ensureSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1' }),
    deliverTurn: vi.fn().mockImplementation(async function* () {
      yield aguiWrap({ type: 'TEXT_MESSAGE_START', timestamp: Date.now(), runId: 'r-1' });
      yield aguiWrap({ type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), runId: 'r-1', content: 'response' });
      yield aguiWrap({ type: 'TEXT_MESSAGE_END', timestamp: Date.now(), runId: 'r-1' });
      yield { type: 'message_committed', role: 'assistant', content: 'response', turnId: 'turn-1', messageSeq: 1 } as SessionEvent;
    }),
    killSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as SandboxSessionManager;
}

const silentLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

describe('Sandbox Session Lifecycle Integration', () => {
  let sessionManager: SandboxSessionManager;
  let eventBus: TypedEventBus;
  let service: SessionTurnService;

  const agentDef = {
    name: 'test-agent',
    model: 'gpt-5.4-mini',
    tools: [],
    systemPrompt: 'You are a test agent.',
    harness: 'langgraph',
  } as unknown as AgentDefinition;

  beforeEach(() => {
    sessionManager = createMockSessionManager();
    eventBus = createTestBus();
    service = new SessionTurnService({ sessionManager, eventBus, logger: silentLogger });
  });

  afterEach(() => {
    eventBus.removeAllListeners();
  });

  describe('session-per-conversation', () => {
    it('creates a session on first message', async () => {
      const messages: Message[] = [msg('hello')];
      const events: unknown[] = [];

      for await (const evt of service.executeSessionTurn(agentDef, 'conv-1', messages, 'turn-1')) {
        events.push(evt);
      }

      expect(sessionManager.ensureSession).toHaveBeenCalledWith('conv-1', agentDef, agentDef.name);
      expect(events.length).toBeGreaterThan(0);
    });

    it('reuses session for second message in same conversation', async () => {
      const messages: Message[] = [msg('first')];

      for await (const evt of service.executeSessionTurn(agentDef, 'conv-1', messages, 'turn-1')) { void evt; }
      for await (const evt of service.executeSessionTurn(agentDef, 'conv-1', [msg('second')], 'turn-2')) { void evt; }

      expect(sessionManager.ensureSession).toHaveBeenCalledTimes(2);
      const calls = (sessionManager.ensureSession as any).mock.calls;
      expect(calls[0][0]).toBe('conv-1');
      expect(calls[0][2]).toBe(agentDef.name);
      expect(calls[1][0]).toBe('conv-1');
      expect(calls[1][2]).toBe(agentDef.name);
    });

    it('creates separate sessions for different conversations', async () => {
      for await (const evt of service.executeSessionTurn(agentDef, 'conv-1', [msg('a')], 'turn-1')) { void evt; }
      for await (const evt of service.executeSessionTurn(agentDef, 'conv-2', [msg('b')], 'turn-2')) { void evt; }

      const calls = (sessionManager.ensureSession as any).mock.calls;
      expect(calls[0][0]).toBe('conv-1');
      expect(calls[0][2]).toBe(agentDef.name);
      expect(calls[1][0]).toBe('conv-2');
      expect(calls[1][2]).toBe(agentDef.name);
    });
  });

  describe('event streaming', () => {
    it('streams all event types including MESSAGE_COMMITTED', async () => {
      const events: any[] = [];

      for await (const evt of service.executeSessionTurn(agentDef, 'conv-1', [msg('hi')], 'turn-1')) {
        events.push(evt);
      }

      const types = events.map((e) => e.type);
      expect(types).toContain('TEXT_MESSAGE_START');
      expect(types).toContain('TEXT_MESSAGE_CONTENT');
      expect(types).toContain('TEXT_MESSAGE_END');
      expect(types).toContain('MESSAGE_COMMITTED');
    });

    it('MESSAGE_COMMITTED event carries canonical message data', async () => {
      const events: any[] = [];

      for await (const evt of service.executeSessionTurn(agentDef, 'conv-1', [msg('hi')], 'turn-1')) {
        events.push(evt);
      }

      const committed = events.find((e) => e.type === 'MESSAGE_COMMITTED');
      expect(committed).toBeDefined();
      expect(committed.role).toBe('assistant');
      expect(committed.content).toBe('response');
      expect(committed.turnId).toBe('turn-1');
      expect(committed.messageSeq).toBe(1);
    });
  });

  describe('session kill via manager', () => {
    it('delegates kill to session manager directly', async () => {
      await sessionManager.killSession('sess-1');
      expect(sessionManager.killSession).toHaveBeenCalledWith('sess-1');
    });
  });

  describe('session kill', () => {
    it('delegates kill to session manager', async () => {
      await sessionManager.killSession('sess-1');
      expect(sessionManager.killSession).toHaveBeenCalledWith('sess-1');
    });
  });

  describe('error handling', () => {
    it('propagates session creation errors', async () => {
      (sessionManager.ensureSession as any).mockRejectedValueOnce(new Error('container start failed'));

      const events: unknown[] = [];
      try {
        for await (const evt of service.executeSessionTurn(agentDef, 'conv-1', [msg('hi')], 'turn-1')) {
          events.push(evt);
        }
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('container start failed');
      }
    });

    it('propagates turn delivery errors', async () => {
      (sessionManager.deliverTurn as any).mockImplementation(async function* () {
        yield { type: 'RUN_ERROR', timestamp: Date.now(), runId: 'r-1', error: 'harness crashed' };
        throw new Error('harness crashed');
      });

      try {
        for await (const evt of service.executeSessionTurn(agentDef, 'conv-1', [msg('hi')], 'turn-1')) { void evt; }
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('harness crashed');
      }
    });
  });
});
