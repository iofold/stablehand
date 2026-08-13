import { EventEmitter } from 'node:events';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { agUiCompatRoutes, toAGUIMessage } from './route.js';

describe('AG-UI compatibility transcript projection', () => {
  it('includes the canonical persisted message timestamp in snapshots', () => {
    expect(toAGUIMessage({
      id: 'message-1',
      role: 'assistant',
      content: 'Persisted answer',
      createdAt: 1_784_546_935_222,
    })).toEqual({
      id: 'message-1',
      role: 'assistant',
      content: 'Persisted answer',
      createdAt: 1_784_546_935_222,
    });
  });

  it('identifies the run and thread in the fallback canonical RUN_ERROR', async () => {
    const app = Fastify({ logger: false });
    await app.register(agUiCompatRoutes, {
      prefix: '/api/ag-ui',
      db: {
        getAgent: vi.fn().mockResolvedValue({ id: 'agent-1' }),
        getTurn: vi.fn().mockResolvedValue({
          id: 'run-1',
          agentId: 'agent-1',
          conversationId: 'thread-1',
          completedAt: null,
        }),
        getMessages: vi.fn().mockResolvedValue([]),
      } as never,
      eventBus: {} as never,
      turnStartupService: {} as never,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/ag-ui/agent-1/run',
        payload: {
          runId: 'run-1',
          threadId: 'thread-1',
          messages: [],
        },
      });

      expect(response.statusCode).toBe(200);
      const events = response.payload
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice('data: '.length)) as unknown);
      expect(events).toEqual([
        {
          type: 'MESSAGES_SNAPSHOT',
          runId: 'run-1',
          threadId: 'thread-1',
          messages: [],
        },
        expect.objectContaining({
          type: 'RUN_ERROR',
          runId: 'run-1',
          threadId: 'thread-1',
          message: 'canonical event log not configured',
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it('closes an in-flight scoped stream after key revocation', async () => {
    vi.useFakeTimers();
    let handler: ((request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) | undefined;
    const app = {
      post: vi.fn((
        _path: string,
        _optionsOrHandler: unknown,
        registeredHandler?: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
      ) => {
        handler = registeredHandler
          ?? _optionsOrHandler as (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
      }),
    } as unknown as FastifyInstance;
    const unsubscribe = vi.fn();
    await agUiCompatRoutes(app, {
      db: {
        getAgent: vi.fn().mockResolvedValue({ id: 'agent-1' }),
        getTurn: vi.fn().mockResolvedValue({
          id: 'run-1',
          agentId: 'agent-1',
          conversationId: 'thread-1',
          completedAt: null,
        }),
        getMessages: vi.fn().mockResolvedValue([]),
      } as never,
      eventBus: {} as never,
      turnStartupService: {} as never,
      canonicalLog: {
        replayTurnTail: vi.fn().mockResolvedValue([]),
        subscribe: vi.fn().mockReturnValue(unsubscribe),
      } as never,
    });
    if (!handler) throw new Error('AG-UI handler was not registered');

    const requestRaw = new EventEmitter();
    const revalidate = vi.fn().mockResolvedValue(false);
    const request = {
      params: { id: 'agent-1' },
      body: {
        runId: 'run-1',
        threadId: 'thread-1',
        messages: [],
      },
      raw: requestRaw,
      revalidateApiPrincipal: revalidate,
    } as unknown as FastifyRequest;
    const responseRaw = Object.assign(new EventEmitter(), {
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      writableEnded: false,
      destroyed: false,
    });
    const reply = {
      raw: responseRaw,
      getHeaders: vi.fn().mockReturnValue({}),
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    } as unknown as FastifyReply;

    await handler(request, reply);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(revalidate).toHaveBeenCalledOnce();
    expect(responseRaw.end).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
