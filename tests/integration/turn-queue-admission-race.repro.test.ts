import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTurnQueueAdmission,
  QueueFullError,
} from '../../packages/stablehand/src/orchestrator/turn-queue-admission.js';
import { QueueCapExceededError } from '../../packages/stablehand/src/database/repository.js';
import { TurnSecretEnvelopeCodec } from '../../packages/stablehand/src/orchestrator/turn-secret-envelope.js';
import { createTestDb, type TestDb } from '../utils/test-db.js';

/**
 * ctx-xrrc: the durable queue cap (ctx-z5k0) was a read-then-insert with
 * nothing serializing the gap — a concurrent burst all read the depth before
 * any sibling's row landed, so all were admitted (dev2: 8 submissions past a
 * cap of 2). The fix makes the cap authoritative by counting and inserting the
 * queued turn under one xact-scoped advisory lock inside
 * createTurnWithSecretEnvelope; the pre-insert admission.check stays as the
 * cheap fast path. These tests drive the REAL admit-then-atomic-insert path
 * over Postgres. Both are green post-fix; the concurrent case was red before.
 */

const CODEC = new TurnSecretEnvelopeCodec(Buffer.alloc(32, 5));
const PER_AGENT_CAP = 2;
const BURST = 8;

describe('ctx-xrrc turn queue cap admission race', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb?.close();
  });

  async function createAgentUnderCap(name: string) {
    const agent = await testDb.repo.createAgent({
      name,
      harness: 'claude-agents',
      harnessConfig: JSON.stringify({ model: 'claude-sonnet-4-6' }),
      systemPrompt: 'Test durable queue admission.',
      tools: [],
    });
    const conversation = await testDb.repo.createConversation(agent.id);
    const limits = { maxQueuedTurnsGlobal: 1000, maxQueuedTurnsPerAgent: PER_AGENT_CAP };
    const admission = createTurnQueueAdmission({
      db: testDb.repo,
      settings: async () => limits,
    });

    /** Production order: fast-path admit, then durably enqueue under the
     * authoritative in-transaction cap. */
    const submit = async (): Promise<'accepted' | 'queue_full'> => {
      try {
        await admission.check(agent.id);
      } catch (err) {
        if (err instanceof QueueFullError) return 'queue_full';
        throw err;
      }
      const id = randomUUID();
      try {
        await testDb.repo.createTurnWithSecretEnvelope(
          {
            id,
            agentId: agent.id,
            conversationId: conversation.id,
            mode: 'interactive',
            status: 'queued',
          },
          CODEC.seal(id, {}),
          limits,
        );
        return 'accepted';
      } catch (err) {
        if (err instanceof QueueCapExceededError) return 'queue_full';
        throw err;
      }
    };

    const queuedRowCount = async (): Promise<number> => {
      const rows = await testDb.conn.pgClient<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM turns
        WHERE agent_id = ${agent.id} AND status = 'queued' AND completed_at IS NULL
      `;
      return rows[0].count;
    };

    return { agent, submit, queuedRowCount };
  }

  it('enforces the per-agent cap exactly under sequential submission', async () => {
    const { submit, queuedRowCount } = await createAgentUnderCap('Queue Cap Sequential Agent');

    const outcomes: string[] = [];
    for (let i = 0; i < BURST; i++) {
      outcomes.push(await submit());
    }

    expect(outcomes.filter((o) => o === 'accepted')).toHaveLength(PER_AGENT_CAP);
    expect(await queuedRowCount()).toBe(PER_AGENT_CAP);
  });

  it('never admits more queued turns than the cap under concurrent submission', async () => {
    const { submit, queuedRowCount } = await createAgentUnderCap('Queue Cap Concurrent Agent');

    const outcomes = await Promise.all(
      Array.from({ length: BURST }, () => submit()),
    );
    const accepted = outcomes.filter((o) => o === 'accepted').length;

    expect(
      accepted,
      `admitted ${accepted} concurrent submissions against a cap of ${PER_AGENT_CAP}`,
    ).toBeLessThanOrEqual(PER_AGENT_CAP);
    expect(await queuedRowCount()).toBeLessThanOrEqual(PER_AGENT_CAP);
  });
});
