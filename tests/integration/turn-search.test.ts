/**
 * ctx-89id — find turns by tag across agents, page through them, and look a
 * turn up by id. Real server and Postgres (jsonb containment, status
 * projection, keyset paging). Scoped-key rules are covered by the route test
 * in packages/stablehand/src/orchestrator/routes/__tests__/turns.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TurnSearchResponseSchema, type TurnSearchResponse } from '@stablehand/contracts';

import { createTestApp, type TestAppHandle } from '../utils/test-app.js';

describe('GET /api/turns (ctx-89id)', () => {
  let testApp: TestAppHandle | undefined;
  let app: TestAppHandle['app'];
  let scoutId: string;
  let builderId: string;
  const suffix = Date.now().toString(36);
  const campaign = `bugfarm-${suffix}`;

  beforeAll(async () => {
    testApp = await createTestApp({ dirPrefix: 'stablehand-turn-search-' });
    app = testApp.app;
    const repo = testApp.container.db;

    const createAgent = async (name: string) => (await repo.createAgent({
      name,
      harness: 'langgraph',
      harnessConfig: '{}',
      systemPrompt: 'test',
      tools: [],
    })).id;
    scoutId = await createAgent(`scout-${suffix}`);
    builderId = await createAgent(`env-builder-${suffix}`);

    // Six campaign turns across two agents plus one from another campaign.
    // s2 and s3 share queuedAt to exercise the id tie-break in the cursor.
    const seed = async (
      key: string,
      agentId: string,
      queuedAt: number,
      tags: Record<string, string>,
      state: { status: 'queued' | 'running' | 'completed' | 'error'; completedAt?: number; error?: string },
    ) => {
      const conversation = await repo.createConversation(agentId);
      await repo.createTurn({
        id: id(key),
        agentId,
        conversationId: conversation.id,
        mode: 'background',
        queuedAt,
        startedAt: queuedAt,
        tags: { ...tags, agent: agentId, harness: 'langgraph', mode: 'background' },
        ...state,
      });
    };
    await seed('s1', scoutId, 1_000, { campaign, batch: '1' }, { status: 'completed', completedAt: 1_100 });
    await seed('b1', builderId, 2_000, { campaign, batch: '1' }, { status: 'completed', completedAt: 2_100 });
    await seed('b2', builderId, 3_000, { campaign, batch: '2' }, { status: 'error', completedAt: 3_100, error: 'boom' });
    await seed('b3', builderId, 4_000, { campaign, batch: '2' }, { status: 'error', completedAt: 4_100, error: 'Turn cancelled' });
    await seed('s2', scoutId, 5_000, { campaign, batch: '2' }, { status: 'running' });
    await seed('s3', scoutId, 5_000, { campaign, batch: '3' }, { status: 'queued' });
    await seed('x1', scoutId, 6_000, { campaign: `other-${suffix}` }, { status: 'completed', completedAt: 6_100 });
  });

  afterAll(async () => {
    await testApp?.close();
  });

  function id(key: string): string {
    return `turn-${suffix}-${key}`;
  }

  async function list(query: string): Promise<{ statusCode: number; body: TurnSearchResponse }> {
    const response = await app.inject({ method: 'GET', url: `/api/turns${query}` });
    return {
      statusCode: response.statusCode,
      body: response.statusCode === 200 ? TurnSearchResponseSchema.parse(response.json()) : response.json(),
    };
  }

  const ids = (body: TurnSearchResponse) => body.turns.map((turn) => turn.id);

  it('finds every turn of a campaign across agents, newest first', async () => {
    const { statusCode, body } = await list(`?tag=campaign:${campaign}`);

    expect(statusCode).toBe(200);
    // s2 and s3 share queuedAt; the id breaks the tie (descending).
    expect(ids(body)).toEqual([id('s3'), id('s2'), id('b3'), id('b2'), id('b1'), id('s1')]);
    expect(body.nextCursor).toBeUndefined();
    expect(body.turns[0]?.tags).toMatchObject({ campaign, batch: '3' });
  });

  it('requires every tag to match', async () => {
    const { body } = await list(`?tag=campaign:${campaign}&tag=batch:2`);
    expect(ids(body)).toEqual([id('s2'), id('b3'), id('b2')]);
  });

  it('filters by the status clients see, including cancelled and failed turns', async () => {
    const terminal = await list(`?tag=campaign:${campaign}&status=COMPLETED,ERROR&status=cancelled`);
    expect(terminal.body.turns.map((turn) => [turn.id, turn.status])).toEqual([
      [id('b3'), 'CANCELLED'],
      [id('b2'), 'ERROR'],
      [id('b1'), 'COMPLETED'],
      [id('s1'), 'COMPLETED'],
    ]);

    const open = await list(`?tag=campaign:${campaign}&status=QUEUED&status=RUNNING`);
    expect(open.body.turns.map((turn) => [turn.id, turn.status])).toEqual([
      [id('s3'), 'QUEUED'],
      [id('s2'), 'RUNNING'],
    ]);
  });

  it('pages with an opaque cursor without skipping or repeating turns', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const { statusCode, body } = await list(
        `?tag=campaign:${campaign}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(statusCode).toBe(200);
      seen.push(...ids(body));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toEqual([id('s3'), id('s2'), id('b3'), id('b2'), id('b1'), id('s1')]);
  });

  it('narrows to one agent when asked', async () => {
    const { body } = await list(`?tag=campaign:${campaign}&agentId=${builderId}`);
    expect(ids(body)).toEqual([id('b3'), id('b2'), id('b1')]);
  });

  it('rejects malformed filters', async () => {
    for (const query of ['?tag=campaign', '?tag=:x', '?tag=campaign:', '?status=DONE', '?limit=0', '?cursor=bogus']) {
      const { statusCode } = await list(query);
      expect(statusCode, query).toBe(400);
    }
    const conflicting = await list('?tag=campaign:a&tag=campaign:b');
    expect(conflicting.statusCode).toBe(400);
  });

  it('looks one turn up by id without knowing its agent', async () => {
    const found = await app.inject({ method: 'GET', url: `/api/turns/${id('b2')}` });
    expect(found.statusCode).toBe(200);
    expect(found.json().turn).toMatchObject({ id: id('b2'), agentId: builderId, status: 'ERROR', error: 'boom' });

    const missing = await app.inject({ method: 'GET', url: `/api/turns/${id('missing')}` });
    expect(missing.statusCode).toBe(404);
  });
});
