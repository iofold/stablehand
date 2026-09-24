import { describe, expect, it } from 'vitest';
import { mapMessagesToInternal } from '../../packages/stablehand/src/orchestrator/routes/agent-helpers.js';

describe('canonical transcript assembly', () => {
  it('orders by createdAt then id and de-duplicates replayed rows by message id', () => {
    const transcript = mapMessagesToInternal([
      { id: 'm-3', role: 'assistant', content: 'third', createdAt: 3000 },
      { id: 'm-2', role: 'assistant', content: 'second', createdAt: 2000 },
      { id: 'm-1', agentId: 'agent-a', role: 'user', content: 'first', createdAt: 1000 },
      { id: 'm-2', role: 'assistant', content: 'duplicate second', createdAt: 2000 },
      { id: 'm-0', role: 'system', content: 'same-time first', createdAt: 1000 },
    ], 'fallback-agent');

    expect(transcript.map((message) => message.id)).toEqual(['m-0', 'm-1', 'm-2', 'm-3']);
    expect(transcript.map((message) => message.content)).toEqual([
      'same-time first',
      'first',
      'second',
      'third',
    ]);
    expect(transcript.map((message) => message.agentId)).toEqual([
      'fallback-agent',
      'agent-a',
      'fallback-agent',
      'fallback-agent',
    ]);
  });
});
