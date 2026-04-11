import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSEBroadcaster } from '../../packages/ctxmill/src/orchestrator/sse-broadcaster.js';
import type { SSEManager } from '../../packages/ctxmill/src/orchestrator/sse.js';
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
    broadcaster = new SSEBroadcaster(sseManager as unknown as SSEManager, bus);
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

    it('turn.pending → TURN_PENDING with correct fields', () => {
      const event: EventMap['turn.pending'] = {
        turnId: 'run-pending-1',
        agentId: 'agent-1',
        conversationId: 'thread-1',
        mode: 'interactive',
        taskDescription: 'Waiting for execution',
        timestamp: 101,
      };

      bus.emit('turn.pending', event);

      expect(sseManager.broadcast).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          type: 'TURN_PENDING',
          runId: 'run-pending-1',
          threadId: 'thread-1',
          conversationId: 'thread-1',
          timestamp: 101,
          internalType: 'turn.pending',
        }),
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

    it('turn.completed with status completed → emits only RUN_FINISHED (no RUN_ERROR)', () => {
      const event = makeRunCompletedEvent({ status: 'completed', timestamp: 202 });
      bus.emit('turn.completed', event);

      expect(sseManager.broadcast).toHaveBeenCalledTimes(1);
      expect(sseManager.broadcast).toHaveBeenCalledWith(
        event.agentId,
        expect.objectContaining({
          type: 'RUN_FINISHED',
          runId: event.turnId,
          threadId: event.conversationId,
          timestamp: 202,
        }),
      );
      expect(sseManager.broadcast).not.toHaveBeenCalledWith(
        event.agentId,
        expect.objectContaining({ type: 'RUN_ERROR' }),
      );
    });

    it('turn.completed with status error → emits RUN_ERROR then RUN_FINISHED (2 broadcasts, check order)', () => {
      const event = makeRunCompletedEvent({
        status: 'error',
        error: 'boom',
        timestamp: 303,
      });

      bus.emit('turn.completed', event);

      expect(sseManager.broadcast).toHaveBeenCalledTimes(2);
      expect(sseManager.broadcast).toHaveBeenNthCalledWith(
        1,
        event.agentId,
        expect.objectContaining({
          type: 'RUN_ERROR',
          runId: event.turnId,
          threadId: event.conversationId,
          message: 'boom',
          timestamp: 303,
        }),
      );
      expect(sseManager.broadcast).toHaveBeenNthCalledWith(
        2,
        event.agentId,
        expect.objectContaining({
          type: 'RUN_FINISHED',
          runId: event.turnId,
          threadId: event.conversationId,
          timestamp: 303,
        }),
      );
    });

    it('turn.completed with status cancelled → emits RUN_ERROR then RUN_FINISHED', () => {
      const event = makeRunCompletedEvent({
        status: 'cancelled',
        error: 'cancelled by user',
      });

      bus.emit('turn.completed', event);

      expect(sseManager.broadcast).toHaveBeenCalledTimes(2);
      expect(sseManager.broadcast).toHaveBeenNthCalledWith(
        1,
        event.agentId,
        expect.objectContaining({
          type: 'RUN_ERROR',
          message: 'cancelled by user',
        }),
      );
      expect(sseManager.broadcast).toHaveBeenNthCalledWith(
        2,
        event.agentId,
        expect.objectContaining({ type: 'RUN_FINISHED' }),
      );
    });

    it('run.interrupted → HITL_PAUSE (not CUSTOM)', () => {
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
        expect.objectContaining({ type: 'HITL_PAUSE' }),
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

    it('run.ag_ui_event → forwards event payload as-is to SSE', () => {
      const event: EventMap['run.ag_ui_event'] = {
        turnId: 'run-2',
        agentId: 'agent-2',
        conversationId: 'thread-2',
        event: {
          type: 'TEXT_MESSAGE_END',
          runId: 'run-2',
          timestamp: 404,
          messageId: 'msg-2',
          customField: 'keep-me',
        },
        timestamp: 405,
      };

      bus.emit('run.ag_ui_event', event);

      expect(sseManager.broadcast).toHaveBeenCalledWith(
        'agent-2',
        expect.objectContaining({
          type: 'TEXT_MESSAGE_END',
          runId: 'run-2',
          timestamp: 404,
          messageId: 'msg-2',
          customField: 'keep-me',
          threadId: 'thread-2',
          conversationId: 'thread-2',
          internalType: 'run.ag_ui_event',
        }),
      );
    });

    it('user.message → emits TEXT_MESSAGE_START + TEXT_MESSAGE_CONTENT + TEXT_MESSAGE_END (3 broadcasts)', () => {
      const event: EventMap['user.message'] = {
        agentId: 'agent-user',
        conversationId: 'thread-user',
        messageId: 'msg-user',
        content: 'hello from user',
        timestamp: 505,
      };

      bus.emit('user.message', event);

      expect(sseManager.broadcast).toHaveBeenCalledTimes(3);
      expect(sseManager.broadcast).toHaveBeenNthCalledWith(
        1,
        'agent-user',
        expect.objectContaining({
          type: 'TEXT_MESSAGE_START',
          runId: 'thread-user',
          role: 'user',
          messageId: 'msg-user',
          threadId: 'thread-user',
        }),
      );
      expect(sseManager.broadcast).toHaveBeenNthCalledWith(
        2,
        'agent-user',
        expect.objectContaining({
          type: 'TEXT_MESSAGE_CONTENT',
          runId: 'thread-user',
          messageId: 'msg-user',
          delta: 'hello from user',
          threadId: 'thread-user',
        }),
      );
      expect(sseManager.broadcast).toHaveBeenNthCalledWith(
        3,
        'agent-user',
        expect.objectContaining({
          type: 'TEXT_MESSAGE_END',
          runId: 'thread-user',
          messageId: 'msg-user',
          threadId: 'thread-user',
        }),
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
      const event = {
        ...makeTextChunkEvent({
          turnId: 'run-xyz',
          agentId: 'agent-xyz',
          messageId: 'msg-xyz',
          content: 'hello there',
        }),
        conversationId: 'thread-xyz',
      };
      bus.emit('run.text_chunk', event);

      expect(sseManager.broadcast).toHaveBeenCalledWith(
        'agent-xyz',
        expect.objectContaining({
          turnId: 'run-xyz',
          runId: 'run-xyz',
          agentId: 'agent-xyz',
          messageId: 'msg-xyz',
          content: 'hello there',
          delta: 'hello there',
          threadId: 'thread-xyz',
          conversationId: 'thread-xyz',
          type: 'TEXT_MESSAGE_CONTENT',
          internalType: 'run.text_chunk',
        }),
      );
    });

    it('field renames: TEXT_MESSAGE_CONTENT has delta field', () => {
      const event = makeTextChunkEvent({ content: 'delta me' });
      bus.emit('run.text_chunk', event);

      expect(sseManager.broadcast).toHaveBeenCalledWith(
        event.agentId,
        expect.objectContaining({
          type: 'TEXT_MESSAGE_CONTENT',
          content: 'delta me',
          delta: 'delta me',
        }),
      );
    });

    it('field renames: TOOL_CALL_START has toolCallName field', () => {
      const event = makeToolStartedEvent({ toolName: 'read_file' });
      bus.emit('run.tool_started', event);

      expect(sseManager.broadcast).toHaveBeenNthCalledWith(
        1,
        event.agentId,
        expect.objectContaining({
          type: 'TOOL_CALL_START',
          toolName: 'read_file',
          toolCallName: 'read_file',
        }),
      );
    });

    it('TOOL_CALL_ARGS uses delta and keeps backward-compatible args', () => {
      const event = makeToolStartedEvent({ args: { path: './test.md' }, timestamp: 606 });
      bus.emit('run.tool_started', event);

      expect(sseManager.broadcast).toHaveBeenNthCalledWith(
        2,
        event.agentId,
        expect.objectContaining({
          type: 'TOOL_CALL_ARGS',
          delta: JSON.stringify(event.args),
          args: JSON.stringify(event.args),
          timestamp: 606,
        }),
      );
    });

    it('field renames: TOOL_CALL_RESULT has content field', () => {
      const event = makeToolResultEvent({ result: 'tool output' });
      bus.emit('run.tool_result', event);

      expect(sseManager.broadcast).toHaveBeenCalledWith(
        event.agentId,
        expect.objectContaining({
          type: 'TOOL_CALL_RESULT',
          result: 'tool output',
          content: 'tool output',
        }),
      );
    });

    it('field renames: all events have threadId when conversationId present', () => {
      const runStartedEvent = makeRunStartedEvent({ conversationId: 'thread-a' });
      const textChunkEvent = { ...makeTextChunkEvent(), conversationId: 'thread-b' };
      const toolStartedEvent = { ...makeToolStartedEvent(), conversationId: 'thread-c' };
      const toolResultEvent = { ...makeToolResultEvent(), conversationId: 'thread-d' };
      const turnCompletedEvent = makeRunCompletedEvent({ conversationId: 'thread-e' });
      const agUiEvent: EventMap['run.ag_ui_event'] = {
        turnId: 'run-f',
        agentId: 'agent-f',
        conversationId: 'thread-f',
        event: {
          type: 'RUN_STARTED',
          runId: 'run-f',
          timestamp: 707,
        },
        timestamp: 708,
      };
      const userMessageEvent: EventMap['user.message'] = {
        agentId: 'agent-g',
        conversationId: 'thread-g',
        messageId: 'msg-g',
        content: 'hi',
        timestamp: 709,
      };

      bus.emit('turn.started', runStartedEvent);
      bus.emit('run.text_chunk', textChunkEvent);
      bus.emit('run.tool_started', toolStartedEvent);
      bus.emit('run.tool_result', toolResultEvent);
      bus.emit('turn.completed', turnCompletedEvent);
      bus.emit('run.ag_ui_event', agUiEvent);
      bus.emit('user.message', userMessageEvent);

      for (const [, payload] of sseManager.broadcast.mock.calls) {
        const eventPayload = payload as Record<string, unknown>;
        expect(eventPayload.threadId).toBe(eventPayload.conversationId);
      }
    });

    it('RUN_ERROR from turn.completed has message field (not error)', () => {
      const event = makeRunCompletedEvent({
        status: 'error',
        error: 'failed hard',
      });

      bus.emit('turn.completed', event);

      const runErrorPayload = sseManager.broadcast.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(runErrorPayload.type).toBe('RUN_ERROR');
      expect(runErrorPayload.message).toBe('failed hard');
      expect(runErrorPayload).not.toHaveProperty('error');
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
