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

type EmitHandler = (
  request: FastifyRequest<{
    Body: {
      type: string;
      agentId?: string;
      payload: Record<string, unknown>;
    };
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

async function registerEmitHandler(emitCustomEventAsync: ReturnType<typeof vi.fn>) {
  let handler: EmitHandler | undefined;
  const app = {
    post: vi.fn((path: string, ...args: unknown[]) => {
      if (path !== '/emit') return;
      const registered = args.at(-1);
      if (typeof registered === 'function') handler = registered as EmitHandler;
    }),
    get: vi.fn(),
    delete: vi.fn(),
    put: vi.fn(),
  } as unknown as FastifyInstance;
  await triggerRoutes(app, {
    triggerManager: { emitCustomEventAsync } as never,
    db: {} as never,
  });
  if (!handler) throw new Error('trigger emit route handler was not registered');
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

async function invokeEmit(
  handler: EmitHandler,
  body: { type: string; agentId?: string; payload: Record<string, unknown> },
  apiPrincipal: FastifyRequest['apiPrincipal'],
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
  const result = await handler({ body, apiPrincipal } as FastifyRequest<{
    Body: {
      type: string;
      agentId?: string;
      payload: Record<string, unknown>;
    };
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

describe('trigger emit scoped-key namespace enforcement', () => {
  it('rejects an event outside a parameterized grant before emitting it', async () => {
    const emitCustomEventAsync = vi.fn();
    const handler = await registerEmitHandler(emitCustomEventAsync);

    const response = await invokeEmit(handler, {
      type: 'custom.eval.verdict',
      payload: { verdict: 'pass' },
    }, {
      keyId: 'key_gallery',
      name: 'gallery-extension',
      capabilities: ['triggers:emit:custom.gallery.*'],
    });

    expect(response).toMatchObject({
      statusCode: 403,
      responseBody: {
        error: "Forbidden: this key cannot emit event type 'custom.eval.verdict'",
        required_capability: 'triggers:emit',
      },
    });
    expect(emitCustomEventAsync).not.toHaveBeenCalled();
  });

  it('stamps allowed scoped emits with key provenance outside the payload', async () => {
    const emitCustomEventAsync = vi.fn().mockResolvedValue(undefined);
    const handler = await registerEmitHandler(emitCustomEventAsync);

    const response = await invokeEmit(handler, {
      type: 'custom.gallery.published',
      agentId: 'gallery-agent',
      payload: { artifactId: 'artifact-1' },
    }, {
      keyId: 'key_gallery',
      name: 'gallery-extension',
      capabilities: ['triggers:emit:custom.gallery.*'],
    });

    expect(response.result).toEqual({ ok: true, type: 'custom.gallery.published' });
    expect(emitCustomEventAsync).toHaveBeenCalledWith(
      'custom.gallery.published',
      'gallery-agent',
      { artifactId: 'artifact-1' },
      { keyId: 'key_gallery' },
    );
  });
});
