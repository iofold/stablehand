import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { triggerConversationId } from '../../packages/stablehand/src/config/container.js';
import type { PreparedTurnStart } from '../../packages/stablehand/src/orchestrator/turn-startup-service.js';
import { TurnFinalizer } from '../../packages/stablehand/src/orchestrator/turn-finalizer.js';
import { createTestApp, type TestAppHandle } from '../utils/test-app.js';
import { createTestDb } from '../utils/test-db.js';

/**
 * The folder review example seeds against a real orchestrator and runs its
 * start-then-ask flow through POST /api/triggers/emit. Only the sandbox
 * harness is faked. A review and its follow-up questions share one
 * conversation; another review gets its own.
 */

const execFileAsync = promisify(execFile);
const EXAMPLE = fileURLToPath(new URL('../../packages/examples/folder-review/', import.meta.url));
const WORKSPACE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface LaunchedRun {
  turnId: string;
  conversationId: string;
  mode: PreparedTurnStart['mode'];
  task: string;
}

describe('folder review', () => {
  let testApp: TestAppHandle | undefined;
  const launches: LaunchedRun[] = [];

  async function resetDatabase(): Promise<void> {
    const reset = await createTestDb();
    await reset.close();
  }

  beforeAll(async () => {
    await resetDatabase();
    testApp = await createTestApp({ dirPrefix: 'stablehand-folder-review-' });
    await testApp.app.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    try {
      await testApp?.close();
    } finally {
      await resetDatabase();
    }
  });

  async function runScript(script: string, args: string[], env: Record<string, string> = {}): Promise<string> {
    const { port } = testApp!.app.server.address() as AddressInfo;
    const childEnv: NodeJS.ProcessEnv = { ...process.env, API_URL: `http://127.0.0.1:${port}` };
    delete childEnv.RUN_NOW;
    Object.assign(childEnv, env);
    const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', `${EXAMPLE}${script}`, ...args], {
      cwd: WORKSPACE_ROOT,
      env: childEnv,
      timeout: 90_000,
    });
    return stdout;
  }

  async function reviewAgent(): Promise<{ id: string; mode: string | null; tools: string[]; metadata: Record<string, unknown> | null }> {
    const agents = (await testApp!.app.inject({ method: 'GET', url: '/api/agents' }))
      .json<Array<{ id: string; name: string; mode: string | null; tools: string[]; metadata: Record<string, unknown> | null }>>();
    const agent = agents.find((candidate) => candidate.name === 'folder-review');
    if (!agent) throw new Error('folder-review was not seeded');
    return agent;
  }

  it('seeds the agent with the folder in its workspace, two thread-keyed triggers and a budget', async () => {
    const first = await runScript('seed.ts', []);
    expect(first).toContain('created folder-review');
    expect(first).toContain('workspace: 10 documents in folder/');
    expect(first).toContain('custom.review.start -> folder-review, one conversation per {{payload.reviewId}}');
    expect(first).toContain('custom.review.question -> folder-review, one conversation per {{payload.reviewId}}');
    expect(await runScript('seed.ts', [])).toContain('updated folder-review');

    const { app } = testApp!;
    const agent = await reviewAgent();
    expect(agent.mode).toBe('both');
    expect(agent.tools).toEqual(['artifact_upload']);
    expect(agent.metadata).toMatchObject({ defaultTags: { campaign: 'folder-review' } });

    const folder = (await app.inject({ method: 'GET', url: `/api/agents/${agent.id}/files?path=folder` }))
      .json<{ entries: Array<{ name: string; sizeBytes: number }> }>().entries;
    expect(folder.map((entry) => entry.name).sort()).toEqual([
      'ampelfield-price-notice.md',
      'ampelfield-supply-agreement.pdf',
      'brindlewood-nda.md',
      'cirrolake-order-form.md',
      'quaywise-amendment-1.pdf',
      'quaywise-dpa.pdf',
      'quaywise-insurance-certificate.pdf',
      'quaywise-msa.pdf',
      'tallowpay-merchant-terms.md',
      'vendor-policy.md',
    ]);
    expect(folder.every((entry) => entry.sizeBytes > 0)).toBe(true);
    const tools = (await app.inject({ method: 'GET', url: `/api/agents/${agent.id}/files?path=tools` }))
      .json<{ entries: Array<{ name: string }> }>().entries;
    expect(tools.map((entry) => entry.name).sort()).toEqual(['check_findings.mjs', 'read_folder.py']);

    const triggers = (await app.inject({ method: 'GET', url: `/api/triggers?agentId=${agent.id}` }))
      .json<Array<{ eventType: string; conversationKey?: string }>>();
    expect(triggers.map((trigger) => [trigger.eventType, trigger.conversationKey]).sort()).toEqual([
      ['custom.review.question', '{{payload.reviewId}}'],
      ['custom.review.start', '{{payload.reviewId}}'],
    ]);

    const budgets = (await app.inject({ method: 'GET', url: '/api/budgets' }))
      .json<{ policies: Array<{ name: string; doc: { selector: Record<string, string>; limits: Record<string, number> } }> }>().policies;
    expect(budgets).toEqual([expect.objectContaining({
      name: 'folder-review weekly budget',
      doc: expect.objectContaining({ selector: { campaign: 'folder-review' }, limits: { costUsd: 3, turns: 30 } }),
    })]);
  }, 180_000);

  it('runs a review and its follow-up questions in one conversation, and another review in its own', async () => {
    const { container } = testApp!;
    const agent = await reviewAgent();
    const finalizer = new TurnFinalizer({ db: container.db, eventBus: container.eventBus });
    vi.spyOn(container.turnStartupService, 'launchPreparedTurn').mockImplementation(async (start, agentId, options) => {
      if (agentId !== agent.id || launches.some((launch) => launch.turnId === start.turnId)) return;
      launches.push({ turnId: start.turnId, conversationId: start.conversationId, mode: start.mode, task: start.taskDescription });
      await finalizer.finalize({ turnId: start.turnId, agentId, conversationId: start.conversationId, status: 'completed' });
      options?.onSuccess?.();
    });

    expect(await runScript('seed.ts', [], { RUN_NOW: '1' })).toContain('Started review fernway-vendor-binder.');
    await vi.waitFor(() => expect(launches).toHaveLength(1), { timeout: 30_000, interval: 50 });
    expect(await runScript('review.ts', ['ask', 'Which contracts renew on their own?'])).toContain('Asked about review fernway-vendor-binder.');
    await vi.waitFor(() => expect(launches).toHaveLength(2), { timeout: 30_000, interval: 50 });
    await runScript('review.ts', ['start', '--review', 'q4-binder', 'Only the courier documents.']);
    await vi.waitFor(() => expect(launches).toHaveLength(3), { timeout: 30_000, interval: 50 });

    const [review, question, other] = launches;
    expect(review!.task).toMatch(/^Review the folder\. Review id: fernway-vendor-binder\. Today is \d{4}-\d{2}-\d{2}\.\n\nCheck every contract/);
    expect(question!.task).toMatch(/^Question about review fernway-vendor-binder \(today is \d{4}-\d{2}-\d{2}\): Which contracts renew on their own\?$/);
    expect(other!.task).toContain('Review id: q4-binder.');
    expect(other!.task).toContain('Only the courier documents.');

    expect(review!.conversationId).toBe(triggerConversationId(agent.id, 'fernway-vendor-binder'));
    expect(question!.conversationId).toBe(review!.conversationId);
    expect(other!.conversationId).toBe(triggerConversationId(agent.id, 'q4-binder'));
    expect(launches.every((launch) => launch.mode === 'background')).toBe(true);

    const messages = await container.db.getMessages(review!.conversationId);
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(2);
    const turns = (await testApp!.app.inject({ method: 'GET', url: `/api/agents/${agent.id}/turns` }))
      .json<{ turns: Array<{ status: string; tags?: Record<string, string> | null }> }>().turns;
    expect(turns).toHaveLength(3);
    for (const turn of turns) {
      expect(turn.status).toBe('COMPLETED');
      expect(turn.tags).toMatchObject({ campaign: 'folder-review' });
    }
  }, 120_000);
});
