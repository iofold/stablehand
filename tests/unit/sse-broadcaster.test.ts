import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSEBroadcaster } from '../../packages/ctxmill/src/orchestrator/sse-broadcaster.js';
import {
  createTestBus,
  createMockSSEManager,
  makeRunStartedEvent,
  makeRunCompletedEvent,
  makeTextChunkEvent,
  makeToolStartedEvent,
  makeToolResultEvent,
} from '../utils/event-bus-test-helpers.js';
import type { TypedEventBus, EventMap } from '../../packages/ctxmill/src/events/bus.js';

describe('SSEBroadcaster', () => {
  let bus: TypedEventBus;
  let sseManager: ReturnType<typeof createMockSSEManager>;
  let broadcaster: SSEBroadcaster;

  beforeEach(() => {
    bus = createTestBus();
    sseManager = createMockSSEManager();
    broadcaster = new SSEBroadcaster(sseManager as any, bus);
  });

  afterEach(() => {
    broadcaster.shutdown();
  });

  describe('event mapping', () => {
    it('turn.started broadcasts with type RUN_STARTED', () => {
      const event = makeRunStartedEvent();
      bus.emit('turn.started', event);

      expect(sseManager.broadcast).toHaveBeenCalledWith(
        event.agentId,
        expect.objectContaining({ type: 'RUN_STARTED' }),
      );
    });

    it('run.text_chunk broadcasts with type TEXT_MESSAGE_CONTENT', () => {
      const event = makeTextChunkEvent();
      bus.emit('run.text_chunk', event);

      expect(sseManager.broadcast).toHaveBeenCalledWith(
        event.agentId,
        expect.objectContaining({ type: 'TEXT_MESSAGE_CONTENT' }),
      );
    });

    it('run.tool_started broadcasts with type TOOL_CALL_START', () => {
      const event = makeToolStartedEvent();
      bus.emit('run.tool_started', event);

      expect(sseManager.broadcast).toHaveBeenCalledWith(
        event.agentId,
        expect.objectContaining({ type: 'TOOL_CALL_START' }),
      );
    });

    it('run.tool_result broadcasts with type TOOL_CALL_RESULT', () => {
      const event = makeToolResultEvent();
      bus.emit('run.tool_result', event);

      expect(sseManager.broadcast).toHaveBeenCalledWith(
        event.agentId,
        expect.objectContaining({ type: 'TOOL_CALL_RESULT' }),
      );
    });

    it('turn.completed broadcasts with type RUN_FINISHED', () => {
      const event = makeRunCompletedEvent();
      bus.emit('turn.completed', event);

      expect(sseManager.broadcast).toHaveBeenCalledWith(
        event.agentId,
        expect.objectContaining({ type: 'RUN_FINISHED' }),
      );
    });

    it('run.interrupted broadcasts with type CUSTOM', () => {
      const event: EventMap['run.interrupted'] = {
        turnId: 'run-1',
        agentId: 'agent-1',
        toolCallId: 'tc-1',
        toolName: 'dangerous_tool',
        args: {},
        interruptId: 'int-1',
        timestamp: Date.now(),
      };
      bus.emit('run.interrupted', event);

      expect(sseManager.broadcast).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ type: 'CUSTOM' }),
      );
    });

    it('run.interrupt_resolved broadcasts with type CUSTOM', () => {
      const event: EventMap['run.interrupt_resolved'] = {
        turnId: 'run-1',
        agentId: 'agent-1',
        interruptId: 'int-1',
        action: 'approve',
        timestamp: Date.now(),
      };
      bus.emit('run.interrupt_resolved', event);

      expect(sseManager.broadcast).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ type: 'CUSTOM' }),
      );
    });
  });

  describe('agentId routing', () => {
    it('broadcast called with correct agentId from payload', () => {
      const event = makeRunStartedEvent({ agentId: 'my-agent-42' });
      bus.emit('turn.started', event);

      expect(sseManager.broadcast).toHaveBeenCalledWith(
        'my-agent-42',
        expect.objectContaining({ agentId: 'my-agent-42' }),
      );
    });

    it('different agents get separate broadcast calls', () => {
      const event1 = makeRunStartedEvent({ agentId: 'agent-a' });
      const event2 = makeRunStartedEvent({ agentId: 'agent-b' });

      bus.emit('turn.started', event1);
      bus.emit('turn.started', event2);

      expect(sseManager.broadcast).toHaveBeenCalledTimes(2);
      expect(sseManager.broadcast).toHaveBeenCalledWith('agent-a', expect.anything());
      expect(sseManager.broadcast).toHaveBeenCalledWith('agent-b', expect.anything());
    });
  });

  describe('payload passthrough', () => {
    it('original payload fields preserved and internalType added', () => {
      const event = makeTextChunkEvent({
        turnId: 'run-xyz',
        agentId: 'agent-xyz',
        messageId: 'msg-xyz',
        content: 'hello there',
      });
      bus.emit('run.text_chunk', event);

      expect(sseManager.broadcast).toHaveBeenCalledWith(
        'agent-xyz',
        expect.objectContaining({
          turnId: 'run-xyz',
          runId: 'run-xyz',
          agentId: 'agent-xyz',
          messageId: 'msg-xyz',
          content: 'hello there',
          type: 'TEXT_MESSAGE_CONTENT',
          internalType: 'run.text_chunk',
        }),
      );
    });
  });

  describe('error handling', () => {
    it('SSEManager.broadcast throws - logged, bus continues', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      sseManager.broadcast.mockImplementation(() => {
        throw new Error('SSE broadcast failure');
      });

      // First event throws
      bus.emit('turn.started', makeRunStartedEvent({ agentId: 'agent-1' }));

      // Second event on a different event type should still attempt broadcast
      bus.emit('turn.completed', makeRunCompletedEvent({ agentId: 'agent-1' }));

      // Both calls were attempted
      expect(sseManager.broadcast).toHaveBeenCalledTimes(2);
      consoleSpy.mockRestore();
    });

    it('rapid successive events all broadcast in order', () => {
      const events = Array.from({ length: 5 }, (_, i) =>
        makeTextChunkEvent({ content: `chunk-${i}`, agentId: 'agent-1' }),
      );

      for (const event of events) {
        bus.emit('run.text_chunk', event);
      }

      expect(sseManager.broadcast).toHaveBeenCalledTimes(5);
      // Verify order
      for (let i = 0; i < 5; i++) {
        expect(sseManager.broadcast.mock.calls[i]![1]).toEqual(
          expect.objectContaining({ content: `chunk-${i}` }),
        );
      }
    });
  });

  describe('lifecycle', () => {
    it('shutdown removes all listeners and no broadcasts after', () => {
      broadcaster.shutdown();

      bus.emit('turn.started', makeRunStartedEvent());
      bus.emit('turn.completed', makeRunCompletedEvent());
      bus.emit('run.text_chunk', makeTextChunkEvent());

      expect(sseManager.broadcast).not.toHaveBeenCalled();
    });
  });
});
