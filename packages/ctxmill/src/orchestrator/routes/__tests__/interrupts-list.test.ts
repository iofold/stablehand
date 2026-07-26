import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { interruptRoutes } from '../interrupts.js';

function createInterruptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'interrupt-1',
    turnId: 'turn-1',
    agentId: 'agent-1',
    sandboxSessionId: 'session-1',
    toolCallId: 'tool-call-1',
    toolName: 'request-approval',
    args: { reason: 'publish' },
    timeoutMs: 300_000,
    createdAt: 100,
    expiresAt: 400,
    resolvedAt: null,
    resolvedAction: null,
    resolvedData: { must: 'not leak' },
    status: 'pending',
    ...overrides,
  };
}

describe('global interrupt listing route', () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    vi.clearAllMocks();
  });

  async function buildApp(rows = [createInterruptRow(), createInterruptRow({
    id: 'interrupt-2',
    createdAt: 90,
  })]) {
    const db = {
      listInterrupts: vi.fn().mockResolvedValue({
        interrupts: rows,
        hasMore: rows.length === 200,
      }),
    };
    const app = Fastify({ logger: false });
    await app.register(interruptRoutes, {
      prefix: '/api/interrupts',
      db: db as never,
    });
    await app.ready();
    apps.push(app);
    return { app, db };
  }

  it('forwards status and agent filters and omits resolved data', async () => {
    const { app, db } = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/interrupts?status=resolved&agentId=agent-1',
    });

    expect(response.statusCode).toBe(200);
    expect(db.listInterrupts).toHaveBeenCalledWith({
      status: 'resolved',
      agentId: 'agent-1',
      limit: 50,
      before: undefined,
    });
    expect(response.json()).toEqual({
      interrupts: [
        expect.not.objectContaining({ resolvedData: expect.anything() }),
        expect.not.objectContaining({ resolvedData: expect.anything() }),
      ],
    });
  });

  it('clamps the limit and uses createdAt as the pagination cursor', async () => {
    const rows = Array.from({ length: 200 }, (_, index) => createInterruptRow({
      id: `interrupt-${index}`,
      createdAt: 500 - index,
    }));
    const { app, db } = await buildApp(rows);
    const response = await app.inject({
      method: 'GET',
      url: '/api/interrupts?status=all&limit=999&before=1000',
    });

    expect(response.statusCode).toBe(200);
    expect(db.listInterrupts).toHaveBeenCalledWith({
      status: 'all',
      agentId: undefined,
      limit: 200,
      before: 1000,
    });
    expect(response.json().interrupts).toHaveLength(200);
    expect(response.json().nextBefore).toBe(301);
  });

  it('rejects unsupported status and invalid cursor values', async () => {
    const { app, db } = await buildApp();

    const invalidStatus = await app.inject({
      method: 'GET',
      url: '/api/interrupts?status=unknown',
    });
    const invalidCursor = await app.inject({
      method: 'GET',
      url: '/api/interrupts?before=not-a-number',
    });

    expect(invalidStatus.statusCode).toBe(400);
    expect(invalidCursor.statusCode).toBe(400);
    expect(db.listInterrupts).not.toHaveBeenCalled();
  });
});
