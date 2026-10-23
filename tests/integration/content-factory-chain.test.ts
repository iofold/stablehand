import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PreparedTurnStart } from '../../packages/stablehand/src/orchestrator/turn-startup-service.js';
import { TurnFinalizer } from '../../packages/stablehand/src/orchestrator/turn-finalizer.js';
import { readSandboxScopeSecrets } from '../../packages/stablehand/src/secrets/scopes.js';
import {
  startNotesServer,
  type NotesServerHandle,
} from '../../packages/examples/content-factory/notes-mcp/server.ts';
import { createTestApp, type TestAppHandle } from '../utils/test-app.js';
import { createTestDb } from '../utils/test-db.js';

/**
 * ctx-pn30: the content factory example seeds against a real orchestrator
 * (Postgres, spine, trigger consumer, schedules, budgets, MCP manager) and
 * its event chain runs end to end. Only the sandbox harness is faked: each
 * admitted run plays its stage by emitting the event the real agent emits.
 */

const execFileAsync = promisify(execFile);
const SEED_PATH = fileURLToPath(new URL('../../packages/examples/content-factory/seed.ts', import.meta.url));
const WORKSPACE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface LaunchedRun {
  agent: string;
  turnId: string;
  mode: PreparedTurnStart['mode'];
  task: string;
}

interface SeededAgent {
  id: string;
  name: string;
  mode: string | null;
  metadata: Record<string, unknown> | null;
  mcpServers?: Array<{ name: string; url: string }>;
  httpTools: Array<{ name: string; endpoint: string; requiresApproval?: boolean }>;
}

describe('content factory', () => {
  let testApp: TestAppHandle | undefined;
  let notes: NotesServerHandle | undefined;
  const previousAllowlist = process.env.STABLEHAND_EGRESS_ALLOWLIST;
  const launches: LaunchedRun[] = [];

  async function resetDatabase(): Promise<void> {
    const reset = await createTestDb();
    await reset.close();
  }

  beforeAll(async () => {
    await resetDatabase();
    process.env.STABLEHAND_EGRESS_ALLOWLIST = '127.0.0.1';
    notes = await startNotesServer({ port: 0, host: '127.0.0.1' });
    testApp = await createTestApp({ dirPrefix: 'stablehand-content-factory-' });
    await testApp.app.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    try {
      await testApp?.close();
      await notes?.close();
    } finally {
      if (previousAllowlist === undefined) delete process.env.STABLEHAND_EGRESS_ALLOWLIST;
      else process.env.STABLEHAND_EGRESS_ALLOWLIST = previousAllowlist;
      await resetDatabase();
    }
  });

  async function runSeed(extraEnv: Record<string, string> = {}): Promise<string> {
    if (!testApp || !notes) throw new Error('not started');
    const { port } = testApp.app.server.address() as AddressInfo;
    const env: NodeJS.ProcessEnv = { ...process.env, API_URL: `http://127.0.0.1:${port}`, NOTES_MCP_URL: notes.url, ...extraEnv };
    delete env.APIFY_TOKEN;
    delete env.TYPEFULLY_API_KEY;
    delete env.TYPEFULLY_SOCIAL_SET_ID;
    Object.assign(env, extraEnv);
    const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', SEED_PATH], {
      cwd: WORKSPACE_ROOT,
      env,
      timeout: 90_000,
    });
    return stdout;
  }

  it('seeds the agents, secrets, capped Apify tools, MCP servers, triggers, schedules and budget, and re-runs in place', async () => {
    const first = await runSeed();
    expect(first).toContain('Seed complete');
    expect(first).toContain('factory-notes-miner/notes: ready, 3 tools');
    expect(first).toContain('APIFY_TOKEN not set');
    expect(first).toContain('approved drafts land as artifacts');

    const { app, container } = testApp!;

    // Installs seeded before the charge cap reach Apify through its MCP
    // server, which runs actors uncapped. Re-seeding must take that route away.
    const seededScout = (await app.inject({ method: 'GET', url: '/api/agents' }))
      .json<Array<SeededAgent & { manifest: { spec: Record<string, unknown> } }>>()
      .find((agent) => agent.name === 'factory-scout')!;
    const legacyManifest = structuredClone(seededScout.manifest);
    legacyManifest.spec.mcpServers = [{
      name: 'apify',
      url: 'https://mcp.apify.com/?tools=harvestapi/linkedin-post-search',
      auth: { type: 'bearer', token: '$secret:APIFY_TOKEN' },
    }];
    const legacy = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${seededScout.id}`,
      payload: { manifest: legacyManifest },
    });
    expect(legacy.statusCode, legacy.body).toBe(200);
    expect(legacy.json<SeededAgent>().mcpServers).toEqual([expect.objectContaining({ name: 'apify' })]);

    const second = await runSeed({
      APIFY_TOKEN: 'apify-test-token',
      TYPEFULLY_API_KEY: 'typefully-test-key',
      TYPEFULLY_SOCIAL_SET_ID: '4242',
    });
    expect(second).toMatch(/updated factory-scout/);
    expect(second).toContain('created factory-publisher');
    expect(second).not.toContain('APIFY_TOKEN not set');

    const agents = (await app.inject({ method: 'GET', url: '/api/agents' })).json<SeededAgent[]>();
    const factory = agents.filter((agent) => agent.name.startsWith('factory-'));
    expect(factory.map((agent) => agent.name).sort()).toEqual([
      'factory-editor',
      'factory-measure',
      'factory-notes-miner',
      'factory-publisher',
      'factory-scout',
      'factory-writer',
    ]);
    for (const agent of factory) {
      expect(agent.mode, agent.name).toBe('background');
      expect(agent.metadata, agent.name).toMatchObject({ defaultTags: { campaign: 'content-factory' } });
    }

    const byName = (name: string) => factory.find((agent) => agent.name === name)!;
    expect(byName('factory-notes-miner').mcpServers).toEqual([
      expect.objectContaining({ name: 'notes', url: notes!.url }),
    ]);
    const publisher = byName('factory-publisher');
    expect(publisher.httpTools).toEqual([expect.objectContaining({ name: 'typefully_create_draft', requiresApproval: true })]);
    const publisherSecrets = await app.inject({ method: 'GET', url: `/api/agents/${publisher.id}/secrets` });
    expect(publisherSecrets.json()).toEqual({ keys: [], toolKeys: ['TYPEFULLY_API_KEY'] });
    expect(await readSandboxScopeSecrets(container.secretProvider, publisher.id)).toEqual({});

    const minerStatus = await app.inject({ method: 'GET', url: `/api/agents/${byName('factory-notes-miner').id}/mcp-servers` });
    expect(minerStatus.json<{ servers: Array<{ state: string; tools: Array<{ name: string }> }> }>().servers[0]).toMatchObject({
      state: 'ready',
      tools: [
        expect.objectContaining({ name: 'notes__list_meetings' }),
        expect.objectContaining({ name: 'notes__get_meetings' }),
        expect.objectContaining({ name: 'notes__get_meeting_transcript' }),
      ],
    });
    // Apify comes in as HTTP tools whose endpoint URL carries Apify's charge
    // cap, with the token stored tools-only.
    for (const [name, tools] of [
      ['factory-scout', ['apify_linkedin_search', 'apify_x_posts', 'apify_linkedin_profile_posts']],
      ['factory-measure', ['apify_linkedin_profile_posts', 'apify_x_posts']],
    ] as const) {
      const agent = byName(name);
      expect(agent.mcpServers ?? [], name).toEqual([]);
      expect(agent.httpTools.map((tool) => tool.name), name).toEqual(tools);
      for (const tool of agent.httpTools) {
        expect(new URL(tool.endpoint).searchParams.get('maxTotalChargeUsd'), `${name}/${tool.name}`).toMatch(/^0\.0[25]$/);
      }
      const secrets = await app.inject({ method: 'GET', url: `/api/agents/${agent.id}/secrets` });
      expect(secrets.json(), name).toEqual({ keys: [], toolKeys: ['APIFY_TOKEN'] });
      expect(await readSandboxScopeSecrets(container.secretProvider, agent.id), name).toEqual({});
    }

    const triggers = (await app.inject({ method: 'GET', url: '/api/triggers' }))
      .json<Array<{ agentId: string; eventType: string; enabled: boolean }>>();
    const nameOf = new Map(factory.map((agent) => [agent.id, agent.name]));
    expect(triggers
      .filter((trigger) => nameOf.has(trigger.agentId))
      .map((trigger) => `${nameOf.get(trigger.agentId)} <- ${trigger.eventType}`)
      .sort()).toEqual([
      'factory-editor <- custom.factory.draft',
      'factory-measure <- custom.factory.measure',
      'factory-notes-miner <- custom.factory.brief',
      'factory-publisher <- custom.factory.approved',
      'factory-scout <- custom.factory.measured',
      'factory-scout <- custom.factory.week',
      'factory-writer <- custom.factory.material',
    ]);

    const schedules = (await app.inject({ method: 'GET', url: '/api/schedules' }))
      .json<{ schedules: Array<{ name: string; cronExpression: string; eventType: string }> }>().schedules;
    expect(schedules.map((schedule) => `${schedule.name} ${schedule.cronExpression} ${schedule.eventType}`).sort()).toEqual([
      'content-factory-measure 0 7 * * 4 custom.factory.measure',
      'content-factory-weekly 0 7 * * 1 custom.factory.week',
    ]);

    const budgets = (await app.inject({ method: 'GET', url: '/api/budgets' }))
      .json<{ policies: Array<{ name: string; doc: { selector: Record<string, string>; limits: Record<string, number> } }> }>().policies;
    expect(budgets).toEqual([expect.objectContaining({
      name: 'content-factory weekly budget',
      doc: expect.objectContaining({ selector: { campaign: 'content-factory' }, limits: { costUsd: 3, turns: 40 } }),
    })]);
  }, 180_000);

  it('runs the weekly chain and the measure loop with a fake harness', async () => {
    const { app, container } = testApp!;
    const agents = (await app.inject({ method: 'GET', url: '/api/agents' })).json<SeededAgent[]>();
    const nameOf = new Map(agents.map((agent) => [agent.id, agent.name.replace(/^factory-/, '')]));
    const finalizer = new TurnFinalizer({ db: container.db, eventBus: container.eventBus });
    const emit = (type: string, agentId: string, payload: Record<string, unknown>) =>
      container.eventBus.emitCustomAsync(type, agentId, payload);

    vi.spyOn(container.turnStartupService, 'launchPreparedTurn').mockImplementation(async (start, agentId, options) => {
      if (launches.some((launch) => launch.turnId === start.turnId)) return;
      const agent = nameOf.get(agentId) ?? agentId;
      launches.push({ agent, turnId: start.turnId, mode: start.mode, task: start.taskDescription });
      const task = start.taskDescription;
      if (agent === 'scout' && task.startsWith('Weekly scout run')) {
        await emit('custom.factory.brief', agentId, {
          brief: 'Short stories with one hard number beat lists this week.',
          briefArtifactId: 'artifact-brief',
          week: '2026-10-26',
        });
      } else if (agent === 'notes-miner') {
        await emit('custom.factory.material', agentId, {
          brief: 'Short stories with one hard number beat lists this week.',
          stories: [{ kind: 'number', headline: 'A capped agent run costs under $2', needsReview: false }],
          week: '2026-10-26',
        });
      } else if (agent === 'writer') {
        for (const channel of ['linkedin', 'x', 'blog']) {
          await emit('custom.factory.draft', agentId, {
            channel,
            title: `${channel} draft`,
            text: `We capped every agent run at $2. (${channel})`,
            story: 'A capped agent run costs under $2',
            checks: 'deslop ok',
            week: '2026-10-26',
          });
        }
      } else if (agent === 'editor') {
        const channel = /channel: (\w+)/.exec(task)?.[1] ?? 'unknown';
        if (channel === 'blog') {
          await emit('custom.factory.rejected', agentId, { channel, title: 'blog draft', note: 'Not this week.' });
        } else {
          await emit('custom.factory.approved', agentId, {
            channel,
            title: `${channel} draft`,
            text: `We capped every agent run at $2, approved. (${channel})`,
            artifactId: `artifact-${channel}`,
            edited: channel === 'linkedin',
          });
        }
      } else if (agent === 'measure') {
        await emit('custom.factory.measured', agentId, {
          report: '| linkedin | 2026-10-27 | We capped every agent run | 120 likes |',
          artifactId: 'artifact-engagement',
        });
      }
      await finalizer.finalize({ turnId: start.turnId, agentId, conversationId: start.conversationId, status: 'completed' });
      options?.onSuccess?.();
    });

    const config = { niche: { keywords: ['AI agents in production'] }, me: { linkedinUrl: 'https://www.linkedin.com/in/example-owner/' } };
    const started = await app.inject({
      method: 'POST',
      url: '/api/triggers/emit',
      payload: { type: 'custom.factory.week', payload: config },
    });
    expect(started.statusCode, started.body).toBeLessThan(300);

    const count = (agent: string) => launches.filter((launch) => launch.agent === agent).length;
    await vi.waitFor(() => {
      expect(count('scout')).toBe(1);
      expect(count('notes-miner')).toBe(1);
      expect(count('writer')).toBe(1);
      expect(count('editor')).toBe(3);
      expect(count('publisher')).toBe(2);
    }, { timeout: 30_000, interval: 50 });

    const measured = await app.inject({
      method: 'POST',
      url: '/api/triggers/emit',
      payload: { type: 'custom.factory.measure', payload: { me: config.me } },
    });
    expect(measured.statusCode).toBeLessThan(300);
    await vi.waitFor(() => {
      expect(count('measure')).toBe(1);
      expect(count('scout')).toBe(2);
    }, { timeout: 30_000, interval: 50 });

    expect(launches.every((launch) => launch.mode === 'background')).toBe(true);
    const taskOf = (agent: string, index = 0) => launches.filter((launch) => launch.agent === agent)[index]!.task;
    expect(taskOf('scout')).toContain('"keywords":["AI agents in production"]');
    expect(taskOf('scout')).toContain('example-owner');
    expect(taskOf('notes-miner')).toContain('Short stories with one hard number beat lists this week.');
    expect(taskOf('writer')).toContain('"headline":"A capped agent run costs under $2"');
    expect(launches.filter((launch) => launch.agent === 'editor').map((launch) => /channel: (\w+)/.exec(launch.task)?.[1]).sort())
      .toEqual(['blog', 'linkedin', 'x']);
    expect(launches.filter((launch) => launch.agent === 'publisher').map((launch) => /channel: (\w+)/.exec(launch.task)?.[1]).sort())
      .toEqual(['linkedin', 'x']);
    expect(taskOf('scout', 1)).toMatch(/^File this engagement report/);
    expect(taskOf('scout', 1)).toContain('120 likes');

    // Every run counts against the one campaign budget.
    for (const agent of agents.filter((candidate) => candidate.name.startsWith('factory-'))) {
      const turns = (await app.inject({ method: 'GET', url: `/api/agents/${agent.id}/turns` }))
        .json<{ turns: Array<{ status: string; tags?: Record<string, string> | null }> }>().turns;
      for (const turn of turns) {
        expect(turn.tags, agent.name).toMatchObject({ campaign: 'content-factory' });
        expect(turn.status, agent.name).toBe('COMPLETED');
      }
    }
  }, 120_000);
});
