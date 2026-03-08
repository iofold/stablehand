import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SSEManager } from '../../packages/ctxmill/src/orchestrator/sse.js';
import { EventEmitter } from 'node:events';

// ── Mock FastifyReply ────────────────────────────────────────────

interface MockRaw extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function createMockReply() {
  const raw: MockRaw = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
  });
  return { raw } as unknown as import('fastify').FastifyReply;
}

function getRaw(reply: import('fastify').FastifyReply): MockRaw {
  return reply.raw as unknown as MockRaw;
}

// ── Tests ────────────────────────────────────────────────────────

describe('SSEManager', () => {
  let manager: SSEManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new SSEManager();
  });

  afterEach(() => {
    manager.shutdown();
    vi.useRealTimers();
  });

  // ORC-14: Heartbeat exists
  describe('ORC-14: heartbeat', () => {
    it('should send heartbeat comments at 15s intervals', () => {
      const reply = createMockReply();
      manager.subscribe('agent-1', reply);

      // No heartbeat yet
      expect(getRaw(reply).write).not.toHaveBeenCalled();

      // Advance 15 seconds
      vi.advanceTimersByTime(15_000);
      expect(getRaw(reply).write).toHaveBeenCalledWith(': heartbeat\n\n');

      // Advance another 15 seconds
      vi.advanceTimersByTime(15_000);
      expect(getRaw(reply).write).toHaveBeenCalledTimes(2);
    });

    it('should not send heartbeat after unsubscribe', () => {
      const reply = createMockReply();
      manager.subscribe('agent-1', reply);
      manager.unsubscribe('agent-1', reply);

      vi.advanceTimersByTime(15_000);
      expect(getRaw(reply).write).not.toHaveBeenCalled();
    });

    it('should clean up heartbeat on connection close event', () => {
      const reply = createMockReply();
      manager.subscribe('agent-1', reply);

      // Simulate connection close
      getRaw(reply).emit('close');

      vi.advanceTimersByTime(15_000);
      expect(getRaw(reply).write).not.toHaveBeenCalled();
      expect(manager.getClientCount('agent-1')).toBe(0);
    });
  });

  // ORC-15: Multiple clients get same broadcast
  describe('ORC-15: broadcast to multiple clients', () => {
    it('should broadcast event to all subscribed clients', () => {
      const reply1 = createMockReply();
      const reply2 = createMockReply();
      const reply3 = createMockReply();

      manager.subscribe('agent-1', reply1);
      manager.subscribe('agent-1', reply2);
      manager.subscribe('agent-1', reply3);

      expect(manager.getClientCount('agent-1')).toBe(3);

      const event = { type: 'TEXT_MESSAGE_START', messageId: 'msg-1' };
      manager.broadcast('agent-1', event);

      const expectedData = `data: ${JSON.stringify(event)}\n\n`;
      expect(getRaw(reply1).write).toHaveBeenCalledWith(expectedData);
      expect(getRaw(reply2).write).toHaveBeenCalledWith(expectedData);
      expect(getRaw(reply3).write).toHaveBeenCalledWith(expectedData);
    });

    it('should not broadcast to clients of a different agent', () => {
      const reply1 = createMockReply();
      const reply2 = createMockReply();

      manager.subscribe('agent-1', reply1);
      manager.subscribe('agent-2', reply2);

      manager.broadcast('agent-1', { type: 'test' });

      expect(getRaw(reply1).write).toHaveBeenCalledTimes(1);
      expect(getRaw(reply2).write).not.toHaveBeenCalled();
    });

    it('should do nothing when broadcasting to agent with no clients', () => {
      // Should not throw
      expect(() => manager.broadcast('no-agent', { type: 'test' })).not.toThrow();
    });
  });

  // ORC-16: Client disconnect cleanup
  describe('ORC-16: client disconnect cleanup', () => {
    it('should remove client on unsubscribe', () => {
      const reply = createMockReply();
      manager.subscribe('agent-1', reply);
      expect(manager.getClientCount('agent-1')).toBe(1);

      manager.unsubscribe('agent-1', reply);
      expect(manager.getClientCount('agent-1')).toBe(0);
    });

    it('should remove agent entry when last client disconnects', () => {
      const reply1 = createMockReply();
      const reply2 = createMockReply();

      manager.subscribe('agent-1', reply1);
      manager.subscribe('agent-1', reply2);
      expect(manager.getClientCount('agent-1')).toBe(2);

      manager.unsubscribe('agent-1', reply1);
      expect(manager.getClientCount('agent-1')).toBe(1);

      manager.unsubscribe('agent-1', reply2);
      expect(manager.getClientCount('agent-1')).toBe(0);
    });

    it('should auto-remove client when write throws during broadcast', () => {
      const reply1 = createMockReply();
      const reply2 = createMockReply();

      manager.subscribe('agent-1', reply1);
      manager.subscribe('agent-1', reply2);

      // Simulate a broken connection on reply1
      getRaw(reply1).write.mockImplementation(() => {
        throw new Error('Connection reset');
      });

      manager.broadcast('agent-1', { type: 'test' });

      // reply1 should have been cleaned up
      expect(manager.getClientCount('agent-1')).toBe(1);

      // reply2 should still receive broadcasts
      manager.broadcast('agent-1', { type: 'test2' });
      expect(getRaw(reply2).write).toHaveBeenCalledTimes(2);
    });

    it('should auto-remove client when heartbeat write throws', () => {
      const reply = createMockReply();
      manager.subscribe('agent-1', reply);

      // Make write throw to simulate broken connection
      getRaw(reply).write.mockImplementation(() => {
        throw new Error('Connection closed');
      });

      vi.advanceTimersByTime(15_000);

      expect(manager.getClientCount('agent-1')).toBe(0);
    });

    it('should clean up all connections on shutdown', () => {
      const reply1 = createMockReply();
      const reply2 = createMockReply();
      const reply3 = createMockReply();

      manager.subscribe('agent-1', reply1);
      manager.subscribe('agent-1', reply2);
      manager.subscribe('agent-2', reply3);

      manager.shutdown();

      expect(manager.getClientCount('agent-1')).toBe(0);
      expect(manager.getClientCount('agent-2')).toBe(0);
    });
  });
});
