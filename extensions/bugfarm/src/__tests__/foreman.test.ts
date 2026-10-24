import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { EnvContext } from '../../pipeline/lib/build-env.ts';
import type { CheckResult } from '../../pipeline/lib/check-candidate.ts';
import { pendingCalibration, type Calibrate, type CalibrationBudget } from '../calibrate.js';
import type { FloorApi, StartTurnInput, TurnInfo } from '../floor/api.js';
import type { ItemContext } from '../foreman/context.js';
import { DEFAULT_CONFIG, Foreman, itemKeyFor, type CampaignConfig } from '../foreman/foreman.js';
import type { JobRecord } from '../jobs/runner.js';
import type { JobKind } from '../shared/board.js';
import { MemoryStore } from './memory-store.js';

const REPO = 'fastapi/fastapi';
const HEAD = 'a'.repeat(40);
const SHAS = ['1111111111111111111111111111111111111111', '2222222222222222222222222222222222222222'];
const AGENTS = { scout: 'bugfarm-scout', env_builder: 'bugfarm-env-builder', writer: 'bugfarm-writer', teacher: 'bugfarm-teacher' } as const;

function config(): CampaignConfig {
  return { ...DEFAULT_CONFIG, repo: REPO, budget_tag: 'test-tag', batch_size: 2, writer_concurrency: 2 };
}

const quiet = { log: () => undefined, warn: () => undefined };
const TASKS = mkdtempSync(path.join(tmpdir(), 'bugfarm-foreman-'));
afterAll(() => rmSync(TASKS, { recursive: true, force: true }));

function itemContext(_repo: string, sha: string): ItemContext {
  const check = {
    repo: REPO,
    sha,
    subject: 'fix',
    head: HEAD,
    env_image: 'img',
    accepted: true,
    buggy_base: 'head',
    fix_date: '2026-01-02T00:00:00Z',
    test_targets: ['tests/test_x.py'],
    fail_to_pass: ['tests/test_x.py::test_symptom'],
    pass_to_pass: ['tests/test_x.py::test_other'],
    flaky_tests: [],
    suite_modules: ['tests/test_x.py'],
    deselect: [],
    hidden_test_files: ['tests/test_x.py'],
    deleted_test_files: [],
    failing_output: 'AssertionError: 422 != 200',
    timings: {},
    workdir: '/tmp/none',
  } as CheckResult;
  return {
    check,
    fixDiff: '--- a/fastapi/routing.py\n+++ b/fastapi/routing.py\n@@ -1,1 +1,1 @@ def _serialize_response(x):\n-    return a\n+    return b\n',
    testDiff: '',
    testSource: 'from fastapi import FastAPI\n',
    sourceFiles: ['fastapi/routing.py'],
  };
}

async function envContext(repo: string): Promise<EnvContext> {
  return { repo, head: HEAD, top_level: [], files: {}, test_dirs: {}, suite_args: ['tests'], source_dirs: ['fastapi'] };
}

/** Floor agents that do their job the moment a turn starts, the way the HTTP tools record it. */
class FakeFloor implements FloorApi {
  started: StartTurnInput[] = [];
  private readonly byKey = new Map<string, string>();
  private readonly turns = new Map<string, TurnInfo>();
  private n = 0;

  constructor(private readonly store: MemoryStore) {}

  async findAgentByName(name: string): Promise<string | null> {
    return `id-${name}`;
  }

  /** A turn that exists in Stablehand already (started before a crash). */
  adopt(turnId: string, tags: Record<string, string>): void {
    this.turns.set(turnId, { id: turnId, agentId: 'x', status: 'COMPLETED', error: null, stopCode: null, costUsd: 0.2, costCoverage: 'complete', tags });
  }

  async startTurn(input: StartTurnInput): Promise<{ turnId: string }> {
    const known = this.byKey.get(input.idempotencyKey);
    if (known) return { turnId: known };
    const turnId = `turn-${++this.n}`;
    this.byKey.set(input.idempotencyKey, turnId);
    this.started.push(input);
    this.adopt(turnId, input.tags);
    // The agent's tool calls land after the foreman has recorded the turn.
    setTimeout(() => void this.act(turnId, input), 0);
    return { turnId };
  }

  private async act(turnId: string, input: StartTurnInput): Promise<void> {
    const submit = (submission: Record<string, unknown>) => this.store.upsert([{ kind: 'turn', key: turnId, payload: { submission } }]);
    if (input.tags.stage === 'scout') {
      await submit({ candidates: SHAS.map((sha, i) => ({ pr: 100 + i, sha, title: `Fix bug ${i}` })) });
    } else if (input.tags.stage === 'env') {
      await this.store.upsert([{ kind: 'env', key: REPO, payload: { repo: REPO, head: HEAD, tag: 'bugfarm/env-fastapi:x', ok: true, dockerfile: 'FROM python', built_by: 'agent', built_at: Date.now() } }]);
    } else {
      await submit({ instruction: `# Responses come back as 422\n\nPosting a valid form returns 422 instead of 200 (${input.tags.stage}).` });
    }
  }

  async waitForTurn(turnId: string): Promise<TurnInfo> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const info = this.turns.get(turnId);
    if (!info) throw new Error(`unknown turn ${turnId}`);
    return info;
  }

  async lookupTurn(turnId: string): Promise<TurnInfo> {
    return this.waitForTurn(turnId);
  }
}

class FakeJobs {
  submitted: Array<{ kind: JobKind; id: string }> = [];
  private readonly jobs = new Map<string, JobRecord>();

  /** What package_task writes for an instruction; a test can make it write something else. */
  constructor(readonly packaged: (instruction: string) => string = (instruction) => instruction) {}

  async submit(kind: JobKind, args: Record<string, unknown>, opts: { id?: string } = {}): Promise<JobRecord> {
    const id = opts.id ?? `${kind}-${this.submitted.length}`;
    const existing = this.jobs.get(id);
    if (existing) return existing;
    this.submitted.push({ kind, id });
    let result: Record<string, unknown>;
    if (kind === 'package_task') {
      // Like package-task: a canary line, then the instruction it was given.
      const dir = path.join(TASKS, `${id.replace(/[^a-z0-9]+/gi, '-')}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'instruction.md'), `<!-- bugfarm-canary GUID 0000 -->\n${this.packaged(String(args.instruction ?? '')).trim()}\n`);
      result = { task_dir: dir };
    } else {
      result = kind === 'check_candidate' ? { accepted: true, sha: args.sha } : kind === 'run_controls' ? { passed: true, oracle: 1, nop: 0 } : { ok: true, tag: 'img' };
    }
    const job = { id, kind, args, status: 'done', result } as JobRecord;
    this.jobs.set(id, job);
    return job;
  }

  async settle(id: string): Promise<JobRecord> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`no job ${id}`);
    return job;
  }

  async get(id: string): Promise<JobRecord | null> {
    return this.jobs.get(id) ?? null;
  }
}

function foremanWith(store: MemoryStore, floor: FakeFloor, jobs: FakeJobs, calibrate: Calibrate = pendingCalibration): Foreman {
  return new Foreman({
    store,
    jobs,
    floor,
    agentNames: AGENTS,
    calibrate,
    panel: { id: 'cal-test', entries: [{ harness: 'terminus-2', model: 'claude-x', family: 'anthropic' }, { harness: 'terminus-2', model: 'gpt-x', family: 'openai' }] },
    envContext,
    itemContext,
    logger: quiet,
    costSettleMs: 0,
  });
}

describe('Foreman', () => {
  it('runs a batch from the Scout to the calibration hand-off', async () => {
    const store = new MemoryStore();
    const floor = new FakeFloor(store);
    const jobs = new FakeJobs();
    const foreman = foremanWith(store, floor, jobs);

    await foreman.launch('c1', config());
    await foreman.whenIdle('c1');

    const campaign = store.payload<Record<string, unknown>>('campaign', 'c1');
    expect(campaign).toMatchObject({ status: 'done', recovered_from_crash: 0, env: { state: 'ready' } });
    for (const sha of SHAS) {
      const item = store.payload<Record<string, unknown>>('item', itemKeyFor('c1', REPO, sha));
      expect(item).toMatchObject({ stage: 'calibrating', step: 'handed_off', campaign: 'c1', sha });
      expect(String(item?.instruction)).toContain('422');
    }
    // One Scout, one Env builder, then a draft and a review per card; every turn carries the tags.
    expect(floor.started.map((t) => t.tags.stage).sort()).toEqual(['env', 'review', 'review', 'scout', 'write', 'write']);
    expect(floor.started.every((t) => t.tags.campaign === 'test-tag' && t.tags.batch === '1' && t.tags.item)).toBe(true);
    expect(jobs.submitted.map((j) => j.kind).sort()).toEqual(['check_candidate', 'check_candidate', 'package_task', 'package_task', 'run_controls', 'run_controls']);
    // Spend is the sum of the turns: 6 turns at $0.20.
    expect(campaign?.spend_usd).toBeCloseTo(1.2, 5);
    expect(store.payload<Record<string, unknown>>('batch', 'c1:1')).toMatchObject({ status: 'done', candidates: 2, ready: 2, rejected: 0 });
  });

  it('resumes a crashed batch where each card left off, without redoing finished work', async () => {
    const store = new MemoryStore();
    const keyA = itemKeyFor('c2', REPO, SHAS[0]);
    const keyB = itemKeyFor('c2', REPO, SHAS[1]);
    const tags = (stage: string, item: string) => ({ campaign: 'test-tag', batch: '1', stage, item });
    await store.upsert([
      { kind: 'campaign', key: 'c2', payload: { status: 'running', batch: 1, config: config(), env: { state: 'ready' }, recovered_from_crash: 0, spend_usd: 0 } },
      { kind: 'batch', key: 'c2:1', payload: { n: 1, campaign: 'c2', status: 'running', scouted: true } },
      // Card A: its review turn was in flight when the worker died. Stablehand finished it meanwhile.
      { kind: 'item', key: keyA, payload: { stage: 'fail_pass', step: 'reviewing', campaign: 'c2', batch: 1, repo: REPO, sha: SHAS[0], draft: '# Draft\n\nA form post returns 422.', turns: { review: { key: 'k-review-a', attempt: 1, turn_id: 'turn-review-a', task: null } } } },
      { kind: 'turn', key: 'turn-review-a', payload: { turn_id: 'turn-review-a', role: 'writer', agent_id: 'x', campaign: 'c2', batch: 1, stage: 'review', item: keyA, status: 'running', submission: { instruction: '# Forms answer 422\n\nA valid form post returns 422 instead of 200.' } } },
      // Card B: its draft turn was recorded but never sent (the crash came first).
      { kind: 'item', key: keyB, payload: { stage: 'fail_pass', step: 'writing', campaign: 'c2', batch: 1, repo: REPO, sha: SHAS[1], turns: { write: { key: 'k-write-b', attempt: 1, turn_id: null, task: 'the stored task text' } } } },
    ]);
    const floor = new FakeFloor(store);
    floor.adopt('turn-review-a', tags('review', keyA));
    const jobs = new FakeJobs();
    const foreman = foremanWith(store, floor, jobs);

    expect(await foreman.resumeAll()).toEqual(['c2']);
    await foreman.whenIdle('c2');

    expect(store.payload<Record<string, unknown>>('campaign', 'c2')).toMatchObject({ status: 'done', recovered_from_crash: 1 });
    expect(store.payload<Record<string, unknown>>('item', keyA)).toMatchObject({ step: 'handed_off', instruction: '# Forms answer 422\n\nA valid form post returns 422 instead of 200.' });
    expect(store.payload<Record<string, unknown>>('item', keyB)).toMatchObject({ step: 'handed_off' });
    // Card A's review was not started again; card B's draft went out with the stored key and text.
    const stages = floor.started.map((t) => `${t.tags.stage}:${t.tags.item === keyA ? 'A' : 'B'}`);
    expect(stages.sort()).toEqual(['review:B', 'write:B']);
    expect(floor.started.find((t) => t.tags.stage === 'write')).toMatchObject({ idempotencyKey: 'k-write-b', task: 'the stored task text' });
    // No Scout or Env builder turn, no repeated check: only the remaining jobs ran.
    expect(jobs.submitted.map((j) => `${j.kind}:${j.id === `${keyA}:package` || j.id === `${keyA}:controls` ? 'A' : 'B'}`).sort())
      .toEqual(['package_task:A', 'package_task:B', 'run_controls:A', 'run_controls:B']);
  });

  it('calibrates the packaged final instruction and moves cards to Accepted or Rejected', async () => {
    const store = new MemoryStore();
    const floor = new FakeFloor(store);
    const calls: Array<{ taskDir: string; budget: CalibrationBudget; other: number }> = [];
    const calibrate: Calibrate = async (taskDir, _panel, budget) => {
      calls.push({ taskDir, budget, other: budget.campaign?.otherSpendUsd() ?? -1 });
      // Calibration writes its attempts to the board; the foreman counts them as spend.
      await store.upsert([{ kind: 'attempt', key: `${budget.item}:a1`, payload: { item: budget.item, harness: 'terminus-2', model: 'claude-x', try: 1, result: 'fail', cost_usd: 0.25, phase: 'calibration' } }]);
      return budget.item.endsWith(SHAS[0].slice(0, 12))
        ? { state: 'accepted', difficulty: { anthropic: { passes: 1, attempts: 4 } }, costUsd: 0.25 }
        : { state: 'rejected', reason: 'too_easy', detail: 'the frontier stopped early as too easy (anthropic 2/2)', difficulty: { anthropic: { passes: 2, attempts: 2 } }, costUsd: 0.25 };
    };
    const foreman = foremanWith(store, floor, new FakeJobs(), calibrate);
    await foreman.launch('c4', config());
    await foreman.whenIdle('c4');

    const a = store.payload<Record<string, unknown>>('item', itemKeyFor('c4', REPO, SHAS[0]));
    const b = store.payload<Record<string, unknown>>('item', itemKeyFor('c4', REPO, SHAS[1]));
    expect(a).toMatchObject({ stage: 'accepted', step: 'accepted', difficulty: { anthropic: { passes: 1, attempts: 4 } } });
    expect(a?.instruction_sha).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toMatchObject({ stage: 'rejected', reject_reason: 'too_easy', reject_detail: 'the frontier stopped early as too easy (anthropic 2/2)', difficulty: { anthropic: { passes: 2, attempts: 2 } } });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.budget).toMatchObject({ maxUsd: DEFAULT_CONFIG.calibration_usd, tags: { campaign: 'test-tag', stage: 'calibrate' }, campaign: { id: 'c4', capUsd: config().cap_usd } });
      // The gate sees the floor turns' spend: at least the Scout, the Env builder and this card's two Writer turns.
      expect(call.other).toBeGreaterThanOrEqual(0.8 - 1e-9);
    }
    // Spend: 6 turns at $0.20 plus 2 calibration attempts at $0.25.
    expect(store.payload<Record<string, unknown>>('campaign', 'c4')).toMatchObject({ panel: 'cal-test', families: ['anthropic', 'openai'] });
    expect(store.payload<Record<string, unknown>>('campaign', 'c4')?.spend_usd).toBeCloseTo(1.7, 5);
    expect(a?.cost_usd).toBeCloseTo(0.65, 5);
    expect(store.payload<Record<string, unknown>>('batch', 'c4:1')).toMatchObject({ status: 'done', candidates: 2, accepted: 1, rejected: 1, ready: 0 });
    expect(store.payload<Record<string, unknown>>('batch', 'c4:1')?.cost_usd).toBeCloseTo(1.7, 5);
  });

  it('never calibrates a task whose packaged instruction is not the final one', async () => {
    const store = new MemoryStore();
    const floor = new FakeFloor(store);
    let called = 0;
    const calibrate: Calibrate = async () => {
      called++;
      return { state: 'accepted' };
    };
    const foreman = foremanWith(store, floor, new FakeJobs(() => 'an older draft of the issue'), calibrate);
    await foreman.launch('c5', { ...config(), batch_size: 1 });
    await foreman.whenIdle('c5');
    expect(called).toBe(0);
    expect(store.payload<Record<string, unknown>>('item', itemKeyFor('c5', REPO, SHAS[0]))).toMatchObject({ stage: 'rejected', reject_reason: 'instruction_mismatch' });
  });

  it('rejects a card whose final instruction still leaks the fix', async () => {
    const store = new MemoryStore();
    const key = itemKeyFor('c3', REPO, SHAS[0]);
    await store.upsert([
      { kind: 'campaign', key: 'c3', payload: { status: 'running', batch: 1, config: { ...config(), batch_size: 1 }, env: { state: 'ready' } } },
      { kind: 'batch', key: 'c3:1', payload: { n: 1, campaign: 'c3', status: 'running', scouted: true } },
      { kind: 'item', key, payload: { stage: 'fail_pass', step: 'reviewing', campaign: 'c3', batch: 1, repo: REPO, sha: SHAS[0], draft: 'x', turns: { review: { key: 'k', attempt: 1, turn_id: 'turn-r', task: null } } } },
      { kind: 'turn', key: 'turn-r', payload: { turn_id: 'turn-r', role: 'writer', agent_id: 'x', campaign: 'c3', batch: 1, stage: 'review', item: key, status: 'running', submission: { instruction: 'Fix _serialize_response in fastapi/routing.py so it returns b.' } } },
    ]);
    const floor = new FakeFloor(store);
    floor.adopt('turn-r', { stage: 'review', item: key });
    const foreman = foremanWith(store, floor, new FakeJobs());
    await foreman.resumeAll();
    await foreman.whenIdle('c3');
    expect(store.payload<Record<string, unknown>>('item', key)).toMatchObject({ stage: 'rejected', reject_reason: 'instruction_leaks_fix' });
  });
});
