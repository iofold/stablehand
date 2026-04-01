import { describe, it, expect } from 'vitest';
import { TypedEventBus } from '../bus.js';

describe('TypedEventBus', () => {
  describe('error visibility', () => {
    it('emits bus.error event when persist fails', () => {
      const errors: unknown[] = [];
      const bus = new TypedEventBus({
        persistEvent: () => {
          throw new Error('DB down');
        },
      });
      bus.on('bus.error', (payload: any) => errors.push(payload));
      bus.emit('agent.created', { agentId: 'a1', name: 'test', timestamp: Date.now() });
      expect(errors).toEqual([expect.objectContaining({ source: expect.any(String) })]);
      expect(errors[0]).toMatchObject({ source: 'persist', error: 'DB down' });
    });

    it('emits bus.error event when handler throws', () => {
      const errors: unknown[] = [];
      const bus = new TypedEventBus();
      bus.on('bus.error', (payload: any) => errors.push(payload));
      bus.on('agent.created', () => {
        throw new Error('handler broke');
      });
      bus.emit('agent.created', { agentId: 'a1', name: 'test', timestamp: Date.now() });
      expect(errors).toEqual([expect.objectContaining({ source: expect.any(String) })]);
      expect(errors[0]).toMatchObject({ source: 'handler', error: 'handler broke' });
    });

    it('does not throw when bus.error handler itself fails', () => {
      const bus = new TypedEventBus({
        persistEvent: () => {
          throw new Error('DB down');
        },
      });
      bus.on('bus.error', () => {
        throw new Error('error handler also broken');
      });
      // Should not throw
      expect(() =>
        bus.emit('agent.created', { agentId: 'a1', name: 'test', timestamp: Date.now() }),
      ).not.toThrow();
    });

    it('includes event name and timestamp in bus.error payload', () => {
      const errors: any[] = [];
      const bus = new TypedEventBus();
      bus.on('bus.error', (payload: any) => errors.push(payload));
      bus.on('turn.started', () => {
        throw new Error('oops');
      });
      const before = Date.now();
      bus.emit('turn.started', {
        turnId: 'r1',
        sessionId: 'r1',
        agentId: 'a1',
        conversationId: 'c1',
        mode: 'interactive',
        taskDescription: 'test',
        timestamp: Date.now(),
      });
      expect(errors).toEqual([expect.objectContaining({ source: expect.any(String) })]);
      expect(errors[0].event).toBe('turn.started');
      expect(errors[0].timestamp).toBeGreaterThanOrEqual(before);
    });
  });
});
