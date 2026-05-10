import { describe, it, expect } from 'vitest';
import { mapMessagesToInternal } from '../agent-helpers.js';

/**
 * Regression coverage for the canonical transcript-assembly path
 * (mapMessagesToInternal). The orchestrator and the run-startup pipeline
 * both depend on this function being deterministic so transcript replay
 * yields the exact same `Message[]` for the same persisted rows.
 *
 * Issue: ctx-zl8 — collapse onto one canonical committed-message path.
 */

type RawRow = Parameters<typeof mapMessagesToInternal>[0][number];
type RawRowWithToolCalls = RawRow & { toolCalls?: unknown[] | null };

function row(overrides: Partial<RawRow> & Pick<RawRow, 'id' | 'role' | 'createdAt'>): RawRow {
  return {
    content: '',
    ...overrides,
  } as RawRow;
}

describe('mapMessagesToInternal — deterministic transcript assembly', () => {
  it('orders rows by createdAt ascending, then by id as a stable tiebreaker', () => {
    const rows: RawRow[] = [
      row({ id: 'b', role: 'user', content: 'second', createdAt: 100 }),
      row({ id: 'a', role: 'user', content: 'first', createdAt: 50 }),
      row({ id: 'c', role: 'assistant', content: 'third', createdAt: 200 }),
    ];

    const result = mapMessagesToInternal(rows, 'agent-1');

    expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(result.map((m) => m.content)).toEqual(['first', 'second', 'third']);
  });

  it('uses id lexical order to break ties on identical createdAt timestamps', () => {
    const sharedTs = new Date('2026-01-01T00:00:00Z');
    const rows: RawRow[] = [
      row({ id: 'msg-c', role: 'user', content: 'c', createdAt: sharedTs }),
      row({ id: 'msg-a', role: 'user', content: 'a', createdAt: sharedTs }),
      row({ id: 'msg-b', role: 'user', content: 'b', createdAt: sharedTs }),
    ];

    const result = mapMessagesToInternal(rows, 'agent-1');

    expect(result.map((m) => m.id)).toEqual(['msg-a', 'msg-b', 'msg-c']);
  });

  it('deduplicates rows that share the same id, keeping first-seen content', () => {
    const rows: RawRow[] = [
      row({ id: 'msg-1', role: 'assistant', content: 'first-seen', createdAt: 100 }),
      row({ id: 'msg-1', role: 'assistant', content: 'duplicate-overwrite-attempt', createdAt: 200 }),
      row({ id: 'msg-2', role: 'user', content: 'unique', createdAt: 150 }),
    ];

    const result = mapMessagesToInternal(rows, 'agent-1');

    expect(result).toHaveLength(2);
    const msg1 = result.find((m) => m.id === 'msg-1');
    expect(msg1?.content).toBe('first-seen');
    expect(result.map((m) => m.id)).toEqual(['msg-1', 'msg-2']);
  });

  it('produces identical output across replay iterations on the same input', () => {
    const rows: RawRow[] = [
      row({ id: 'a', role: 'user', content: 'hello', createdAt: 1 }),
      row({ id: 'b', role: 'assistant', content: 'world', createdAt: 2 }),
      row({ id: 'c', role: 'tool', content: 'tool-result', toolCallId: 'tc-1', createdAt: 3 }),
    ];

    const first = mapMessagesToInternal(rows, 'agent-1');
    const second = mapMessagesToInternal(rows, 'agent-1');
    const third = mapMessagesToInternal(rows, 'agent-1');

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(second)).toBe(JSON.stringify(third));
  });

  it('produces identical output regardless of input row insertion order (replay determinism)', () => {
    const ordered: RawRow[] = [
      row({ id: 'a', role: 'user', content: 'one', createdAt: 1 }),
      row({ id: 'b', role: 'assistant', content: 'two', createdAt: 2 }),
      row({ id: 'c', role: 'tool', content: 'three', toolCallId: 'tc-1', createdAt: 3 }),
      row({ id: 'd', role: 'assistant', content: 'four', createdAt: 4 }),
    ];

    const shuffled: RawRow[] = [ordered[2], ordered[0], ordered[3], ordered[1]];
    const reversed: RawRow[] = [...ordered].reverse();

    const fromOrdered = mapMessagesToInternal(ordered, 'agent-1');
    const fromShuffled = mapMessagesToInternal(shuffled, 'agent-1');
    const fromReversed = mapMessagesToInternal(reversed, 'agent-1');

    expect(JSON.stringify(fromOrdered)).toBe(JSON.stringify(fromShuffled));
    expect(JSON.stringify(fromShuffled)).toBe(JSON.stringify(fromReversed));
    expect(fromOrdered.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('preserves toolCallId and per-row agentId, falling back to the supplied agent id', () => {
    const rows: RawRow[] = [
      row({ id: 'a', role: 'user', content: 'q', createdAt: 1, agentId: 'agent-x' }),
      row({ id: 'b', role: 'tool', content: 'r', toolCallId: 'tc-1', createdAt: 2 }),
    ];

    const result = mapMessagesToInternal(rows, 'agent-fallback');

    expect(result[0]).toMatchObject({ id: 'a', agentId: 'agent-x' });
    expect(result[1]).toMatchObject({ id: 'b', agentId: 'agent-fallback', toolCallId: 'tc-1' });
  });

  it('preserves persisted assistant tool calls before replayed tool result messages', () => {
    const rows: RawRowWithToolCalls[] = [
      row({ id: 'a', role: 'user', content: 'emit an event', createdAt: 1 }),
      {
        ...row({ id: 'b', role: 'assistant', content: '', createdAt: 2 }),
        toolCalls: [
          {
            id: 'tc-1',
            name: 'emit-event',
            args: '{"type":"audit","payload":{"ok":true}}',
            status: 'complete',
          },
        ],
      },
      row({ id: 'c', role: 'tool', content: 'emitted', toolCallId: 'tc-1', createdAt: 3 }),
      row({ id: 'd', role: 'user', content: 'continue', createdAt: 4 }),
    ];

    const result = mapMessagesToInternal(rows, 'agent-1');

    expect(result[1]).toMatchObject({
      id: 'b',
      role: 'assistant',
      toolCalls: [
        {
          id: 'tc-1',
          name: 'emit-event',
          arguments: { type: 'audit', payload: { ok: true } },
        },
      ],
    });
    expect(result[2]).toMatchObject({ role: 'tool', toolCallId: 'tc-1' });
  });

  it('handles mixed Date/number/string createdAt values without losing ordering', () => {
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    const rows: RawRow[] = [
      row({ id: 'a', role: 'user', content: 'first', createdAt: new Date(t0) }),
      row({ id: 'b', role: 'assistant', content: 'second', createdAt: new Date(t0 + 1000).toISOString() }),
      row({ id: 'c', role: 'tool', content: 'third', toolCallId: 't', createdAt: t0 + 2000 }),
    ];

    const result = mapMessagesToInternal(rows, 'agent-1');

    expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});
