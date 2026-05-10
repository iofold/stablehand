import { describe, expect, it } from 'vitest';

import { AGUIEventNormalizer } from '../event-normalizer.js';

describe('AGUIEventNormalizer', () => {
  it('emits a stable custom A2UI event after an a2ui-render tool result', () => {
    const normalizer = new AGUIEventNormalizer('turn-1', 'conv-1');

    const events = normalizer.normalize('run.tool_result', {
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      toolCallId: 'tool-1',
      toolName: 'a2ui-render',
      result: JSON.stringify({
        component: 'MetricCard',
        props: { title: 'Revenue', value: '$42k' },
      }),
      durationMs: 12,
      timestamp: 123,
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'TOOL_CALL_END',
        runId: 'turn-1',
        threadId: 'conv-1',
        toolCallId: 'tool-1',
      }),
      {
        type: 'CUSTOM',
        name: 'ctxmill.a2ui.render',
        subtype: 'a2ui_render',
        runId: 'turn-1',
        threadId: 'conv-1',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        toolCallId: 'tool-1',
        toolCallName: 'a2ui-render',
        block: {
          id: 'tool-1',
          component: 'MetricCard',
          props: { title: 'Revenue', value: '$42k' },
        },
        timestamp: 123,
      },
    ]);
  });

  it('emits stable custom HITL request and resolution event names', () => {
    const normalizer = new AGUIEventNormalizer('turn-1', 'conv-1');

    const requested = normalizer.normalize('run.interrupted', {
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      toolCallId: 'tool-approval',
      toolName: 'request-approval',
      args: { reason: 'Deploy to production' },
      interruptId: 'turn-1',
      timestamp: 456,
    });
    const resolved = normalizer.normalize('run.interrupt_resolved', {
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      interruptId: 'turn-1',
      action: 'approve',
      timestamp: 789,
    });

    expect(requested).toEqual([
      expect.objectContaining({
        type: 'CUSTOM',
        name: 'ctxmill.hitl.requested',
        subtype: 'hitl_pause',
        interruptId: 'turn-1',
      }),
    ]);
    expect(resolved).toEqual([
      expect.objectContaining({
        type: 'CUSTOM',
        name: 'ctxmill.hitl.resolved',
        subtype: 'hitl_resolved',
        interruptId: 'turn-1',
        action: 'approve',
      }),
    ]);
  });
});
