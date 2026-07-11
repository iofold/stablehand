import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';

import { SSEManager, formatSeqId, parseSeqId } from '../sse.js';

function createReply(): { reply: FastifyReply; written: string[] } {
  const written: string[] = [];
  const raw = {
    write: vi.fn((data: string) => { written.push(data); return true; }),
    on: vi.fn(),
    end: vi.fn(),
    writableEnded: false,
    destroyed: false,
  };
  return { reply: { raw } as unknown as FastifyReply, written };
}

function writtenIds(written: string[]): string[] {
  return written
    .filter((chunk) => chunk.startsWith('id: '))
    .map((chunk) => chunk.split('\n')[0]!.slice(4));
}

describe('durable SSE serving (Stage 4 A2, ADR-015)', () => {
  it('formats and parses zero-padded seq ids (lexicographic == numeric for pilot)', () => {
    expect(formatSeqId(42)).toBe('000000000042');
    expect(formatSeqId(42) < formatSeqId(100)).toBe(true);
    expect(parseSeqId('000000000042')).toBe(42);
    expect(parseSeqId('42')).toBe(42);
    // Legacy id formats → fresh connect.
    expect(parseSeqId('agent-1-17')).toBeNull();
    expect(parseSeqId('1712140000000-abc123')).toBeNull();
    expect(parseSeqId(undefined)).toBeNull();
  });

  it('broadcastFrame writes durable seq ids to attached clients', () => {
    const manager = new SSEManager();
    const { reply, written } = createReply();
    manager.subscribe('agent-1', reply);

    manager.broadcastFrame('agent-1', { type: 'RUN_STARTED', runId: 'turn-1' }, 7);

    expect(writtenIds(written)).toEqual(['000000000007']);
    expect(written.some((chunk) => chunk.includes('"RUN_STARTED"'))).toBe(true);
    manager.shutdown();
  });

  it('subscribeDurable flushes ring-buffered frames the DB replay missed (commit-order race)', () => {
    const manager = new SSEManager();
    // Batch B2 (seqs 7,8) committed and fanned out before batch B1 (5,6):
    // all four are in the ring; the reconnect's DB query saw only 7,8.
    for (const seq of [7, 8, 5, 6]) {
      manager.broadcastFrame('agent-1', { type: 'TEXT_MESSAGE_CONTENT', seq }, seq);
    }

    const { reply, written } = createReply();
    // Client acked seq 4; the route replayed 7,8 from the DB.
    manager.subscribeDurable('agent-1', reply, 4, new Set([7, 8]));

    expect(writtenIds(written)).toEqual([formatSeqId(5), formatSeqId(6)]);
    manager.shutdown();
  });

  it('subscribeDurable writes nothing extra when replay covered everything', () => {
    const manager = new SSEManager();
    manager.broadcastFrame('agent-1', { type: 'RUN_STARTED' }, 10);

    const { reply, written } = createReply();
    manager.subscribeDurable('agent-1', reply, 4, new Set([10]));

    expect(writtenIds(written)).toEqual([]);
    manager.shutdown();
  });

  it('live frames after subscribeDurable reach the client with seq ids', () => {
    const manager = new SSEManager();
    const { reply, written } = createReply();
    manager.subscribeDurable('agent-1', reply, 0, new Set());

    manager.broadcastFrame('agent-1', { type: 'RUN_FINISHED' }, 11);

    expect(writtenIds(written)).toEqual([formatSeqId(11)]);
    manager.shutdown();
  });
});
