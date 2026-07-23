import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { triggerRoutes } from '../triggers.js';

type UpdateHandler = (
  request: FastifyRequest<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>,
  reply: FastifyReply,
) => Promise<unknown>;

async function registerUpdateHandler(update: ReturnType<typeof vi.fn>) {
  let handler: UpdateHandler | undefined;
  const app = {
    post: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    put: vi.fn((path: string, registered: UpdateHandler) => {
      if (path === '/:id') handler = registered;
    }),
  } as unknown as FastifyInstance;
  await triggerRoutes(app, {
    triggerManager: { update } as never,
    db: {} as never,
  });
  if (!handler) throw new Error('trigger update route handler was not registered');
  return handler;
}

async function invoke(handler: UpdateHandler, body: Record<string, unknown>) {
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
  const result = await handler({
    params: { id: 'trigger-1' },
    body,
  } as FastifyRequest<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>, reply);
  return { result, statusCode, responseBody };
}

describe('trigger update route selector contract', () => {
  it('uses explicit null to clear a selector', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'trigger-1', selector: undefined });
    const handler = await registerUpdateHandler(update);

    const response = await invoke(handler, { selector: null });

    expect(response.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith('trigger-1', { selector: undefined });
  });

  it.each([
    ['array', []],
    ['string', 'invoice'],
    ['number', 42],
  ])('rejects a selector %s', async (_label, selector) => {
    const update = vi.fn();
    const handler = await registerUpdateHandler(update);

    const response = await invoke(handler, { selector });

    expect(response).toMatchObject({
      statusCode: 400,
      responseBody: { error: 'selector must be a JSON object or null' },
    });
    expect(update).not.toHaveBeenCalled();
  });
});
