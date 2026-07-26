import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { feedbackRoutes } from '../feedback.js';
import type { AgentSubRouteOptions } from '../types.js';

type FeedbackHandler = (
  request: FastifyRequest<{
    Params: { id: string };
    Body: {
      conversationId: string;
      messageId?: string;
      type: 'thumbs_up' | 'thumbs_down';
      comment?: unknown;
    };
  }>,
  reply: FastifyReply,
) => Promise<unknown>;

async function registerHandler(db: Record<string, unknown>) {
  let handler: FeedbackHandler | undefined;
  const app = {
    post: vi.fn((
      _path: string,
      _options: unknown,
      registered: FeedbackHandler,
    ) => {
      handler = registered;
    }),
  } as unknown as FastifyInstance;
  const emitAsync = vi.fn().mockResolvedValue(undefined);
  await feedbackRoutes(app, {
    db,
    eventBus: { emitAsync },
    loadAgent: vi.fn(),
  } as unknown as AgentSubRouteOptions);
  if (!handler) throw new Error('feedback route handler was not registered');
  return { handler, emitAsync };
}

async function invoke(
  handler: FeedbackHandler,
  body: {
    conversationId: string;
    messageId?: string;
    type: 'thumbs_up' | 'thumbs_down';
    comment?: unknown;
  },
) {
  let statusCode = 200;
  let responseBody: unknown;
  const reply = {
    status: vi.fn((nextStatus: number) => {
      statusCode = nextStatus;
      return reply;
    }),
    send: vi.fn((value: unknown) => {
      responseBody = value;
      return value;
    }),
  } as unknown as FastifyReply;
  await handler({
    params: { id: 'agent-1' },
    body,
  } as FastifyRequest<{
    Params: { id: string };
    Body: typeof body;
  }>, reply);
  return { statusCode, responseBody };
}

describe('feedbackRoutes', () => {
  it('uses the target message turn instead of the conversation latest turn', async () => {
    const { handler, emitAsync } = await registerHandler({
      getTurnsByAgent: vi.fn().mockResolvedValue([
        { id: 'turn-newer', conversationId: 'conversation-1', startedAt: 2_000 },
        { id: 'turn-target', conversationId: 'conversation-1', startedAt: 1_000 },
      ]),
      getMessage: vi.fn().mockResolvedValue({
        id: 'message-target',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        turnId: 'turn-target',
      }),
      getTurn: vi.fn().mockResolvedValue({
        id: 'turn-target',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
      }),
    });

    const result = await invoke(handler, {
      conversationId: 'conversation-1',
      messageId: 'message-target',
      type: 'thumbs_up',
    });

    expect(result).toMatchObject({
      statusCode: 201,
      responseBody: { turnId: 'turn-target' },
    });
    expect(emitAsync).toHaveBeenCalledWith('feedback.received', expect.objectContaining({
      turnId: 'turn-target',
      messageId: 'message-target',
    }));
  });

  it('carries the comment through to the feedback.received event', async () => {
    const { handler, emitAsync } = await registerHandler({
      getMessage: vi.fn().mockResolvedValue({
        id: 'message-target',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        turnId: 'turn-target',
      }),
      getTurn: vi.fn().mockResolvedValue({
        id: 'turn-target',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
      }),
    });

    const result = await invoke(handler, {
      conversationId: 'conversation-1',
      messageId: 'message-target',
      type: 'thumbs_down',
      comment: '  The reserve figure cites the wrong policy year.  ',
    });

    expect(result).toMatchObject({ statusCode: 201 });
    expect(emitAsync).toHaveBeenCalledWith('feedback.received', expect.objectContaining({
      comment: 'The reserve figure cites the wrong policy year.',
    }));
  });

  it('omits comment from the event when absent or blank', async () => {
    const { handler, emitAsync } = await registerHandler({
      getMessage: vi.fn().mockResolvedValue({
        id: 'message-target',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        turnId: 'turn-target',
      }),
      getTurn: vi.fn().mockResolvedValue({
        id: 'turn-target',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
      }),
    });

    const result = await invoke(handler, {
      conversationId: 'conversation-1',
      messageId: 'message-target',
      type: 'thumbs_up',
      comment: '   ',
    });

    expect(result).toMatchObject({ statusCode: 201 });
    const payload = emitAsync.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('comment');
  });

  it('rejects a non-string comment', async () => {
    const { handler } = await registerHandler({});

    const result = await invoke(handler, {
      conversationId: 'conversation-1',
      messageId: 'message-target',
      type: 'thumbs_up',
      comment: { nested: true },
    });

    expect(result).toEqual({
      statusCode: 400,
      responseBody: { error: 'comment must be a string' },
    });
  });

  it('rejects an oversized comment', async () => {
    const { handler } = await registerHandler({});

    const result = await invoke(handler, {
      conversationId: 'conversation-1',
      messageId: 'message-target',
      type: 'thumbs_up',
      comment: 'x'.repeat(4001),
    });

    expect(result).toEqual({
      statusCode: 400,
      responseBody: { error: 'comment must be at most 4000 characters' },
    });
  });

  it('requires messageId', async () => {
    const { handler } = await registerHandler({
      getTurnsByAgent: vi.fn().mockResolvedValue([
        { id: 'turn-newer', conversationId: 'conversation-1', startedAt: 2_000 },
      ]),
    });

    const result = await invoke(handler, {
      conversationId: 'conversation-1',
      type: 'thumbs_down',
    });

    expect(result).toEqual({
      statusCode: 400,
      responseBody: {
        error: 'conversationId, messageId, and type ("thumbs_up" or "thumbs_down") are required',
      },
    });
  });
});
