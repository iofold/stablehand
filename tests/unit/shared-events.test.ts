import { describe, it, expect } from 'vitest';
import type { AGUIEventType, AGUIEvent, MessageCommittedEvent } from '../../packages/shared/src/index.js';

describe('Shared AG-UI event types', () => {
  it('should type-check all event types', () => {
    const types: AGUIEventType[] = [
      'RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR',
      'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END',
      'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT',
      'STATE_DELTA', 'HITL_PAUSE', 'MESSAGE_COMMITTED', 'CUSTOM',
    ];
    expect(types).toHaveLength(14);
  });

  it('should type-check AGUIEvent structure', () => {
    const event: AGUIEvent = {
      type: 'RUN_STARTED',
      timestamp: Date.now(),
      runId: 'test-run',
    };
    expect(event.type).toBe('RUN_STARTED');
  });

  it('should type-check MessageCommittedEvent structure', () => {
    const event: MessageCommittedEvent = {
      type: 'MESSAGE_COMMITTED',
      timestamp: Date.now(),
      runId: 'test-run',
      role: 'assistant',
      content: 'Committed output',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'lookup',
          args: '{"query":"ctxmill"}',
          status: 'complete',
          result: 'ok',
        },
      ],
      turnId: 'turn-1',
      messageSeq: 1,
    };

    expect(event.type).toBe('MESSAGE_COMMITTED');
    expect(event.messageSeq).toBe(1);
  });
});
