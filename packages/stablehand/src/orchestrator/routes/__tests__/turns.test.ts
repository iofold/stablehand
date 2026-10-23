import { createHash } from 'node:crypto';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerApiAuth, type ApiKeyPrincipal, type ApiKeyStore } from '../../auth.js';
import { turnRoutes } from '../turns.js';

const MASTER_TOKEN = 'master-token';
const READER_TOKEN = `cmk_${'r'.repeat(43)}`;
const BOUND_TOKEN = `cmk_${'b'.repeat(43)}`;
const EVENTS_TOKEN = `cmk_${'e'.repeat(43)}`;
const sha = (token: string) => createHash('sha256').update(token).digest('hex');
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const principals = new Map<string, ApiKeyPrincipal>([
  [sha(READER_TOKEN), { keyId: 'key_reader', name: 'reader', capabilities: ['agents:read'], agentId: null }],
  [sha(BOUND_TOKEN), { keyId: 'key_bound', name: 'bound', capabilities: ['agents:read'], agentId: 'agent-B' }],
  [sha(EVENTS_TOKEN), { keyId: 'key_events', name: 'events', capabilities: ['events:read'], agentId: null }],
]);
const keyStore: ApiKeyStore = {
  findLiveKeyByTokenHash: async (hash) => principals.get(hash) ?? null,
  isLiveKey: async () => true,
  touchLastUsed: async () => {},
};

function turnRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'turn-1',
    agentId: 'agent-A',
    conversationId: 'conv-1',
    sandboxSessionId: 'sbx-1',
    status: 'completed',
    mode: 'background',
    taskDescription: 'Scout',
    queuedAt: 5_000,
    startedAt: 5_000,
    completedAt: 6_000,
    error: null,
    tags: { campaign: 'bugfarm-1', agent: 'agent-A', harness: 'pi', mode: 'background' },
    gatewayMode: null,
    ...overrides,
  };
}

async function buildApp(rows = [turnRow(), turnRow({ id: 'turn-0', queuedAt: 4_000, sandboxSessionId: null })]) {
  const db = {
    searchTurns: vi.fn().mockResolvedValue({ turns: rows, hasMore: true }),
    getTurn: vi.fn(async (id: string) => rows.find((row) => row.id === id)),
    getSandboxSessionsByIds: vi.fn().mockResolvedValue([
      { id: 'sbx-1', status: 'TERMINATED', restoreAttempts: 0, lastRestoreError: null, updatedAt: 6_000 },
    ]),
  };
  const app = Fastify({ logger: false });
  registerApiAuth(app, { mode: 'enforce', token: MASTER_TOKEN }, keyStore);
  await app.register(turnRoutes, { prefix: '/api/turns', db: db as never });
  await app.ready();
  return { app, db };
}

describe('cross-agent turn routes (ctx-89id)', () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>['app']> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });
  const open = async (...args: Parameters<typeof buildApp>) => {
    const built = await buildApp(...args);
    apps.push(built.app);
    return built;
  };

  it('parses tag, status, limit and cursor and hands back an opaque next cursor', async () => {
    const { app, db } = await open();
    const first = await app.inject({
      method: 'GET',
      url: '/api/turns?tag=campaign:bugfarm-1&tag=repo:a:b&status=completed,ERROR&limit=999',
      headers: auth(MASTER_TOKEN),
    });

    expect(first.statusCode).toBe(200);
    expect(db.searchTurns).toHaveBeenLastCalledWith({
      tags: { campaign: 'bugfarm-1', repo: 'a:b' },
      statuses: ['COMPLETED', 'ERROR'],
      limit: 200,
    });
    const body = first.json();
    expect(body.turns.map((turn: { id: string }) => turn.id)).toEqual(['turn-1', 'turn-0']);
    expect(body.turns[0]).toMatchObject({ sandboxStatus: 'TERMINATED', status: 'COMPLETED' });
    expect(db.getSandboxSessionsByIds).toHaveBeenCalledWith(['sbx-1']);
    expect(typeof body.nextCursor).toBe('string');

    await app.inject({
      method: 'GET',
      url: `/api/turns?cursor=${encodeURIComponent(body.nextCursor)}`,
      headers: auth(MASTER_TOKEN),
    });
    expect(db.searchTurns).toHaveBeenLastCalledWith({
      limit: 50,
      after: { queuedAt: 4_000, id: 'turn-0' },
    });
  });

  it('serves keys with agents:read and refuses keys without it', async () => {
    const { app } = await open();
    const reader = await app.inject({ method: 'GET', url: '/api/turns', headers: auth(READER_TOKEN) });
    expect(reader.statusCode).toBe(200);

    const events = await app.inject({ method: 'GET', url: '/api/turns', headers: auth(EVENTS_TOKEN) });
    expect(events.statusCode).toBe(403);
    expect(events.json().requiredCapability).toBe('agents:read');

    const lookup = await app.inject({ method: 'GET', url: '/api/turns/turn-1', headers: auth(EVENTS_TOKEN) });
    expect(lookup.statusCode).toBe(403);
  });

  it('pins a key bound to one agent to that agent', async () => {
    const { app, db } = await open();
    await app.inject({ method: 'GET', url: '/api/turns?tag=campaign:bugfarm-1', headers: auth(BOUND_TOKEN) });
    expect(db.searchTurns).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: 'agent-B' }));

    const elsewhere = await app.inject({
      method: 'GET',
      url: '/api/turns?agentId=agent-A',
      headers: auth(BOUND_TOKEN),
    });
    expect(elsewhere.json()).toEqual({ turns: [] });
    expect(db.searchTurns).toHaveBeenCalledTimes(1);

    const hidden = await app.inject({ method: 'GET', url: '/api/turns/turn-1', headers: auth(BOUND_TOKEN) });
    expect(hidden.statusCode).toBe(404);
  });

  it('returns one turn by id with its sandbox status', async () => {
    const { app } = await open();
    const response = await app.inject({ method: 'GET', url: '/api/turns/turn-1', headers: auth(READER_TOKEN) });
    expect(response.statusCode).toBe(200);
    expect(response.json().turn).toMatchObject({
      id: 'turn-1',
      agentId: 'agent-A',
      status: 'COMPLETED',
      sandboxStatus: 'TERMINATED',
      tags: { campaign: 'bugfarm-1' },
    });
  });
});
