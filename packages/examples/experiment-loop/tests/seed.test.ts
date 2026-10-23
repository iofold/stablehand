import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifestToAgentCreateInput } from '@stablehand/manifest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { candidateManifest, configFromManifest, loadLoopConfig, loadManifest } from '../src/config.js';
import { LOOP_KEY_CAPABILITIES, seed } from '../seed.js';
import { FakeApi } from './fake-api.js';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

async function manifest(dir: string) {
  return (await loadManifest(join(PACKAGE_DIR, 'agents', dir, 'agent.yaml'))).manifest;
}

describe('experiment loop manifests', () => {
  it('compile into agents with per-run caps, and only loop agents carry the campaign tag', async () => {
    const config = await loadLoopConfig(join(PACKAGE_DIR, 'loop.config.json'));
    const production = await manifest('ops-assistant');
    const candidate = candidateManifest(production, configFromManifest(production), config.campaign);
    const inputs = {
      production: manifestToAgentCreateInput(production),
      candidate: manifestToAgentCreateInput(candidate),
      proposer: manifestToAgentCreateInput(await manifest('proposer')),
      reviewer: manifestToAgentCreateInput(await manifest('reviewer')),
    };
    expect(Object.values(inputs).map((input) => input.name)).toEqual(['ops-assistant', 'ops-assistant-candidate', 'loop-proposer', 'loop-reviewer']);
    for (const [role, input] of Object.entries(inputs)) {
      const caps = (input.harnessConfig as { limits?: { maxCostUsd?: number } }).limits?.maxCostUsd;
      expect(caps, role).toBeGreaterThan(0);
      expect(caps, role).toBeLessThanOrEqual(0.1);
    }
    expect(inputs.production.metadata).not.toHaveProperty('defaultTags');
    expect(inputs.candidate.metadata).toMatchObject({ defaultTags: { campaign: 'experiment-loop' } });
    expect(inputs.candidate.mode).toBe('background');
    expect(inputs.candidate.systemPrompt).toBe(inputs.production.systemPrompt);
    expect(inputs.reviewer.builtinToolPolicy).toEqual({ policy: 'allow', names: ['a2ui-render', 'request-approval'] });
    expect(inputs.proposer.builtinToolPolicy).toEqual({ policy: 'none' });
    expect(configFromManifest(production)).toEqual({
      instructions: production.spec.instructions,
      model: 'gpt-5.4-mini',
      maxTokens: 2000,
      nativeTools: 'none',
    });
  });

  it('keeps slice and holdout apart and names only real tasks', async () => {
    const config = await loadLoopConfig(join(PACKAGE_DIR, 'loop.config.json'));
    const tasks = JSON.parse(await readFile(join(PACKAGE_DIR, config.tasks), 'utf8')) as { tasks: Array<{ id: string }> };
    const ids = new Set(tasks.tasks.map((task) => task.id));
    expect(config.slice).toHaveLength(5);
    for (const id of [...config.slice, ...config.holdout]) expect(ids.has(id), id).toBe(true);
    expect(config.slice.filter((id) => config.holdout.includes(id))).toEqual([]);
  });
});

describe('seed', () => {
  let dir: string;
  let api: FakeApi;
  let lines: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'experiment-loop-seed-'));
    api = new FakeApi();
    lines = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (resetProduction = false) => seed({
    apiUrl: 'http://stablehand.test',
    token: 'master-token',
    packageDir: PACKAGE_DIR,
    keyFile: join(dir, '.loop-key'),
    fetchImpl: api.fetch,
    resetProduction,
    log: (line) => lines.push(line),
  });

  it('creates the agents, one tag budget and a scoped key it never prints', async () => {
    const result = await run();
    expect(api.agents.map((agent) => agent.name)).toEqual(['ops-assistant', 'ops-assistant-candidate', 'loop-proposer', 'loop-reviewer']);
    expect(api.agents[2]?.body.metadata).toMatchObject({ defaultTags: { campaign: 'experiment-loop' } });
    expect(api.budgets).toEqual([{
      id: result.budgetPolicy,
      name: 'experiment-loop tag budget',
      doc: {
        selector: { campaign: 'experiment-loop' },
        window: 'rolling-24h',
        limits: { costUsd: 3, turns: 400 },
        actions: [{ threshold: 0.5, action: 'warn' }, { threshold: 1, action: 'block' }],
      },
    }]);
    expect(api.keys).toMatchObject([{ name: 'experiment-loop-loop', capabilities: [...LOOP_KEY_CAPABILITIES] }]);
    expect(api.keys[0]?.capabilities).not.toContain('interrupts:resolve');
    expect((await readFile(join(dir, '.loop-key'), 'utf8')).trim()).toMatch(/^cmk_/);
    expect((await stat(join(dir, '.loop-key'))).mode & 0o777).toBe(0o600);
    expect(lines.join('\n')).not.toContain('cmk_');
    expect(api.requests.every((request) => request.headers.authorization === 'Bearer master-token')).toBe(true);
  });

  it('updates the loop agents on a re-run and leaves production alone', async () => {
    await run();
    const production = api.agents[0]!;
    api.requests = [];
    await run();
    expect(api.agents).toHaveLength(4);
    expect(api.keys).toHaveLength(1);
    expect(api.calls('POST', /^\/api\/agents$/)).toHaveLength(0);
    expect(api.calls('PATCH', new RegExp(`^/api/agents/${production.id}$`))).toHaveLength(0);
    expect(api.calls('PATCH', /^\/api\/agents\//)).toHaveLength(3);
    expect(api.calls('PATCH', /^\/api\/budgets\//)).toHaveLength(1);
    expect(lines.some((line) => line.includes('kept ops-assistant as it is'))).toBe(true);

    api.requests = [];
    await run(true);
    expect(api.calls('PATCH', new RegExp(`^/api/agents/${production.id}$`))).toHaveLength(1);
  });
});
