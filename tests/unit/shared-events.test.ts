import { describe, it, expect } from 'vitest';
import type { AGUIEventType, AGUIEvent } from '@ctxmill/shared';

describe('Shared AG-UI event types', () => {
  it('should type-check all event types', () => {
    const types: AGUIEventType[] = [
      'RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR',
      'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END',
      'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT',
      'STATE_DELTA', 'CUSTOM',
    ];
    expect(types).toHaveLength(12);
  });

  it('should type-check AGUIEvent structure', () => {
    const event: AGUIEvent = {
      type: 'RUN_STARTED',
      timestamp: Date.now(),
      runId: 'test-run',
    };
    expect(event.type).toBe('RUN_STARTED');
  });
});
