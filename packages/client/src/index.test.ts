import { describe, expect, it } from 'vitest';

import { getA2UIBlock, getHitlRequest, parseSSE } from './index.js';

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe('@ctxmill/client', () => {
  it('parses JSON server-sent events and ignores comments', async () => {
    const events: unknown[] = [];
    for await (const event of parseSSE(streamFromText([
      ': heartbeat',
      '',
      'data: {"type":"RUN_STARTED","runId":"run-1","threadId":"conv-1"}',
      '',
      'data: {"type":"RUN_FINISHED","runId":"run-1","threadId":"conv-1"}',
      '',
    ].join('\n')))) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'RUN_STARTED', runId: 'run-1', threadId: 'conv-1' },
      { type: 'RUN_FINISHED', runId: 'run-1', threadId: 'conv-1' },
    ]);
  });

  it('extracts A2UI render blocks and HITL requests from namespaced custom events', () => {
    expect(getA2UIBlock({
      type: 'CUSTOM',
      name: 'ctxmill.a2ui.render',
      block: {
        id: 'block-1',
        component: 'MetricCard',
        props: { title: 'Open deals', value: 12 },
      },
    })).toEqual({
      id: 'block-1',
      component: 'MetricCard',
      props: { title: 'Open deals', value: 12 },
    });

    expect(getHitlRequest({
      type: 'CUSTOM',
      name: 'ctxmill.hitl.requested',
      runId: 'run-1',
      threadId: 'conv-1',
      agentId: 'agent-1',
      interruptId: 'run-1',
      toolCallId: 'tool-1',
      toolName: 'request-approval',
      args: { reason: 'Deploy' },
    })).toEqual({
      id: 'run-1',
      runId: 'run-1',
      threadId: 'conv-1',
      agentId: 'agent-1',
      toolCallId: 'tool-1',
      toolName: 'request-approval',
      args: { reason: 'Deploy' },
    });
  });
});
