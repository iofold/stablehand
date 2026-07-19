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

  it('subscribeDurable replays the database tail in durable sequence order', async () => {
    const manager = new SSEManager();
    const { reply, written } = createReply();
    const frames = [5, 6, 7, 8].map((seq) => ({
      seq,
      event: { type: 'TEXT_MESSAGE_CONTENT', seq },
    }));
    await manager.subscribeDurable('agent-1', reply, 4, 8, {
      getWatermark: async () => 8,
      getPage: async (afterSeq, throughSeq, limit) =>
        frames.filter(({ seq }) => seq > afterSeq && seq <= throughSeq).slice(0, limit),
    });

    expect(writtenIds(written)).toEqual(
      [5, 6, 7, 8].map((seq) => formatSeqId(seq)),
    );
    manager.shutdown();
  });

  it('subscribeDurable writes nothing when the client cursor covers the watermark', async () => {
    const manager = new SSEManager();
    const { reply, written } = createReply();
    await manager.subscribeDurable('agent-1', reply, 10, 10, {
      getWatermark: async () => 10,
      getPage: async () => [],
    });

    expect(writtenIds(written)).toEqual([]);
    manager.shutdown();
  });

  it('live frame broadcasts wake the database tail and reach the client with seq ids', async () => {
    const manager = new SSEManager();
    const { reply, written } = createReply();
    const frames: Array<{ seq: number; event: Record<string, unknown> }> = [];
    await manager.subscribeDurable('agent-1', reply, 0, 0, {
      getWatermark: async () => frames.at(-1)?.seq ?? 0,
      getPage: async (afterSeq, throughSeq, limit) =>
        frames.filter(({ seq }) => seq > afterSeq && seq <= throughSeq).slice(0, limit),
    });

    frames.push({ seq: 11, event: { type: 'RUN_FINISHED' } });
    manager.broadcastFrame('agent-1', { type: 'RUN_FINISHED' }, 11);

    await vi.waitFor(() => {
      expect(writtenIds(written)).toEqual([formatSeqId(11)]);
    });
    manager.shutdown();
  });

  it('polls the database tail for commits made without a local broadcast', async () => {
    const manager = new SSEManager();
    const { reply, written } = createReply();
    const frames: Array<{ seq: number; event: Record<string, unknown> }> = [];
    await manager.subscribeDurable('agent-1', reply, 0, 0, {
      getWatermark: async () => frames.at(-1)?.seq ?? 0,
      getPage: async (afterSeq, throughSeq, limit) =>
        frames.filter(({ seq }) => seq > afterSeq && seq <= throughSeq).slice(0, limit),
    });

    frames.push({ seq: 12, event: { type: 'RUN_FINISHED' } });

    await vi.waitFor(() => {
      expect(writtenIds(written)).toEqual([formatSeqId(12)]);
    }, { timeout: 1_000 });
    manager.shutdown();
  });
});
