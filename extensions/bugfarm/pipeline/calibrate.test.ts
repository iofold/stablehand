import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { toAtifV17 } from './calibrate-atif.ts';
import { jobConfig, judge, labelsCompose } from './calibrate-harbor.ts';
import { defaultPanel, panelSha, validatePanel } from './calibrate-panel.ts';
import { BudgetPool, CostModel, calibrationToml, itemKeyFor, ladderPriority, readBugfarmMetadata, readTaskInfo, writeTaskCalibration } from './calibrate.ts';

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
