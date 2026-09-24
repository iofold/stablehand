import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { SSEManager, formatSeqId } from '../../../sse.js';
import type { AgentSubRouteOptions } from '../types.js';
import { resolveStreamCursor, streamRoutes } from '../stream.js';

interface ReplayFrame {
  seq: number;
  type: string;
  agentId: string;
  body: Record<string, unknown>;
  turnId: string;
  conversationId: string;
  channel: 'run';
  createdAt: number;
}

type StreamHandler = (
  request: FastifyRequest<{
    Params: { id: string };
    Querystring: { cursor?: string };
  }>,
  reply: FastifyReply,
) => Promise<unknown>;

function frame(seq: number): ReplayFrame {
  return {
    seq,
    type: 'TEXT_MESSAGE_CONTENT',
    agentId: 'agent-1',
    body: {
      type: 'TEXT_MESSAGE_CONTENT',
      runId: 'turn-1',
      threadId: 'conversation-1',
      messageId: 'message-1',
      delta: String(seq),
      timestamp: seq,
    },
    turnId: 'turn-1',
    conversationId: 'conversation-1',
    channel: 'run',
    createdAt: seq,
  };
}

function writtenIds(written: string[]): number[] {
  return written
    .filter((chunk) => chunk.startsWith('id: '))
    .map((chunk) => Number(chunk.split('\n')[0]!.slice(4)));
}

async function serveTestStream(input: {
  durableFrames: ReplayFrame[];
  onReplayPage?: (pageNumber: number, sse: SSEManager) => void;
}): Promise<{ ids: number[]; replayCalls: number }> {
  let handler: StreamHandler | undefined;
  const app = {
    get: vi.fn((
      _path: string,
      _options: unknown,
      registeredHandler: StreamHandler,
    ) => {
      handler = registeredHandler;
    }),
  } as unknown as FastifyInstance;
  const sse = new SSEManager();
  let replayCalls = 0;
  const canonicalLog = {
    replaySince: vi.fn(async (
      _agentId: string,
      afterSeq: number,
      options: { limit?: number; throughSeq?: number },
    ) => {
      replayCalls += 1;
      const page = input.durableFrames
        .filter((candidate) =>
          candidate.seq > afterSeq
          && candidate.seq <= (options.throughSeq ?? Number.POSITIVE_INFINITY))
        .slice(0, options.limit ?? 1_000);
      input.onReplayPage?.(replayCalls, sse);
      return page;
    }),
  };
  await streamRoutes(app, {
    db: {
      getSandboxSessionsByAgent: vi.fn().mockResolvedValue([]),
      getActiveTurnsForAgent: vi.fn().mockResolvedValue([]),
      getLatestEventSeq: vi.fn(async () =>
        input.durableFrames.at(-1)?.seq ?? 0),
    },
    sse,
    canonicalLog,
    loadAgent: vi.fn(),
  } as unknown as AgentSubRouteOptions);

  if (!handler) {
    throw new Error('stream route handler was not registered');
  }

  const written: string[] = [];
  const raw = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      written.push(chunk);
      return true;
    }),
    on: vi.fn(),
    end: vi.fn(),
    writableEnded: false,
    destroyed: false,
  };
  const reply = {
    raw,
    getHeaders: vi.fn().mockReturnValue({}),
    status: vi.fn().mockReturnThis(),
    send: vi.fn(),
  } as unknown as FastifyReply;
  const request = {
    params: { id: 'agent-1' },
    query: { cursor: formatSeqId(0) },
    headers: {},
    log: { debug: vi.fn() },
  } as unknown as FastifyRequest<{
    Params: { id: string };
    Querystring: { cursor?: string };
  }>;

  try {
    await handler(request, reply);
    return { ids: writtenIds(written), replayCalls };
  } finally {
    sse.shutdown();
  }
}

describe('resolveStreamCursor', () => {
  it('uses the explicit snapshot cursor on the first browser connection', () => {
    expect(resolveStreamCursor(undefined, '000000000042')).toEqual({
      afterSeq: 42,
    });
  });

  it('prefers the browser Last-Event-ID after EventSource reconnects', () => {
    expect(resolveStreamCursor('000000000045', '000000000042')).toEqual({
      afterSeq: 45,
    });
  });

  it('rejects a malformed explicit cursor instead of silently skipping replay', () => {
    expect(resolveStreamCursor(undefined, 'legacy-cursor')).toEqual({
      error: 'Invalid event cursor',
    });
  });

  it('keeps an old-format Last-Event-ID as a fresh connection at cutover', () => {
    expect(resolveStreamCursor('legacy-event-id', undefined)).toEqual({
      afterSeq: null,
    });
  });

  it('pages every durable frame when replay exceeds the repository page size', async () => {
    const durableFrames = Array.from({ length: 1_257 }, (_, index) =>
      frame(index + 1));

    const result = await serveTestStream({ durableFrames });

    expect(result.ids).toEqual(durableFrames.map(({ seq }) => seq));
    expect(result.replayCalls).toBe(2);
  });

  it('does not issue an empty follow-up query at an exact page boundary', async () => {
    const durableFrames = Array.from({ length: 1_000 }, (_, index) =>
      frame(index + 1));

    const result = await serveTestStream({ durableFrames });

    expect(result.ids).toEqual(durableFrames.map(({ seq }) => seq));
    expect(result.replayCalls).toBe(1);
  });

  it('buffers every live frame published while durable replay is in progress', async () => {
    const durableFrames = Array.from({ length: 1_000 }, (_, index) =>
      frame(index + 1));

    const result = await serveTestStream({
      durableFrames,
      onReplayPage: (pageNumber, sse) => {
        if (pageNumber !== 1) return;
        for (let seq = 1_001; seq <= 1_257; seq += 1) {
          const liveFrame = frame(seq);
          durableFrames.push(liveFrame);
          sse.broadcastFrame('agent-1', liveFrame.body, seq);
        }
      },
    });

    expect(result.ids).toEqual(
      Array.from({ length: 1_257 }, (_, index) => index + 1),
    );
  });
});
