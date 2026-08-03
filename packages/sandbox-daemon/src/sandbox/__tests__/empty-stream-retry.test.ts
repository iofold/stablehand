import { describe, expect, it } from 'vitest';

import { agentEventCarriesOutput } from '../runner.js';
import type { AgentEvent } from '../../harness/types.js';

describe('agentEventCarriesOutput (ctx-w03u)', () => {
  it('treats text, tool, approval, custom, committed, and error events as output', () => {
    const carrying: AgentEvent[] = [
      { type: 'text_delta', content: 'h' },
      { type: 'tool_call_start', id: 't1', name: 'bash', args: {} },
      { type: 'tool_call_end', id: 't1', result: 'ok', durationMs: 5 },
      { type: 'approval_needed', id: 'a1', tool: 'bash', args: {} },
      { type: 'approval_resolved', id: 'a1', action: 'approve' },
      {
        type: 'message_committed',
        role: 'assistant',
        content: 'final',
        turnId: 'turn-1',
        messageSeq: 1,
      },
      { type: 'error', error: 'boom' },
    ];
    for (const event of carrying) {
      expect(agentEventCarriesOutput(event), event.type).toBe(true);
    }
  });

  it('treats an empty text delta and a bare done event as no output', () => {
    expect(agentEventCarriesOutput({ type: 'text_delta', content: '' })).toBe(false);
    expect(agentEventCarriesOutput({ type: 'done' })).toBe(false);
    expect(agentEventCarriesOutput({
      type: 'done',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    })).toBe(false);
  });

  it('treats a done event with result text or nonzero usage as output', () => {
    expect(agentEventCarriesOutput({ type: 'done', result: 'answer' })).toBe(true);
    expect(agentEventCarriesOutput({
      type: 'done',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    })).toBe(true);
  });
});
