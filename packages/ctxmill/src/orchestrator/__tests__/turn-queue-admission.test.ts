import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { createTurnQueueAdmission, QueueFullError } from '../turn-queue-admission.js';
import { sendTurnStartError } from '../turn-start-errors.js';

function admission(counts: { global: number; agent: number }, limits = { maxQueuedTurnsGlobal: 1000, maxQueuedTurnsPerAgent: 100 }) {
  return createTurnQueueAdmission({
    db: { countQueuedTurns: async () => counts },
    settings: async () => limits,
  });
}

describe('turn queue admission (ctx-z5k0)', () => {
  it('admits under both caps', async () => {
    await expect(admission({ global: 999, agent: 99 }).check('agent-1')).resolves.toBeUndefined();
  });

  it('rejects at the global cap with scope=global', async () => {
    const err = await admission({ global: 1000, agent: 5 }).check('agent-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueueFullError);
    expect((err as QueueFullError).scope).toBe('global');
    expect((err as QueueFullError).statusCode).toBe(429);
  });

  it('rejects at the per-agent cap with scope=agent', async () => {
    const err = await admission({ global: 500, agent: 100 }).check('agent-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueueFullError);
    expect((err as QueueFullError).scope).toBe('agent');
    expect((err as QueueFullError).agentId).toBe('agent-1');
  });

  it('honors live limit values from settings', async () => {
    const gate = admission({ global: 3, agent: 3 }, { maxQueuedTurnsGlobal: 10, maxQueuedTurnsPerAgent: 3 });
    const err = await gate.check('agent-1').catch((e: unknown) => e);
    expect((err as QueueFullError).scope).toBe('agent');
    expect((err as QueueFullError).limit).toBe(3);
  });

  it('maps to a typed 429 with Retry-After via sendTurnStartError', async () => {
    const app = Fastify({ logger: false });
    app.post('/turn', async (_request, reply) => {
      try {
        await admission({ global: 1000, agent: 0 }).check('agent-1');
        return { ok: true };
      } catch (err) {
        if (sendTurnStartError(reply, err)) return reply;
        throw err;
      }
    });
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/turn' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.json()).toMatchObject({
      code: 'queue_full',
      scope: 'global',
      queued: 1000,
      limit: 1000,
      retryAfterSec: 5,
    });
    await app.close();
  });
});
