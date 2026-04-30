import { describe, it, expect, beforeEach } from 'vitest';
import { AGUIEventNormalizer } from '../../packages/ctxmill/src/orchestrator/ag-ui-compat/event-normalizer.js';
import type { EventMap, EventName } from '../../packages/ctxmill/src/events/bus.js';

describe('AGUIEventNormalizer', () => {
  let normalizer: AGUIEventNormalizer;
  const runId = 'run-123';
  const threadId = 'thread-456';
  const timestamp = 1000;

  beforeEach(() => {
    normalizer = new AGUIEventNormalizer(runId, threadId);
  });

  describe('RUN_STARTED', () => {
    it('should convert turn.started to RUN_STARTED with correct runId and threadId', () => {
      const payload: EventMap['turn.started'] = {
        turnId: 'turn-1',
        sessionId: 'session-1',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        mode: 'interactive',
        taskDescription: 'Test task',
        timestamp,
      };

      const result = normalizer.normalize('turn.started', payload);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'RUN_STARTED',
        runId,
        threadId,
        timestamp,
      });
    });
  });

  describe('TEXT_MESSAGE lifecycle', () => {
    it('should emit TEXT_MESSAGE_START and TEXT_MESSAGE_CONTENT on first text chunk', () => {
      const payload: EventMap['run.text_chunk'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        messageId: 'msg-1',
        content: 'Hello',
        timestamp,
      };

      const result = normalizer.normalize('run.text_chunk', payload);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        type: 'TEXT_MESSAGE_START',
        runId,
        threadId,
        messageId: 'msg-1',
        role: 'assistant',
        timestamp,
      });
      expect(result[1]).toEqual({
        type: 'TEXT_MESSAGE_CONTENT',
        runId,
        threadId,
        messageId: 'msg-1',
        delta: 'Hello',
        timestamp,
      });
    });

    it('should emit only TEXT_MESSAGE_CONTENT on subsequent chunks', () => {
      const payload1: EventMap['run.text_chunk'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        messageId: 'msg-1',
        content: 'Hello',
        timestamp,
      };
      const payload2: EventMap['run.text_chunk'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        messageId: 'msg-1',
        content: ' world',
        timestamp: timestamp + 1,
      };

      normalizer.normalize('run.text_chunk', payload1);
      const result = normalizer.normalize('run.text_chunk', payload2);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'TEXT_MESSAGE_CONTENT',
        runId,
        threadId,
        messageId: 'msg-1',
        delta: ' world',
        timestamp: timestamp + 1,
      });
    });

    it('should auto-close TEXT_MESSAGE when tool starts', () => {
      const textPayload: EventMap['run.text_chunk'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        messageId: 'msg-1',
        content: 'Calling tool',
        timestamp,
      };
      const toolPayload: EventMap['run.tool_started'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        toolCallId: 'tool-1',
        toolName: 'search',
        args: { query: 'test' },
        timestamp: timestamp + 1,
      };

      normalizer.normalize('run.text_chunk', textPayload);
      const result = normalizer.normalize('run.tool_started', toolPayload);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        type: 'TEXT_MESSAGE_END',
        runId,
        threadId,
        messageId: 'msg-1',
        timestamp: timestamp + 1,
      });
      expect(result[1]).toEqual({
        type: 'TOOL_CALL_START',
        runId,
        threadId,
        toolCallId: 'tool-1',
        toolCallName: 'search',
        timestamp: timestamp + 1,
      });
      expect(result[2]).toEqual({
        type: 'TOOL_CALL_ARGS',
        runId,
        threadId,
        toolCallId: 'tool-1',
        delta: JSON.stringify({ query: 'test' }),
        timestamp: timestamp + 1,
      });
    });

    it('should auto-close TEXT_MESSAGE when turn completes', () => {
      const textPayload: EventMap['run.text_chunk'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        messageId: 'msg-1',
        content: 'Done',
        timestamp,
      };
      const completedPayload: EventMap['turn.completed'] = {
        turnId: 'turn-1',
        sessionId: 'session-1',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        status: 'completed',
        durationMs: 100,
        timestamp: timestamp + 1,
      };

      normalizer.normalize('run.text_chunk', textPayload);
      const result = normalizer.normalize('turn.completed', completedPayload);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        type: 'TEXT_MESSAGE_END',
        runId,
        threadId,
        messageId: 'msg-1',
        timestamp: timestamp + 1,
      });
      expect(result[1]).toEqual({
        type: 'RUN_FINISHED',
        runId,
        threadId,
        status: 'completed',
        timestamp: timestamp + 1,
      });
    });

    it('should not close TEXT_MESSAGE if no text is in progress', () => {
      const toolPayload: EventMap['run.tool_started'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        toolCallId: 'tool-1',
        toolName: 'search',
        args: { query: 'test' },
        timestamp,
      };

      const result = normalizer.normalize('run.tool_started', toolPayload);

      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('TOOL_CALL_START');
      expect(result[1].type).toBe('TOOL_CALL_ARGS');
    });
  });

  describe('TOOL_CALL lifecycle', () => {
    it('should emit TOOL_CALL_START and TOOL_CALL_ARGS on tool_started', () => {
      const payload: EventMap['run.tool_started'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        toolCallId: 'tool-1',
        toolName: 'search',
        args: { query: 'test', limit: 5 },
        timestamp,
      };

      const result = normalizer.normalize('run.tool_started', payload);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        type: 'TOOL_CALL_START',
        runId,
        threadId,
        toolCallId: 'tool-1',
        toolCallName: 'search',
        timestamp,
      });
      expect(result[1]).toEqual({
        type: 'TOOL_CALL_ARGS',
        runId,
        threadId,
        toolCallId: 'tool-1',
        delta: JSON.stringify({ query: 'test', limit: 5 }),
        timestamp,
      });
    });

    it('should emit TOOL_CALL_END on tool_result', () => {
      const payload: EventMap['run.tool_result'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        toolCallId: 'tool-1',
        toolName: 'search',
        result: 'Found 3 results',
        durationMs: 500,
        timestamp,
      };

      const result = normalizer.normalize('run.tool_result', payload);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'TOOL_CALL_END',
        runId,
        threadId,
        toolCallId: 'tool-1',
        toolCallName: 'search',
        result: 'Found 3 results',
        timestamp,
      });
    });

    it('should use error field in TOOL_CALL_END if present', () => {
      const payload: EventMap['run.tool_result'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        toolCallId: 'tool-1',
        toolName: 'search',
        result: 'fallback',
        durationMs: 500,
        error: 'Tool execution failed',
        timestamp,
      };

      const result = normalizer.normalize('run.tool_result', payload);

      expect(result[0].result).toBe('Tool execution failed');
    });
  });

  describe('RUN_ERROR and RUN_FINISHED', () => {
    it('should emit RUN_ERROR and RUN_FINISHED on error status', () => {
      const payload: EventMap['turn.completed'] = {
        turnId: 'turn-1',
        sessionId: 'session-1',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        status: 'error',
        error: 'Something went wrong',
        durationMs: 100,
        timestamp,
      };

      const result = normalizer.normalize('turn.completed', payload);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        type: 'RUN_ERROR',
        runId,
        threadId,
        error: 'Something went wrong',
        status: 'error',
        timestamp,
      });
      expect(result[1]).toEqual({
        type: 'RUN_FINISHED',
        runId,
        threadId,
        status: 'error',
        timestamp,
      });
    });

    it('should emit RUN_ERROR with default message if error field is missing', () => {
      const payload: EventMap['turn.completed'] = {
        turnId: 'turn-1',
        sessionId: 'session-1',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        status: 'error',
        durationMs: 100,
        timestamp,
      };

      const result = normalizer.normalize('turn.completed', payload);

      expect(result[0]).toEqual({
        type: 'RUN_ERROR',
        runId,
        threadId,
        error: 'Run failed',
        status: 'error',
        timestamp,
      });
    });

    it('should emit RUN_ERROR with "Run cancelled" message on cancelled status', () => {
      const payload: EventMap['turn.completed'] = {
        turnId: 'turn-1',
        sessionId: 'session-1',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        status: 'cancelled',
        durationMs: 100,
        timestamp,
      };

      const result = normalizer.normalize('turn.completed', payload);

      expect(result[0]).toEqual({
        type: 'RUN_ERROR',
        runId,
        threadId,
        error: 'Run cancelled',
        status: 'cancelled',
        timestamp,
      });
    });

    it('should emit only RUN_FINISHED on completed status', () => {
      const payload: EventMap['turn.completed'] = {
        turnId: 'turn-1',
        sessionId: 'session-1',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        status: 'completed',
        durationMs: 100,
        timestamp,
      };

      const result = normalizer.normalize('turn.completed', payload);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'RUN_FINISHED',
        runId,
        threadId,
        status: 'completed',
        timestamp,
      });
    });
  });

  describe('HITL events', () => {
    it('should emit CUSTOM with subtype hitl_pause on run.interrupted', () => {
      const payload: EventMap['run.interrupted'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        toolCallId: 'tool-1',
        toolName: 'approve_action',
        args: { action: 'delete_file' },
        interruptId: 'interrupt-1',
        timestamp,
      };

      const result = normalizer.normalize('run.interrupted', payload);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'CUSTOM',
        runId,
        threadId,
        subtype: 'hitl_pause',
        toolCallId: 'tool-1',
        toolName: 'approve_action',
        args: { action: 'delete_file' },
        interruptId: 'interrupt-1',
        timestamp,
      });
    });

    it('should emit CUSTOM with subtype hitl_resolved on run.interrupt_resolved', () => {
      const payload: EventMap['run.interrupt_resolved'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        interruptId: 'interrupt-1',
        action: 'approve',
        timestamp,
      };

      const result = normalizer.normalize('run.interrupt_resolved', payload);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'CUSTOM',
        runId,
        threadId,
        subtype: 'hitl_resolved',
        interruptId: 'interrupt-1',
        action: 'approve',
        timestamp,
      });
    });
  });

  describe('Passthrough', () => {
    it('should pass through run.ag_ui_event as-is', () => {
      const innerEvent = {
        type: 'CUSTOM_CHART',
        data: { values: [1, 2, 3] },
      };
      const payload: EventMap['run.ag_ui_event'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        event: innerEvent,
        timestamp,
      };

      const result = normalizer.normalize('run.ag_ui_event', payload);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(innerEvent);
    });
  });

  describe('messageId counter', () => {
    it('should use same messageId for consecutive chunks in same message', () => {
      const payload1: EventMap['run.text_chunk'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        messageId: 'msg-1',
        content: 'First part',
        timestamp,
      };
      const payload2: EventMap['run.text_chunk'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        messageId: 'msg-1',
        content: ' second part',
        timestamp: timestamp + 10,
      };

      const result1 = normalizer.normalize('run.text_chunk', payload1);
      const result2 = normalizer.normalize('run.text_chunk', payload2);

      expect(result1[0].messageId).toBe('msg-1');
      expect(result2[0].messageId).toBe('msg-1');
    });

    it('should use msg-1, msg-2, msg-3 format', () => {
      const normalizer2 = new AGUIEventNormalizer(runId, threadId);

      const payload1: EventMap['run.text_chunk'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        messageId: 'msg-1',
        content: 'First',
        timestamp,
      };

      const result1 = normalizer2.normalize('run.text_chunk', payload1);
      expect(result1[0].messageId).toBe('msg-1');

      const completedPayload: EventMap['turn.completed'] = {
        turnId: 'turn-1',
        sessionId: 'session-1',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        status: 'completed',
        durationMs: 100,
        timestamp: timestamp + 1,
      };
      normalizer2.normalize('turn.completed', completedPayload);

      const payload2: EventMap['run.text_chunk'] = {
        turnId: 'turn-2',
        agentId: 'agent-1',
        messageId: 'msg-2',
        content: 'Second',
        timestamp: timestamp + 2,
      };

      const result2 = normalizer2.normalize('run.text_chunk', payload2);
      expect(result2[0].messageId).toBe('msg-2');
    });
  });

  describe('Complex sequences', () => {
    it('should handle text -> tool -> text -> completion sequence', () => {
      const normalizer2 = new AGUIEventNormalizer(runId, threadId);

      const textPayload1: EventMap['run.text_chunk'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        messageId: 'msg-1',
        content: 'Let me search',
        timestamp,
      };
      const result1 = normalizer2.normalize('run.text_chunk', textPayload1);
      expect(result1[0].type).toBe('TEXT_MESSAGE_START');

      const toolPayload: EventMap['run.tool_started'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        toolCallId: 'tool-1',
        toolName: 'search',
        args: { query: 'test' },
        timestamp: timestamp + 1,
      };
      const result2 = normalizer2.normalize('run.tool_started', toolPayload);
      expect(result2[0].type).toBe('TEXT_MESSAGE_END');
      expect(result2[1].type).toBe('TOOL_CALL_START');

      const toolResultPayload: EventMap['run.tool_result'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        toolCallId: 'tool-1',
        toolName: 'search',
        result: 'Found results',
        durationMs: 500,
        timestamp: timestamp + 2,
      };
      const result3 = normalizer2.normalize('run.tool_result', toolResultPayload);
      expect(result3[0].type).toBe('TOOL_CALL_END');

      const textPayload2: EventMap['run.text_chunk'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        messageId: 'msg-1',
        content: 'Based on results',
        timestamp: timestamp + 3,
      };
      const result4 = normalizer2.normalize('run.text_chunk', textPayload2);
      expect(result4[0].type).toBe('TEXT_MESSAGE_START');
      expect(result4[0].messageId).toBe('msg-2');

      const completedPayload: EventMap['turn.completed'] = {
        turnId: 'turn-1',
        sessionId: 'session-1',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        status: 'completed',
        durationMs: 1000,
        timestamp: timestamp + 4,
      };
      const result5 = normalizer2.normalize('turn.completed', completedPayload);
      expect(result5[0].type).toBe('TEXT_MESSAGE_END');
      expect(result5[1].type).toBe('RUN_FINISHED');
    });

    it('should handle multiple tool calls in sequence', () => {
      const normalizer2 = new AGUIEventNormalizer(runId, threadId);

      const tool1Payload: EventMap['run.tool_started'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        toolCallId: 'tool-1',
        toolName: 'search',
        args: { query: 'test' },
        timestamp,
      };
      const result1 = normalizer2.normalize('run.tool_started', tool1Payload);
      expect(result1[0].type).toBe('TOOL_CALL_START');

      const tool1ResultPayload: EventMap['run.tool_result'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        toolCallId: 'tool-1',
        toolName: 'search',
        result: 'Results',
        durationMs: 500,
        timestamp: timestamp + 1,
      };
      normalizer2.normalize('run.tool_result', tool1ResultPayload);

      const tool2Payload: EventMap['run.tool_started'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        toolCallId: 'tool-2',
        toolName: 'analyze',
        args: { data: 'test' },
        timestamp: timestamp + 2,
      };
      const result2 = normalizer2.normalize('run.tool_started', tool2Payload);
      expect(result2[0].type).toBe('TOOL_CALL_START');
      expect(result2[0].toolCallId).toBe('tool-2');

      const tool2ResultPayload: EventMap['run.tool_result'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        toolCallId: 'tool-2',
        toolName: 'analyze',
        result: 'Analysis',
        durationMs: 300,
        timestamp: timestamp + 3,
      };
      const result3 = normalizer2.normalize('run.tool_result', tool2ResultPayload);
      expect(result3[0].toolCallId).toBe('tool-2');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty args in tool call', () => {
      const payload: EventMap['run.tool_started'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        toolCallId: 'tool-1',
        toolName: 'no_args_tool',
        args: {},
        timestamp,
      };

      const result = normalizer.normalize('run.tool_started', payload);

      expect(result[1].delta).toBe('{}');
    });

    it('should handle complex nested args in tool call', () => {
      const complexArgs = {
        nested: {
          deep: {
            value: [1, 2, 3],
          },
        },
        list: ['a', 'b', 'c'],
      };
      const payload: EventMap['run.tool_started'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        toolCallId: 'tool-1',
        toolName: 'complex_tool',
        args: complexArgs,
        timestamp,
      };

      const result = normalizer.normalize('run.tool_started', payload);

      expect(result[1].delta).toBe(JSON.stringify(complexArgs));
    });

    it('should handle empty text chunk', () => {
      const payload: EventMap['run.text_chunk'] = {
        turnId: 'turn-1',
        agentId: 'agent-1',
        messageId: 'msg-1',
        content: '',
        timestamp,
      };

      const result = normalizer.normalize('run.text_chunk', payload);

      expect(result).toHaveLength(2);
      expect(result[1].delta).toBe('');
    });

    it('should handle unknown event type', () => {
      const result = normalizer.normalize('custom' as EventName, {
        type: 'unknown',
        agentId: 'agent-1',
        payload: {},
        timestamp,
      });

      expect(result).toEqual([]);
    });
  });
});
