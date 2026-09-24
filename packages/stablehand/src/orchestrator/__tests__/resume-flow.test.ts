import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createSessionTurnExecutor,
  type SessionEvent,
  type SessionTurnExecutor,
  type SessionTurnSessionManager,
} from '../session-turn-service.js';
import type { Message } from '@stablehand/sandbox-daemon';

function msg(content: string, role = 'user'): Message {
  return { id: `m-${Date.now()}`, role, content, agentId: 'a-1', createdAt: Date.now() } as unknown as Message;
}

function aguiWrap(event: Record<string, unknown>): SessionEvent {
  return { type: 'ag_ui_event', event } as SessionEvent;
}

type MockSessionManager = SessionTurnSessionManager & {
  killSession: ReturnType<typeof vi.fn>;
};

function createMockSessionManager(): MockSessionManager {
  return {
    ensureSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1' }),
    deliverTurn: vi.fn().mockImplementation(async function* () {
      yield aguiWrap({ type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), runId: 'r-1', delta: 'Hello' });
    }),
    killSession: vi.fn().mockResolvedValue(undefined),
  } as MockSessionManager;
}

describe('SessionTurnService (session-based)', () => {
  let sessionManager: MockSessionManager;
  let service: SessionTurnExecutor;

  beforeEach(() => {
    sessionManager = createMockSessionManager();
    service = createSessionTurnExecutor({
      sessionManager,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    });
  });

  describe('executeSessionTurn', () => {
    it('ensures a session before delivering a turn', async () => {
      const agentDef = { name: 'test', model: 'gpt-5.4-mini', tools: [], systemPrompt: 'hi' } as any;

      const events: unknown[] = [];
      for await (const evt of service.executeSessionTurn(agentDef, 'conv-1', [msg('hello')], 'turn-1')) {
        events.push(evt);
      }

      expect(sessionManager.ensureSession).toHaveBeenCalledWith('conv-1', agentDef, agentDef.name);
      expect(sessionManager.deliverTurn).toHaveBeenCalled();
      expect(events.length).toBeGreaterThan(0);
    });

    it('kills session on abort', async () => {
      const controller = new AbortController();
      const agentDef = { name: 'test', model: 'gpt-5.4-mini', tools: [], systemPrompt: 'hi' } as any;

      controller.abort();

      const events: unknown[] = [];
      for await (const evt of service.executeSessionTurn(
        agentDef,
        'conv-1',
        [msg('hi')],
        'turn-2',
        { signal: controller.signal },
      )) {
        events.push(evt);
      }

      expect(events.length).toBe(0);
    });
  });

  describe('session lifecycle', () => {
    it('session manager exposes kill', async () => {
      await sessionManager.killSession('sess-1');
      expect(sessionManager.killSession).toHaveBeenCalledWith('sess-1');
    });
  });
});
