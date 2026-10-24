import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { toAtifV17 } from './calibrate-atif.ts';
import { jobConfig, judge, labelsCompose } from './calibrate-harbor.ts';
import { defaultPanel, fileSafe, knownModel, measuredFamilies, panelDefinition, panelSha, validatePanel } from './calibrate-panel.ts';
import { probeRows, probeTable } from './calibrate-probe.ts';
import { withSolverTools } from './lib/build-env.ts';
import { BudgetPool, CostModel, TrialSlots, bestCost, calibrationToml, itemKeyFor, ladderPriority, readBugfarmMetadata, readTaskInfo, writeTaskCalibration } from './calibrate.ts';

const tmp = mkdtempSync(join(tmpdir(), 'bugfarm-cal-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('task identity', () => {
  it('reads [metadata.bugfarm] strings and derives the board item key', () => {
    const toml = [
      '[task]',
      'name = "bugfarm/fastapi-0f3e7bd682"',
      '[metadata.bugfarm]',
      'repo = "fastapi/fastapi"',
      'fix_sha = "0f3e7bd682aa"',
      'fix_subject = "Fix \\"quoted\\" thing"',
      'fail_to_pass = [',
      '  "tests/x.py::t",',
      ']',
      '[verifier]',
      'timeout_sec = 600.0',
    ].join('\n');
    const meta = readBugfarmMetadata(toml);
    expect(meta).toMatchObject({ repo: 'fastapi/fastapi', fix_sha: '0f3e7bd682aa', fix_subject: 'Fix "quoted" thing' });
    expect(itemKeyFor('fastapi/fastapi', '0f3e7bd682aa')).toBe('fastapi@0f3e7bd6');
    expect(itemKeyFor('someone/Other', 'abcdef0123')).toBe('other@abcdef01');

    const dir = join(tmp, 'fastapi-0f3e7bd682');
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'task.toml'), toml);
    writeFileSync(join(dir, 'instruction.md'), 'fix it');
    writeFileSync(join(dir, 'tests', 'test.sh'), 'exit 0');
    const a = readTaskInfo(dir);
    expect(a.item).toBe('fastapi@0f3e7bd6');
    writeFileSync(join(dir, 'instruction.md'), 'fix it, differently');
    const b = readTaskInfo(dir);
    expect(b.instruction_sha).not.toBe(a.instruction_sha);
    expect(b.verifier_sha).toBe(a.verifier_sha);
  });
});

describe('task.toml receipt', () => {
  it('appends the calibration block once and replaces it on recalibration', () => {
    const dir = join(tmp, 'toml-task');
    mkdirSync(dir, { recursive: true });
    const base = '[metadata.bugfarm]\nrepo = "a/b"\n\n[environment]\ncpus = 2\n';
    writeFileSync(join(dir, 'task.toml'), base);
    const panel = { ...defaultPanel(), frozen_at: 'x', sha: 'abc', routes: [] };
    const result = (decision: 'accept' | 'too_easy', passes: number) => ({
      task: 'toml-task', item: 'b@1', panel: { id: panel.id, sha: 'abc' }, decision, cost: 1.5, cost_this_call: 1.5, cost_settled: true,
      screen: { cheap: null, frontier: null }, attempts: 4,
      perFamily: { anthropic: { model: 'claude-sonnet-5', passes, attempts: 4, errors: 0, rate: passes / 4, ci95: [0, 1] as [number, number], state: 'open' as const } },
    });
    writeTaskCalibration(dir, panel, result('accept', 1));
    writeTaskCalibration(dir, panel, result('too_easy', 3));
    const text = readFileSync(join(dir, 'task.toml'), 'utf8');
    expect(text.startsWith(base)).toBe(true);
    expect(text.match(/\[metadata\.bugfarm\.calibration\]/g)?.length).toBe(1);
    expect(text).toContain('decision = "too_easy"');
    expect(text).toContain('[metadata.bugfarm.difficulty.anthropic]\nmodel = "claude-sonnet-5"\npasses = 3\nattempts = 4');
    expect(calibrationToml(panel, result('accept', 1))).toContain('phase = "selection"');
  });
});

describe('panel', () => {
  it('validates the default panel and hashes it stably', () => {
    const p = defaultPanel();
    expect(() => validatePanel(p)).not.toThrow();
    expect(panelSha(p)).toBe(panelSha(defaultPanel()));
    expect(panelSha({ ...p, agent_timeout_sec: 901 })).not.toBe(panelSha(p));
  });

  it('refuses a model that would measure two families', () => {
    const p = defaultPanel();
    p.families[1] = { ...p.families[1], ladder: 'claude-sonnet-5' };
    expect(() => validatePanel(p)).toThrow();
  });

  it('defines cal-v2: one measured model per family, the autocache frontier and early decisions', () => {
    const p = panelDefinition('cal-v2');
    expect(() => validatePanel(p)).not.toThrow();
    expect(p.families.map((f) => [f.family, f.ladder])).toEqual([
      ['anthropic', 'claude-sonnet-5-5-autocache'],
      ['openai', 'gpt-6-luna'],
      ['open', 'cf-kimi-k2.7-code'],
      ['google', null],
    ]);
    expect(p.screen).toEqual({ cheap: 'gpt-6-luna', frontier: 'claude-sonnet-5-5-autocache' });
    expect(p.ladder.early).toEqual({ accept_after: 4, unsolved_after: { frontier: 4, others: 8 } });
    expect(measuredFamilies(p)).toEqual(['anthropic', 'openai', 'open']);
    // cal-v1 keeps its shape and its sha.
    expect(panelDefinition('cal-v1')).toEqual(defaultPanel('cal-v1'));
    expect(defaultPanel().ladder.early).toBeUndefined();
  });

  it('finds prices for plain and autocache siblings', () => {
    expect(knownModel('claude-sonnet-5-5')?.pricing.cache_read).toBeCloseTo(0.1e-6);
    expect(knownModel('claude-sonnet-5-5')?.model).toBe('claude-sonnet-5-5');
    expect(knownModel('claude-haiku-5-5-autocache')?.pricing.input).toBeCloseTo(0.1e-6);
    expect(knownModel('claude-sonnet-5-autocache')?.pricing.cache_read).toBeCloseTo(0.2e-6);
    expect(knownModel('no-such-model')).toBeUndefined();
    // `@effort` keeps the gateway model and sends reasoning_effort in the body of every call.
    const low = knownModel('claude-sonnet-5-5-autocache@low');
    expect(low?.model).toBe('claude-sonnet-5-5-autocache');
    expect(low?.call_kwargs).toEqual({ extra_body: { reasoning_effort: 'low' } });
    expect(() => knownModel('claude-sonnet-5-5@fast')).toThrow();
    const cfg = jobConfig({ attemptId: 'a', taskDir: '/t', jobsDir: '/j', jobName: 'j', model: low as NonNullable<typeof low>, agentKwargs: {}, gatewayUrl: 'http://gw', gatewayKey: 'k', processTimeoutMs: 1, runId: 'r' });
    const kwargs = ((cfg.agents as Array<{ kwargs: { llm_call_kwargs: Record<string, unknown> } }>)[0]).kwargs.llm_call_kwargs;
    expect(kwargs.extra_body).toEqual({ reasoning_effort: 'low' });
    expect(fileSafe('claude-sonnet-5-5@low')).toBe('claude-sonnet-5-5_low');
  });
});

describe('trial slots', () => {
  it('give a free slot to the highest try waiting, in arrival order within a try', async () => {
    const slots = new TrialSlots(1);
    const order: string[] = [];
    let release!: () => void;
    const held = slots.use(() => new Promise<void>((r) => { release = r; }), 1);
    const waiters = [['screen-a', 1], ['ladder-b', 3], ['screen-c', 1], ['ladder-d', 2]].map(([name, p]) =>
      slots.use(async () => { order.push(name as string); }, p as number));
    expect(slots.waiting).toBe(4);
    release();
    await Promise.all([held, ...waiters]);
    expect(order).toEqual(['ladder-b', 'ladder-d', 'screen-a', 'screen-c']);
  });
});

describe('attempt cost', () => {
  it('charges the reserve for an attempt with no estimate until the gateway prices it', () => {
    const rec = { cost_state: 'estimated' } as Parameters<typeof bestCost>[0];
    expect(bestCost(rec)).toBe(0);
    expect(bestCost({ ...rec, cost_usd_reserved: 0.3 })).toBe(0.3);
    expect(bestCost({ ...rec, cost_usd_reserved: 0.3, cost_usd_estimate: 0.2 })).toBe(0.2);
    expect(bestCost({ ...rec, cost_usd_reserved: 0.3, cost_usd: 0.25 })).toBe(0.25);
  });
});

describe('env images for terminus-2', () => {
  it('appends a tmux layer to an agent-written Dockerfile that lacks one', () => {
    const agent = 'FROM python:3.12-slim\nRUN pip install -e .[test]\n';
    const built = withSolverTools(agent);
    expect(built.startsWith('FROM python:3.12-slim\nRUN pip install -e .[test]\n')).toBe(true);
    expect(built).toContain('apt-get install -y --no-install-recommends tmux');
    expect(withSolverTools(built)).toBe(built);
    const hasIt = 'FROM python:3.12-slim\nRUN apt-get update && apt-get install -y git tmux\n';
    expect(withSolverTools(hasIt)).toBe(hasIt);
  });
});

describe('probe', () => {
  it('totals tokens and prices the calls against no caching', () => {
    const outcome = (result: 'pass' | 'fail') => ({ result, reward: result === 'pass' ? 1 : 0, seconds: 300, job_dir: '/j', harbor_exit: 0 });
    const rows = probeRows([
      { attempt_id: 'a', model: 'claude-sonnet-5-5', try: 1, outcome: outcome('fail'), gateway: { cost_usd: 0.5, calls: 10, failed_calls: 0, last_start_ms: 0, tokens: { prompt: 240_000, completion: 2_000, cache_read: 0, cache_write: 0 } } },
      { attempt_id: 'b', model: 'claude-sonnet-5-5-autocache', try: 1, outcome: outcome('pass'), gateway: { cost_usd: 0.1, calls: 10, failed_calls: 0, last_start_ms: 0, tokens: { prompt: 240_000, completion: 2_000, cache_read: 200_000, cache_write: 40_000 } } },
    ]);
    expect(rows[0]).toMatchObject({ model: 'claude-sonnet-5-5', attempts: 1, passes: 0, calls: 10, cache_read_share: 0 });
    // 240k prompt at $2/M + 2k output at $10/M = $0.50 without caching.
    expect(rows[1].uncached_usd).toBeCloseTo(0.5);
    expect(rows[1].saved_share).toBeCloseTo(0.8);
    expect(rows[1].cache_read_share).toBeCloseTo(0.8333, 3);
    expect(probeTable(rows)).toContain('| claude-sonnet-5-5-autocache | 1 | 1 | 10 |');
  });
});

describe('harbor job', () => {
  it('routes terminus-2 through the gateway without putting the key in the config', () => {
    const p = defaultPanel();
    const cfg = jobConfig({
      attemptId: 'task:cal-v1:abc:gpt-6-luna:1',
      taskDir: '/tasks/t',
      jobsDir: '/jobs',
      jobName: 'j',
      model: p.models['gpt-6-luna'],
      agentKwargs: p.agent_kwargs,
      agentTimeoutSec: 900,
      gatewayUrl: 'http://localhost:4400/',
      gatewayKey: 'sk-secret',
      processTimeoutMs: 1000,
      runId: 'cal-v1-test',
    });
    const text = JSON.stringify(cfg);
    expect(text).not.toContain('sk-secret');
    const agent = (cfg.agents as Array<Record<string, unknown>>)[0];
    expect(agent.model_name).toBe('openai/gpt-6-luna');
    const kwargs = agent.kwargs as Record<string, unknown>;
    expect(kwargs.api_base).toBe('http://localhost:4400/v1');
    const headers = (kwargs.llm_call_kwargs as { extra_headers: Record<string, string> }).extra_headers;
    expect(JSON.parse(headers['x-litellm-spend-logs-metadata'])).toEqual({ bugfarm_attempt: 'task:cal-v1:abc:gpt-6-luna:1' });
    expect((cfg.environment as { extra_docker_compose: string[] }).extra_docker_compose).toEqual(['/jobs/j.labels.yaml']);
  });

  it('labels the trial main service with the run and attempt', () => {
    const text = labelsCompose({ runId: 'cal-v1-abc', jobName: 'task__m-t01__ff' });
    expect(text).toContain('  main:\n    labels:\n      bugfarm.run: "cal-v1-abc"\n      bugfarm.attempt: "task__m-t01__ff"');
  });

  it('judges a trial by its verifier reward', () => {
    expect(judge({ verifier_result: { rewards: { reward: 1 } } }).result).toBe('pass');
    expect(judge({ verifier_result: { rewards: { reward: 0 } }, exception_info: { exception_type: 'AgentTimeoutError' } }).result).toBe('fail');
    expect(judge({ exception_info: { exception_type: 'RuntimeError', exception_message: 'tmux' } }).result).toBe('error');
    expect(judge(undefined).result).toBe('error');
  });
});

describe('ladder priority', () => {
  const v = (family: 'anthropic' | 'openai', passes: number, attempts: number) => ({ family, model: family, tally: { attempts, passes, fails: attempts - passes, errors: 0, pending: 0 } });
  it('funds the tasks closest to a decision first', () => {
    const perfect = ladderPriority([v('anthropic', 1, 1), v('openai', 0, 1)], 'anthropic');
    const likelyAcceptFew = ladderPriority([v('anthropic', 0, 1), v('openai', 1, 1)], 'anthropic');
    const likelyAcceptMore = ladderPriority([v('anthropic', 0, 4), v('openai', 1, 2)], 'anthropic');
    const mixed = ladderPriority([v('anthropic', 1, 2), v('openai', 0, 2)], 'anthropic');
    const nobody = ladderPriority([v('anthropic', 0, 2), v('openai', 0, 2)], 'anthropic');
    expect([perfect, likelyAcceptMore, likelyAcceptFew, mixed, nobody]).toEqual([...[perfect, likelyAcceptMore, likelyAcceptFew, mixed, nobody]].sort((a, b) => a - b));
    expect(likelyAcceptMore).toBeLessThan(likelyAcceptFew);
  });
});

describe('budget', () => {
  it('reserves estimates and settles actual spend', () => {
    const pool = new BudgetPool(1);
    pool.reserve(0.3);
    expect(pool.remaining()).toBeCloseTo(0.7);
    pool.settle(0.3, 0.1);
    expect(pool.remaining()).toBeCloseTo(0.9);
    expect(pool.spentUsd()).toBeCloseTo(0.1);
  });

  it('keeps the prior until two attempts are seen', () => {
    const m = new CostModel(defaultPanel().models);
    expect(m.estimate('claude-sonnet-5')).toBe(0.5);
    m.observe('claude-sonnet-5', 0.1);
    expect(m.estimate('claude-sonnet-5')).toBe(0.5);
    m.observe('claude-sonnet-5', 0.3);
    expect(m.estimate('claude-sonnet-5')).toBeCloseTo(0.2);
  });
});

describe('ATIF v1.8 -> v1.7', () => {
  it('lowers versions and turns audio parts into text notes', () => {
    const conv = toAtifV17({
      schema_version: 'ATIF-v1.8',
      agent: { name: 'terminus-2', version: '2.0.0' },
      steps: [
        { step_id: 1, source: 'user', message: [{ type: 'text', text: 'hi' }, { type: 'audio', source: { media_type: 'audio/wav', path: 'a.wav' } }] },
        { step_id: 2, source: 'agent', message: 'ok', observation: { results: [{ content: [{ type: 'audio', source: { media_type: 'audio/mpeg', path: 'b.mp3' } }] }] } },
      ],
      subagent_trajectories: [{ schema_version: 'ATIF-v1.8', trajectory_id: 's1', agent: { name: 'x', version: '1' }, steps: [{ step_id: 1, source: 'user', message: 'x' }] }],
    });
    expect(conv.versions_rewritten).toBe(2);
    expect(conv.audio_parts_replaced).toBe(2);
    const t = conv.trajectory as { schema_version: string; steps: Array<{ message: unknown }> };
    expect(t.schema_version).toBe('ATIF-v1.7');
    expect(JSON.stringify(t)).not.toContain('"audio"');
    expect(JSON.stringify(t)).toContain('a.wav');
  });
});
