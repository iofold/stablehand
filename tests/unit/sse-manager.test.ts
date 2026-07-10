import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SSEManager } from '../../packages/ctxmill/src/orchestrator/sse.js';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import { EventEmitter } from 'node:events';

// ── Mock FastifyReply ────────────────────────────────────────────

interface MockRaw extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function createMockReply() {
  const raw: MockRaw = Object.assign(new EventEmitter(), {
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
  });
  return { raw } as unknown as import('fastify').FastifyReply;
}

function getRaw(reply: import('fastify').FastifyReply): MockRaw {
  return reply.raw as unknown as MockRaw;
}

// ── Tests ────────────────────────────────────────────────────────


let frameSeq = 0;
function broadcastEvent(mgr: SSEManager, agentId: string, event: Record<string, unknown>): number {
  frameSeq += 1;
  mgr.broadcastFrame(agentId, { legacy: event, canonical: event }, frameSeq);
  return frameSeq;
}

function seqId(seq: number): string {
  return String(seq).padStart(12, '0');
}

describe('SSEManager', () => {
  beforeEach(() => { frameSeq = 0; });
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
      manager.subscribe('agent-1', reply, 'canonical');

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
      manager.subscribe('agent-1', reply, 'canonical');
      manager.unsubscribe('agent-1', reply);

      vi.advanceTimersByTime(15_000);
      expect(getRaw(reply).write).not.toHaveBeenCalled();
    });

    it('should clean up heartbeat on connection close event', () => {
      const reply = createMockReply();
      manager.subscribe('agent-1', reply, 'canonical');

      // Simulate connection close
      getRaw(reply).emit('close');

      vi.advanceTimersByTime(15_000);
      expect(getRaw(reply).write).not.toHaveBeenCalled();
      expect(manager.getClientCount('agent-1')).toBe(0);
    });

    it('should keep a quiet connection open as long as heartbeats succeed', () => {
      const reply = createMockReply();
      manager.subscribe('agent-1', reply, 'canonical');

      vi.advanceTimersByTime(6 * 60 * 1000);

      expect(manager.getClientCount('agent-1')).toBe(1);
      expect(getRaw(reply).end).not.toHaveBeenCalled();
    });
  });

  // ORC-15: Multiple clients get same broadcast
  describe('ORC-15: broadcast to multiple clients', () => {
    it('should broadcast event to all subscribed clients', () => {
      const reply1 = createMockReply();
      const reply2 = createMockReply();
      const reply3 = createMockReply();

      manager.subscribe('agent-1', reply1, 'canonical');
      manager.subscribe('agent-1', reply2, 'canonical');
      manager.subscribe('agent-1', reply3, 'canonical');

      expect(manager.getClientCount('agent-1')).toBe(3);

      const event = { type: 'TEXT_MESSAGE_START', messageId: 'msg-1' };
      broadcastEvent(manager, 'agent-1', event);

      const expectedData = `id: ${seqId(1)}\ndata: ${JSON.stringify(event)}\n\n`;
      expect(getRaw(reply1).write).toHaveBeenCalledWith(expectedData);
      expect(getRaw(reply2).write).toHaveBeenCalledWith(expectedData);
      expect(getRaw(reply3).write).toHaveBeenCalledWith(expectedData);
    });

    it('should not broadcast to clients of a different agent', () => {
      const reply1 = createMockReply();
      const reply2 = createMockReply();

      manager.subscribe('agent-1', reply1, 'canonical');
      manager.subscribe('agent-2', reply2, 'canonical');

      broadcastEvent(manager, 'agent-1', { type: 'test' });

      expect(getRaw(reply1).write).toHaveBeenCalledTimes(1);
      expect(getRaw(reply2).write).not.toHaveBeenCalled();
    });

    it('should do nothing when broadcasting to agent with no clients', () => {
      // Should not throw
      expect(() => broadcastEvent(manager, 'no-agent', { type: 'test' })).not.toThrow();
    });
  });

  // ORC-16: Client disconnect cleanup
  describe('ORC-16: client disconnect cleanup', () => {
    it('should remove client on unsubscribe', () => {
      const reply = createMockReply();
      manager.subscribe('agent-1', reply, 'canonical');
      expect(manager.getClientCount('agent-1')).toBe(1);

      manager.unsubscribe('agent-1', reply);
      expect(manager.getClientCount('agent-1')).toBe(0);
    });

    it('should remove agent entry when last client disconnects', () => {
      const reply1 = createMockReply();
      const reply2 = createMockReply();

      manager.subscribe('agent-1', reply1, 'canonical');
      manager.subscribe('agent-1', reply2, 'canonical');
      expect(manager.getClientCount('agent-1')).toBe(2);

      manager.unsubscribe('agent-1', reply1);
      expect(manager.getClientCount('agent-1')).toBe(1);

      manager.unsubscribe('agent-1', reply2);
      expect(manager.getClientCount('agent-1')).toBe(0);
    });

    it('should auto-remove client when write throws during broadcast', () => {
      const reply1 = createMockReply();
      const reply2 = createMockReply();

      manager.subscribe('agent-1', reply1, 'canonical');
      manager.subscribe('agent-1', reply2, 'canonical');

      // Simulate a broken connection on reply1
      getRaw(reply1).write.mockImplementation(() => {
        throw new Error('Connection reset');
      });

      broadcastEvent(manager, 'agent-1', { type: 'test' });

      // reply1 should have been cleaned up
      expect(manager.getClientCount('agent-1')).toBe(1);

      // reply2 should still receive broadcasts
      broadcastEvent(manager, 'agent-1', { type: 'test2' });
      expect(getRaw(reply2).write).toHaveBeenCalledTimes(2);
    });

    it('should auto-remove client after 3 consecutive heartbeat failures', () => {
      const reply = createMockReply();
      manager.subscribe('agent-1', reply, 'canonical');

      // Make write throw to simulate broken connection
      getRaw(reply).write.mockImplementation(() => {
        throw new Error('Connection closed');
      });

      // First failure — client still connected
      vi.advanceTimersByTime(15_000);
      expect(manager.getClientCount('agent-1')).toBe(1);

      // Second failure — client still connected
      vi.advanceTimersByTime(15_000);
      expect(manager.getClientCount('agent-1')).toBe(1);

      // Third failure — client disconnected
      vi.advanceTimersByTime(15_000);
      expect(manager.getClientCount('agent-1')).toBe(0);
    });

    it('should clean up all connections on shutdown', () => {
      const reply1 = createMockReply();
      const reply2 = createMockReply();
      const reply3 = createMockReply();

      manager.subscribe('agent-1', reply1, 'canonical');
      manager.subscribe('agent-1', reply2, 'canonical');
      manager.subscribe('agent-2', reply3, 'canonical');

      manager.shutdown();

      expect(manager.getClientCount('agent-1')).toBe(0);
      expect(manager.getClientCount('agent-2')).toBe(0);
    });
  });

  // Task 17: SSE backpressure handling
  describe('Task 17: backpressure handling', () => {
    it('should queue events when write returns false (backpressure)', () => {
      const reply = createMockReply();
      manager.subscribe('agent-1', reply, 'canonical');

      // First write returns false (buffer full)
      getRaw(reply).write.mockReturnValueOnce(false);
      broadcastEvent(manager, 'agent-1', { type: 'event-1' });

      // Second event should be queued, not written directly
      broadcastEvent(manager, 'agent-1', { type: 'event-2' });
      // write was called once for event-1, event-2 was queued
      expect(getRaw(reply).write).toHaveBeenCalledTimes(1);
    });

    it('should flush queued events on drain', () => {
      const reply = createMockReply();
      manager.subscribe('agent-1', reply, 'canonical');

      // First write returns false (backpressure)
      getRaw(reply).write.mockReturnValueOnce(false);
      broadcastEvent(manager, 'agent-1', { type: 'event-1' });

      // Queue a second event
      broadcastEvent(manager, 'agent-1', { type: 'event-2' });
      expect(getRaw(reply).write).toHaveBeenCalledTimes(1);

      // Restore normal write behavior and emit drain
      getRaw(reply).write.mockReturnValue(true);
      getRaw(reply).emit('drain');

      expect(getRaw(reply).write).toHaveBeenCalledTimes(2);
      expect(getRaw(reply).write).toHaveBeenNthCalledWith(
        1,
        `id: ${seqId(1)}\ndata: ${JSON.stringify({ type: 'event-1' })}\n\n`,
      );
      expect(getRaw(reply).write).toHaveBeenNthCalledWith(
        2,
        `id: ${seqId(2)}\ndata: ${JSON.stringify({ type: 'event-2' })}\n\n`,
      );
    });

    it('should disconnect slow client when queue exceeds 100 items', () => {
      const reply = createMockReply();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      manager.subscribe('agent-1', reply, 'canonical');

      // First write returns false to trigger backpressure
      getRaw(reply).write.mockReturnValueOnce(false);
      broadcastEvent(manager, 'agent-1', { type: 'trigger-backpressure' });

      // Queue 100 events (filling the queue)
      for (let i = 0; i < 100; i++) {
        broadcastEvent(manager, 'agent-1', { type: `event-${i}` });
      }

      // The 101st event should trigger disconnection
      broadcastEvent(manager, 'agent-1', { type: 'overflow' });
      expect(manager.getClientCount('agent-1')).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith('[SSE] Disconnecting slow client');

      warnSpy.mockRestore();
    });

    it('should clean up client on raw stream error', () => {
      const reply = createMockReply();
      manager.subscribe('agent-1', reply, 'canonical');

      getRaw(reply).emit('error');

      expect(manager.getClientCount('agent-1')).toBe(0);
    });
  });

  // Task 19: Heartbeat error logging
  describe('Task 19: heartbeat error logging', () => {
    it('should log warning on heartbeat failure', () => {
      const reply = createMockReply();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      manager.subscribe('agent-1', reply, 'canonical');

      const error = new Error('write failed');
      getRaw(reply).write.mockImplementation(() => {
        throw error;
      });

      vi.advanceTimersByTime(15_000);

      expect(warnSpy).toHaveBeenCalledWith(
        '[SSE] Heartbeat failed for agent',
        'agent-1',
        error,
      );

      warnSpy.mockRestore();
    });

    it('should reset failure count on successful heartbeat', () => {
      const reply = createMockReply();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      manager.subscribe('agent-1', reply, 'canonical');

      // Fail twice
      getRaw(reply).write.mockImplementation(() => {
        throw new Error('fail');
      });
      vi.advanceTimersByTime(15_000);
      vi.advanceTimersByTime(15_000);
      expect(manager.getClientCount('agent-1')).toBe(1);

      // Succeed once (resets counter)
      getRaw(reply).write.mockReturnValue(true);
      vi.advanceTimersByTime(15_000);
      expect(manager.getClientCount('agent-1')).toBe(1);

      // Fail twice more — should still be connected (counter was reset)
      getRaw(reply).write.mockImplementation(() => {
        throw new Error('fail');
      });
      vi.advanceTimersByTime(15_000);
      vi.advanceTimersByTime(15_000);
      expect(manager.getClientCount('agent-1')).toBe(1);

      vi.restoreAllMocks();
    });

    it('should disconnect after exactly 3 consecutive heartbeat failures', () => {
      const reply = createMockReply();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      manager.subscribe('agent-1', reply, 'canonical');

      getRaw(reply).write.mockImplementation(() => {
        throw new Error('fail');
      });

      vi.advanceTimersByTime(15_000); // failure 1
      expect(manager.getClientCount('agent-1')).toBe(1);

      vi.advanceTimersByTime(15_000); // failure 2
      expect(manager.getClientCount('agent-1')).toBe(1);

      vi.advanceTimersByTime(15_000); // failure 3 — disconnect
      expect(manager.getClientCount('agent-1')).toBe(0);

      vi.restoreAllMocks();
    });
  });

  // Event bus emissions
  describe('event bus emissions', () => {
    it('subscribe emits client.connected event', () => {
      const bus = new TypedEventBus();
      const busManager = new SSEManager(bus);
      const events: any[] = [];
      bus.on('client.connected', (payload) => events.push(payload));

      const reply = createMockReply();
      busManager.subscribe('agent-1', reply, 'canonical');

      expect(events).toHaveLength(1);
      expect(events[0].agentId).toBe('agent-1');
      expect(events[0].clientId).toBeTypeOf('string');
      expect(events[0].clientId.length).toBeGreaterThan(0);
      expect(events[0].timestamp).toBeTypeOf('number');

      busManager.shutdown();
    });

    it('client disconnect emits client.disconnected event', () => {
      const bus = new TypedEventBus();
      const busManager = new SSEManager(bus);
      const events: any[] = [];
      bus.on('client.disconnected', (payload) => events.push(payload));

      const reply = createMockReply();
      busManager.subscribe('agent-1', reply, 'canonical');
      busManager.unsubscribe('agent-1', reply);

      expect(events).toHaveLength(1);
      expect(events[0].agentId).toBe('agent-1');
      expect(events[0].clientId).toBeTypeOf('string');
      expect(events[0].timestamp).toBeTypeOf('number');

      busManager.shutdown();
    });
  });
});
