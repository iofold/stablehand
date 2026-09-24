import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  API_KEY_TOKEN_PATTERN,
  ApiKeyCreatedSchema,
  ApiKeyListResponseSchema,
} from '@stablehand/contracts';

import { apiKeyRoutes } from '../keys.js';
import type { ApiKeyRow } from '../../../database/types.js';

class FakeKeyDb {
  rows: ApiKeyRow[] = [];
  private counter = 0;

  createApiKey = async (data: {
    name: string;
    tokenHash: string;
    capabilities: string[];
    note?: string | null;
    createdBy?: string | null;
    expiresAt?: number | null;
  }): Promise<ApiKeyRow> => {
    if (this.rows.some((row) => row.name === data.name)) {
      const err = new Error('duplicate key value violates unique constraint') as Error & { code: string };
      err.code = '23505';
      throw err;
    }
    this.counter += 1;
    const row: ApiKeyRow = {
      id: `key_${this.counter}`,
      name: data.name,
      tokenHash: data.tokenHash,
      capabilities: data.capabilities,
      note: data.note ?? null,
      createdAt: 1000 + this.counter,
      createdBy: data.createdBy ?? null,
      expiresAt: data.expiresAt ?? null,
      lastUsedAt: null,
      revokedAt: null,
    };
    this.rows.push(row);
    return row;
  };

  listApiKeys = async (): Promise<ApiKeyRow[]> => this.rows;

  getApiKey = async (id: string): Promise<ApiKeyRow | undefined> =>
    this.rows.find((row) => row.id === id);

  revokeApiKey = async (id: string): Promise<ApiKeyRow | undefined> => {
    const row = this.rows.find((r) => r.id === id);
    if (row && row.revokedAt === null) row.revokedAt = 2000;
    return row;
  };
}

async function createApp(db: FakeKeyDb) {
  const app = Fastify({ logger: false });
  await app.register(apiKeyRoutes, { prefix: '/api/keys', db });
  await app.ready();
  return app;
}

describe('api key routes', () => {
  const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('creates a key, returning the token exactly once and never the hash', async () => {
    const db = new FakeKeyDb();
    const app = await createApp(db);
    apps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/keys',
      payload: {
        name: 'ext-evals',
        capabilities: ['events:read', 'triggers:emit:custom.eval.*'],
        note: 'evals extension',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(ApiKeyCreatedSchema.parse(body)).toEqual(body);
    expect(body.token).toMatch(API_KEY_TOKEN_PATTERN);
    expect(body).not.toHaveProperty('tokenHash');
    expect(body.createdBy).toBe('master');
    expect(db.rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.rows[0]!.tokenHash).not.toContain(body.token);

    const list = await app.inject({ method: 'GET', url: '/api/keys' });
    expect(list.statusCode).toBe(200);
    const listed = ApiKeyListResponseSchema.parse(list.json());
    expect(listed.keys).toHaveLength(1);
    expect(listed.keys[0]?.status).toBe('active');
    expect(listed.keys[0]).not.toHaveProperty('token');
    expect(listed.keys[0]).not.toHaveProperty('tokenHash');
  });

  it('rejects invalid capabilities with a 400 naming the issue', async () => {
    const app = await createApp(new FakeKeyDb());
    apps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/keys',
      payload: { name: 'ext-bad', capabilities: ['secrets:read'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Invalid api key request/);
  });

  it('returns 409 on duplicate names', async () => {
    const db = new FakeKeyDb();
    const app = await createApp(db);
    apps.push(app);

    const payload = { name: 'ext-dup', capabilities: ['events:read'] };
    expect((await app.inject({ method: 'POST', url: '/api/keys', payload })).statusCode).toBe(201);
    const dup = await app.inject({ method: 'POST', url: '/api/keys', payload });
    expect(dup.statusCode).toBe(409);
  });

  it.each([
    [
      'duplicate capabilities',
      { name: 'ext-duplicate-cap', capabilities: ['events:read', 'events:read'] },
    ],
    [
      'an expiry in the past',
      { name: 'ext-past-expiry', capabilities: ['events:read'], expiresAt: Date.now() - 1 },
    ],
  ])('rejects %s before creating a key', async (_caseName, payload) => {
    const db = new FakeKeyDb();
    const app = await createApp(db);
    apps.push(app);

    const res = await app.inject({ method: 'POST', url: '/api/keys', payload });

    expect(res.statusCode).toBe(400);
    expect(db.rows).toEqual([]);
  });

  it('computes active, expired, and revoked status in list responses', async () => {
    const db = new FakeKeyDb();
    const app = await createApp(db);
    apps.push(app);
    const future = Date.now() + 60_000;
    for (const [name, expiresAt] of [
      ['ext-active', future],
      ['ext-expired', future],
      ['ext-revoked', future],
    ] as const) {
      await app.inject({
        method: 'POST',
        url: '/api/keys',
        payload: { name, capabilities: ['events:read'], expiresAt },
      });
    }
    db.rows[1]!.expiresAt = Date.now() - 1;
    db.rows[2]!.revokedAt = Date.now();

    const res = await app.inject({ method: 'GET', url: '/api/keys' });
    const keys = ApiKeyListResponseSchema.parse(res.json()).keys;

    expect(keys.map(({ name, status }) => [name, status])).toEqual([
      ['ext-active', 'active'],
      ['ext-expired', 'expired'],
      ['ext-revoked', 'revoked'],
    ]);
  });

  it('revokes idempotently and 404s unknown ids', async () => {
    const db = new FakeKeyDb();
    const app = await createApp(db);
    apps.push(app);

    await app.inject({
      method: 'POST',
      url: '/api/keys',
      payload: { name: 'ext-revoke', capabilities: ['events:read'] },
    });

    const revoked = await app.inject({ method: 'DELETE', url: '/api/keys/key_1' });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().revokedAt).toBe(2000);

    const again = await app.inject({ method: 'DELETE', url: '/api/keys/key_1' });
    expect(again.statusCode).toBe(200);
    expect(again.json().revokedAt).toBe(2000);

    const missing = await app.inject({ method: 'DELETE', url: '/api/keys/key_404' });
    expect(missing.statusCode).toBe(404);
  });

  it('generates distinct tokens across keys', async () => {
    const db = new FakeKeyDb();
    const app = await createApp(db);
    apps.push(app);

    const tokens = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/keys',
        payload: { name: `ext-${i}`, capabilities: ['events:read'] },
      });
      tokens.add(res.json().token);
    }
    expect(tokens.size).toBe(5);
  });
});
