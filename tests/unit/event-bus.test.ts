import { describe, it, expect, vi } from 'vitest';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';

describe('TypedEventBus', () => {
  it('should emit and receive events', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    bus.on('agent.created', handler);
    bus.emit('agent.created', { agentId: 'test-agent', name: 'Test', timestamp: 0 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'test-agent', name: 'Test' }),
    );
  });

  it('should support multiple handlers for same event', () => {
    const bus = new TypedEventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on('run.tool_started', handler1);
    bus.on('run.tool_started', handler2);
    bus.emit('run.tool_started', {
      runId: 'r1',
      agentId: 'a',
      toolCallId: 'c1',
      toolName: 'get-data',
      args: {},
      timestamp: 0,
    });

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('should not call handler after off()', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    bus.on('agent.created', handler);
    bus.emit('agent.created', { agentId: 'a1', name: 'A1', timestamp: 0 });
    expect(handler).toHaveBeenCalledTimes(1);

    bus.off('agent.created', handler);
    bus.emit('agent.created', { agentId: 'a2', name: 'A2', timestamp: 0 });
    expect(handler).toHaveBeenCalledTimes(1); // still 1, not called again
  });

  it('should handle typed events with correct payloads', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    bus.on('run.tool_result', handler);
    bus.emit('run.tool_result', {
      runId: 'r1',
      agentId: 'a',
      toolCallId: 'c1',
      toolName: 'test-tool',
      result: 'ok',
      durationMs: 42,
      timestamp: 0,
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'a', toolCallId: 'c1', durationMs: 42 }),
    );
  });

  it('should support once() for single-fire handlers', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    bus.once('learning.knowledge_updated', handler);
    bus.emit('learning.knowledge_updated', { agentId: 'a', itemId: 'k1', category: 'strategy', timestamp: 0 });
    bus.emit('learning.knowledge_updated', { agentId: 'a', itemId: 'k2', category: 'strategy', timestamp: 0 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'a', itemId: 'k1' }),
    );
  });

  it('should removeAllListeners for a specific event', () => {
    const bus = new TypedEventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on('agent.created', handler1);
    bus.on('agent.deleted', handler2);

    bus.removeAllListeners('agent.created');
    bus.emit('agent.created', { agentId: 'a', name: 'A', timestamp: 0 });
    bus.emit('agent.deleted', { agentId: 'a', timestamp: 0 });

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('should removeAllListeners globally', () => {
    const bus = new TypedEventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on('agent.created', handler1);
    bus.on('turn.completed', handler2);

    bus.removeAllListeners();
    bus.emit('agent.created', { agentId: 'a', name: 'A', timestamp: 0 });
    bus.emit('turn.completed', {
      runId: 'r1',
      agentId: 'a',
      conversationId: 'c1',
      status: 'error',
      error: 'oops',
      durationMs: 0,
      timestamp: 0,
    });

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).not.toHaveBeenCalled();
  });

  it('should handle events with no listeners without error', () => {
    const bus = new TypedEventBus();
    // Should not throw
    expect(() => {
      bus.emit('learning.trace_captured', {
        traceId: 't1',
        runId: 'r1',
        agentId: 'a',
        stepCount: 3,
        outcome: 'success',
        timestamp: 0,
      });
    }).not.toThrow();
  });
});
