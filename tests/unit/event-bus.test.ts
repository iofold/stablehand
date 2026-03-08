import { describe, it, expect, vi } from 'vitest';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';

describe('TypedEventBus', () => {
  it('should emit and receive events', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    bus.on('agent.created', handler);
    bus.emit('agent.created', { agentId: 'test-agent' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ agentId: 'test-agent' });
  });

  it('should support multiple handlers for same event', () => {
    const bus = new TypedEventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on('tool.call_started', handler1);
    bus.on('tool.call_started', handler2);
    bus.emit('tool.call_started', { agentId: 'a', toolName: 'get-data', callId: 'c1' });

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('should not call handler after off()', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    bus.on('agent.created', handler);
    bus.emit('agent.created', { agentId: 'a1' });
    expect(handler).toHaveBeenCalledTimes(1);

    bus.off('agent.created', handler);
    bus.emit('agent.created', { agentId: 'a2' });
    expect(handler).toHaveBeenCalledTimes(1); // still 1, not called again
  });

  it('should handle typed events with correct payloads', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    bus.on('tool.call_completed', handler);
    bus.emit('tool.call_completed', { agentId: 'a', callId: 'c1', durationMs: 42 });

    expect(handler).toHaveBeenCalledWith({ agentId: 'a', callId: 'c1', durationMs: 42 });
  });

  it('should support once() for single-fire handlers', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    bus.once('knowledge.updated', handler);
    bus.emit('knowledge.updated', { agentId: 'a', itemId: 'k1' });
    bus.emit('knowledge.updated', { agentId: 'a', itemId: 'k2' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ agentId: 'a', itemId: 'k1' });
  });

  it('should removeAllListeners for a specific event', () => {
    const bus = new TypedEventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on('agent.created', handler1);
    bus.on('agent.status_changed', handler2);

    bus.removeAllListeners('agent.created');
    bus.emit('agent.created', { agentId: 'a' });
    bus.emit('agent.status_changed', { agentId: 'a', from: 'idle', to: 'running' });

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('should removeAllListeners globally', () => {
    const bus = new TypedEventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on('agent.created', handler1);
    bus.on('tool.call_failed', handler2);

    bus.removeAllListeners();
    bus.emit('agent.created', { agentId: 'a' });
    bus.emit('tool.call_failed', { agentId: 'a', callId: 'c', error: 'oops' });

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).not.toHaveBeenCalled();
  });

  it('should handle events with no listeners without error', () => {
    const bus = new TypedEventBus();
    // Should not throw
    expect(() => {
      bus.emit('trace.captured', { traceId: 't1', agentId: 'a' });
    }).not.toThrow();
  });
});
