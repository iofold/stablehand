import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { EnvContext } from '../../pipeline/lib/build-env.ts';
import type { CheckResult } from '../../pipeline/lib/check-candidate.ts';
import { pendingCalibration } from '../calibrate.js';
import type { FloorApi, StartTurnInput, TurnInfo } from '../floor/api.js';
import type { ItemContext } from '../foreman/context.js';
import { DEFAULT_CONFIG, Foreman, itemKeyFor, type CampaignConfig } from '../foreman/foreman.js';
import type { JobRecord } from '../jobs/runner.js';
import { titlePrefix } from '../learning/features.js';
import { judgeRule, poolBatches } from '../learning/lifecycle.js';
import { LearningLoop } from '../learning/loop.js';
import { batchMetrics, gateFromItems } from '../learning/metrics.js';
import { reviewProposals, type ProposalCard } from '../learning/proposals.js';
import { loadPlaybook, rulesFor } from '../playbook.js';
import type { ItemPayload, JobKind, TurnPayload } from '../shared/board.js';
import type { BatchLearning } from '../shared/learning.js';
import { describePredicate, evaluatePredicate, matches, predicateProblems, type CandidateFeatures, type Predicate } from '../shared/predicate.js';
import { createToolHandlers } from '../tools.js';
import { MemoryStore } from './memory-store.js';

const REPO = 'fastapi/fastapi';
const HEAD = 'a'.repeat(40);
const quiet = { log: () => undefined, warn: () => undefined };

describe('predicates', () => {
  const features: CandidateFeatures = { age_days: 400, title: '♻️ Refactor the router', labels: ['refactor'], source_files: ['fastapi/routing.py'], has_issue: false };

  it('evaluates conditions, combinators and regexes', () => {
    expect(matches({ field: 'age_days', op: '>', value: 300 }, features)).toBe(true);
    expect(matches({ field: 'title', op: 'matches', value: '^♻️|refactor' }, features)).toBe(true);
    expect(matches({ field: 'labels', op: 'contains', value: 'REFACTOR' }, features)).toBe(true);
    expect(matches({ field: 'source_files', op: 'any_matches', value: '^fastapi/openapi/' }, features)).toBe(false);
    expect(matches({ all: [{ field: 'age_days', op: '>', value: 300 }, { not: { field: 'has_issue', op: '==', value: true } }] }, features)).toBe(true);
    expect(matches({ any: [{ field: 'age_days', op: '<', value: 30 }, { field: 'labels', op: 'none_match', value: 'bug' }] }, features)).toBe(true);
  });

  it('never matches on a missing feature, even under not', () => {
    const pred: Predicate = { not: { field: 'non_test_lines', op: '>', value: 5 } };
    expect(evaluatePredicate(pred, features)).toBeNull();
    expect(matches(pred, features)).toBe(false);
    expect(matches({ any: [{ field: 'non_test_lines', op: '>', value: 5 }, { field: 'age_days', op: '>', value: 300 }] }, features)).toBe(true);
  });

  it('reports malformed predicates and describes good ones', () => {
    expect(predicateProblems({ field: 'stars', op: '>', value: 3 })[0]).toContain('unknown feature');
    expect(predicateProblems({ field: 'age_days', op: 'matches', value: 'x' })[0]).toContain('op must be one of');
    expect(predicateProblems({ field: 'title', op: 'matches', value: '(' })[0]).toContain('regular expression');
    expect(predicateProblems({ all: [] })[0]).toContain('1 to 6');
    const good = { all: [{ field: 'age_days', op: '>', value: 300 }, { any: [{ field: 'title', op: 'contains', value: 'v1' }, { field: 'labels', op: 'contains', value: 'docs' }] }] };
    expect(predicateProblems(good)).toEqual([]);
    expect(describePredicate(good)).toBe('age_days > 300 and (title contains "v1" or labels contains "docs")');
  });

  it('reads emoji and gitmoji prefixes off titles', () => {
    expect(titlePrefix('🐛 Fix OpenAPI schemas')).toBe('🐛');
    expect(titlePrefix(':bug: Fix it')).toBe(':bug:');
    expect(titlePrefix('Fix the `Depends` cache')).toBe('');
  });
});

function item(batch: number, stage: ItemPayload['stage'], extra: Partial<ItemPayload> = {}): ItemPayload {
  return { stage, batch, campaign: 'c', ...extra };
}

function turn(batch: number, stage: string, cost: number, role: TurnPayload['role'] = 'writer'): TurnPayload {
  return { turn_id: `${stage}-${batch}-${cost}`, role, agent_id: 'a', campaign: 'c', batch, stage, item: 'x', status: 'completed', cost_usd: cost };
}

describe('batch metrics', () => {
  const items = [
    item(1, 'calibrating'),
    item(1, 'calibrating'),
    item(1, 'rejected', { reject_reason: 'no_fail_to_pass' }),
    item(1, 'rejected', { reject_reason: 'too_easy', controls: { oracle: 1, nop: 0 } }),
    item(1, 'accepted', { controls: { oracle: 1, nop: 0 } }),
    item(2, 'rejected', { reject_reason: 'flaky' }),
  ];
  const turns = [turn(1, 'env', 1.5, 'env_builder'), turn(1, 'scout', 0.1, 'scout'), turn(1, 'write', 0.4), turn(1, 'teach', 0.3, 'teacher'), turn(2, 'scout', 9)];

  it('counts everything that passed its controls at the controls gate, without the env build', () => {
    const m = batchMetrics({ batch: 1, gate: 'controls', items, turns, attempts: [], itemKeys: [] });
    expect(m).toMatchObject({ candidates: 5, accepted: 4, decided: 5, share: 0.8, reasons: { no_fail_to_pass: 1 }, setup_usd: 1.5, teacher_usd: 0.3 });
    expect(m.cost_usd).toBeCloseTo(0.8, 6);
    expect(m.usd_per_accepted).toBeCloseTo(0.2, 6);
  });

  it("counts calibration's verdicts and its spend at the calibration gate", () => {
    const m = batchMetrics({ batch: 1, gate: 'calibration', items, turns, attempts: [{ item: 'k1', harness: 't', model: 'm', try: 1, result: 'pass', cost_usd: 1.2 }], itemKeys: ['k1'] });
    // Two cards still calibrating are not decided; accepted 1 of accepted + no_fail_to_pass + too_easy.
    expect(m).toMatchObject({ accepted: 1, decided: 3, reasons: { no_fail_to_pass: 1, too_easy: 1 }, calibration_usd: 1.2 });
    expect(m.cost_usd).toBeCloseTo(2.0, 6);
  });

  it('picks the calibration gate only when the first batch has calibration verdicts', () => {
    expect(gateFromItems([item(1, 'calibrating'), item(1, 'rejected', { reject_reason: 'flaky' })])).toBe('controls');
    expect(gateFromItems([item(1, 'rejected', { reject_reason: 'too_easy', controls: { oracle: 1, nop: 0 } })])).toBe('calibration');
  });
});

function learning(batch: number, accepted: number, decided: number, cost: number, reasons: Record<string, number>): BatchLearning {
  return {
    batch, gate: 'controls', candidates: decided, accepted, decided, share: decided ? accepted / decided : null, cost_usd: cost,
    usd_per_accepted: accepted ? cost / accepted : null, reasons, passed_controls: accepted, floor_usd: cost, teacher_usd: 0,
    setup_usd: 0, calibration_usd: 0, filtered: 0, filtered_by: {}, rules_served: [], computed_at: 0,
  };
}

describe('rule lifecycle', () => {
  it('keeps a rule when its target falls and the share rises', () => {
    const v = judgeRule({ target: 'no_fail_to_pass', before: learning(1, 5, 10, 2, { no_fail_to_pass: 4, flaky: 1 }), after: learning(2, 8, 10, 2.4, { no_fail_to_pass: 1, flaky: 1 }) });
    expect(v.status).toBe('kept');
    expect(v.effect).toMatchObject({ accepted_share_pts: 30, target_before: { count: 4, decided: 10 }, target_after: { count: 1, decided: 10 }, checks: { target_dropped: true, share_improved: true, usd_improved: true } });
    expect(v.effect.usd_per_accepted).toBeCloseTo(-0.1, 6);
    expect(v.effect.summary).toContain('no_fail_to_pass 4/10 → 1/10');
  });

  it('reverts a rule whose target did not fall, even when the batch improved', () => {
    const v = judgeRule({ target: 'instruction_leaks_fix', before: learning(1, 5, 10, 2, { instruction_leaks_fix: 1, flaky: 4 }), after: learning(2, 8, 10, 2, { instruction_leaks_fix: 1, flaky: 1 }) });
    expect(v.status).toBe('reverted');
    expect(v.effect.checks).toEqual({ target_dropped: false, share_improved: true, usd_improved: true });
  });

  it('defers a verdict on a batch too small to say anything, then pools the next batch', () => {
    const before = learning(2, 9, 10, 1.9, { env_drift: 1 });
    const tiny = learning(3, 1, 1, 0.48, {});
    const deferred = judgeRule({ target: 'env_drift', before, after: tiny });
    expect(deferred.status).toBe('trial');
    expect(deferred.effect).toMatchObject({ too_small: true, min_decided: 5 });
    expect(deferred.effect.summary).toContain('Too few to judge');
    const pooled = poolBatches([tiny, learning(4, 6, 8, 1.6, { flaky: 2 })]);
    expect(pooled).toMatchObject({ batches: [3, 4], accepted: 7, decided: 9, reasons: { flaky: 2 } });
    expect(pooled.usd_per_accepted).toBeCloseTo(2.08 / 7, 4);
    const verdict = judgeRule({ target: 'env_drift', before, after: pooled });
    expect(verdict.status).toBe('reverted');
    expect(verdict.effect.after).toMatchObject({ batch: 4, batches: [3, 4], accepted: 7, decided: 9 });
    expect(verdict.effect.summary).toContain('batches 3–4 vs batch 2');
  });

  it('reverts a rule still too small to measure when the campaign ends', () => {
    const v = judgeRule({ target: 'env_drift', before: learning(2, 9, 10, 1.9, { env_drift: 1 }), after: learning(3, 1, 1, 0.48, {}), final: true });
    expect(v.status).toBe('reverted');
    expect(v.effect.summary).toContain('fewer than the 5 needed');
  });

  it('reverts a rule when its target fell but neither number improved', () => {
    const v = judgeRule({ target: 'flaky', before: learning(1, 6, 10, 2, { flaky: 4 }), after: learning(2, 5, 10, 3, { flaky: 1, no_fail_to_pass: 4 }) });
    expect(v.status).toBe('reverted');
    expect(v.effect.checks).toMatchObject({ target_dropped: true, share_improved: false, usd_improved: false });
  });
});

describe('proposal review', () => {
  const cards: ProposalCard[] = [
    { key: 'a', pr: 1, accepted: true, reason: null, features: { age_days: 10, title: 'Fix A' } },
    { key: 'b', pr: 2, accepted: true, reason: null, features: { age_days: 40, title: 'Fix B' } },
    { key: 'c', pr: 3, accepted: false, reason: 'no_fail_to_pass', features: { age_days: 400, title: 'Fix C for v1' } },
    { key: 'd', pr: 4, accepted: false, reason: 'no_fail_to_pass', features: { age_days: 380, title: 'Fix D' } },
  ];
  const base = { batch: 1, reasons: { no_fail_to_pass: 2 }, cards, existing: [{ id: 'old', kind: 'writer_rule', text: 'Never name the file.', status: 'reverted' }] };

  it('accepts a filter that catches its target and dry-runs it', () => {
    const [r] = reviewProposals({ ...base, rules: [{ kind: 'scout_filter', text: 'Skip fixes older than 300 days.', skip_if: { field: 'age_days', op: '>', value: 300 }, targets: 'no_fail_to_pass', expected_effect: 'No no_fail_to_pass rejects from old fixes.' }] });
    expect(r.ok).toBe(true);
    expect(r.predicate).toBe('age_days > 300');
    expect(r.dry_run).toMatchObject({ would_skip: 2, target_rejects_caught: 2, target_rejects: 2, accepted_lost: 0 });
  });

  it('refuses rules that cannot be measured or repeat a reverted one', () => {
    const reports = reviewProposals({
      ...base,
      rules: [
        { kind: 'writer_rule', text: 'Describe the symptom only.', targets: 'instruction_leaks_fix', expected_effect: 'Fewer leaks.' },
        { kind: 'scout_filter', text: 'Skip v1 fixes, young ones.', skip_if: { field: 'age_days', op: '<', value: 50 }, targets: 'no_fail_to_pass', expected_effect: 'x x x x x' },
        { kind: 'writer_rule', text: 'Never name the file!', targets: 'no_fail_to_pass', expected_effect: 'Fewer leaks.' },
        { kind: 'scout_filter', text: 'Skip it all', targets: 'no_fail_to_pass', expected_effect: 'x' },
      ],
    });
    expect(reports[0].errors[0]).toContain('no card in batch 1 was rejected for instruction_leaks_fix');
    expect(reports[1].errors.join(' ')).toContain('would not have dropped any');
    expect(reports[1].errors.join(' ')).toContain('accepted card');
    expect(reports[2].errors[0]).toContain('reverted on measurement');
    expect(reports[3].ok).toBe(false);
  });

  it('refuses an env recipe once the campaign reuses a built environment', () => {
    const rule = { kind: 'env_recipe', text: 'Install the core version the commit pins.', targets: 'no_fail_to_pass', expected_effect: 'Fewer drift rejects.' };
    expect(reviewProposals({ ...base, rules: [rule] })[0].ok).toBe(true);
    expect(reviewProposals({ ...base, rules: [rule], envBuilt: 'bugfarm/env-x:1' })[0].errors[0]).toContain('cannot change the next batch');
  });
});

// ---------------------------------------------------------------------------------------------
// Three batches through the foreman, with the real HTTP tool handlers in the middle.

/** Fresh fixes (`a…`), old fixes whose tests no longer fail (`d…`), and fixes the Writer leaks (`e…`). */
function sha(kind: 'a' | 'd' | 'e', batch: number, i: number): string {
  return `${kind}${batch}${i}`.padEnd(40, '0');
}

const SCOUT_LISTS: Record<number, string[]> = {
  1: [sha('a', 1, 1), sha('a', 1, 2), sha('d', 1, 1), sha('d', 1, 2)],
  2: [sha('a', 2, 1), sha('a', 2, 2), sha('a', 2, 3), sha('e', 2, 1), sha('d', 2, 1), sha('d', 2, 2)],
  3: [sha('a', 3, 1), sha('a', 3, 2), sha('e', 3, 1), sha('e', 3, 2), sha('d', 3, 1)],
};

function prOf(s: string): number {
  return Number.parseInt(s.slice(0, 3).replace(/[ade]/, (c) => String('ade'.indexOf(c) + 1)), 10);
}

async function fakeFeatures(_repo: string, s: string): Promise<CandidateFeatures> {
  return { age_days: s.startsWith('d') ? 420 : 15, files: 2, source_file_count: 1, test_file_count: 1, source_files: ['fastapi/routing.py'], test_files: ['tests/test_x.py'], non_test_lines: 6, test_lines: 12 };
}

function itemContext(_repo: string, s: string): ItemContext {
  const check = {
    repo: REPO, sha: s, subject: 'fix', head: HEAD, env_image: 'img', accepted: true, buggy_base: 'head', fix_date: '2026-01-02T00:00:00Z',
    test_targets: ['tests/test_x.py'], fail_to_pass: ['tests/test_x.py::test_symptom'], pass_to_pass: [], flaky_tests: [], suite_modules: ['tests/test_x.py'],
    deselect: [], hidden_test_files: ['tests/test_x.py'], deleted_test_files: [], failing_output: 'AssertionError: 422 != 200', timings: {}, workdir: '/tmp/none',
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

class LearningFloor implements FloorApi {
  started: StartTurnInput[] = [];
  private readonly byKey = new Map<string, string>();
  private readonly turns = new Map<string, TurnInfo>();
  private n = 0;
  tools!: ReturnType<typeof createToolHandlers>;
  answers: Record<string, unknown>[] = [];

  constructor(private readonly store: MemoryStore) {}

  async findAgentByName(name: string): Promise<string | null> {
    return `id-${name}`;
  }

  async startTurn(input: StartTurnInput): Promise<{ turnId: string }> {
    const known = this.byKey.get(input.idempotencyKey);
    if (known) return { turnId: known };
    const turnId = `turn-${++this.n}`;
    this.byKey.set(input.idempotencyKey, turnId);
    this.started.push(input);
    // Done once the agent's tool call has landed, as in Stablehand.
    const done = new Promise<void>((resolve) => setTimeout(() => void this.act(turnId, input).finally(resolve), 0));
    this.turns.set(turnId, { id: turnId, agentId: 'x', status: 'RUNNING', error: null, stopCode: null, costUsd: null, costCoverage: null, tags: input.tags });
    void done.then(() => this.turns.set(turnId, { id: turnId, agentId: 'x', status: 'COMPLETED', error: null, stopCode: null, costUsd: 0.2, costCoverage: 'complete', tags: input.tags }));
    return { turnId };
  }

  private req(turnId: string): IncomingMessage {
    return { headers: { 'x-turn-id': turnId } } as unknown as IncomingMessage;
  }

  private async act(turnId: string, input: StartTurnInput): Promise<void> {
    const { stage, batch } = input.tags;
    if (stage === 'scout') {
      const list = SCOUT_LISTS[Number(batch)] ?? [];
      this.answers.push(await this.tools.handle('submit_candidates', { candidates: list.map((s) => ({ pr: prOf(s), sha: s, title: `🐛 Fix ${s.slice(0, 3)}`, labels: ['bug'] })) }, this.req(turnId)));
    } else if (stage === 'env') {
      await this.store.upsert([{ kind: 'env', key: REPO, payload: { repo: REPO, head: HEAD, tag: 'img', ok: true, dockerfile: 'FROM python', built_by: 'agent', built_at: Date.now() } }]);
    } else if (stage === 'teach') {
      // After batch 1: an age filter for the old fixes. After batch 2: a Writer rule for the leak.
      const rules = batch === '2'
        ? [{ kind: 'scout_filter', text: 'Skip fixes more than 300 days older than HEAD.', skip_if: { field: 'age_days', op: '>', value: 300 }, targets: 'no_fail_to_pass', expected_effect: 'no_fail_to_pass falls to 0.' }]
        : [{ kind: 'writer_rule', text: 'Describe what a user sees; never name a private helper.', targets: 'instruction_leaks_fix', expected_effect: 'No leak rejects.' }];
      // No summary on the second call: the recorded submission then carries summary null.
      this.answers.push(await this.tools.handle('propose_rules', batch === '2' ? { summary: 'batch 1', rules } : { rules }, this.req(turnId)));
    } else {
      const row = await this.store.latest('item', input.tags.item);
      const leaky = String((row?.payload as ItemPayload | undefined)?.sha ?? '').startsWith('e');
      const instruction = leaky ? 'Fix _serialize_response in fastapi/routing.py so it returns b.' : '# Responses come back as 422\n\nPosting a valid form returns 422 instead of 200.';
      await this.store.upsert([{ kind: 'turn', key: turnId, payload: { submission: { instruction }, submissions: 1 } }]);
    }
  }

  async waitForTurn(turnId: string): Promise<TurnInfo> {
    for (let i = 0; i < 200; i++) {
      const info = this.turns.get(turnId);
      if (info && info.status === 'COMPLETED') return info;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`turn ${turnId} never finished`);
  }

  async lookupTurn(turnId: string): Promise<TurnInfo> {
    return this.waitForTurn(turnId);
  }
}

class Jobs {
  private readonly jobs = new Map<string, JobRecord>();

  async submit(kind: JobKind, args: Record<string, unknown>, opts: { id?: string } = {}): Promise<JobRecord> {
    const id = opts.id ?? `${kind}-${this.jobs.size}`;
    const s = String(args.sha ?? '');
    const result: Record<string, unknown> = kind === 'check_candidate'
      ? (s.startsWith('d') ? { accepted: false, reason: 'no_fail_to_pass', detail: 'the tests pass before the fix' } : { accepted: true, sha: s })
      : kind === 'package_task' ? { task_dir: `/tasks/${s.slice(0, 10)}` } : kind === 'run_controls' ? { passed: true, oracle: 1, nop: 0 } : { ok: true, tag: 'img' };
    const job = this.jobs.get(id) ?? ({ id, kind, args, status: 'done', result } as JobRecord);
    this.jobs.set(id, job);
    return job;
  }

  async settle(id: string): Promise<JobRecord> {
    return this.jobs.get(id) as JobRecord;
  }

  async get(id: string): Promise<JobRecord | null> {
    return this.jobs.get(id) ?? null;
  }

  async wait(id: string): Promise<JobRecord | null> {
    return this.jobs.get(id) ?? null;
  }
}

describe('learning loop through the foreman', () => {
  it('learns a filter from batch 1, keeps it on batch 2, reverts a Writer rule on batch 3', async () => {
    const store = new MemoryStore();
    const floor = new LearningFloor(store);
    const jobs = new Jobs();
    const learningLoop = new LearningLoop({ store, features: fakeFeatures, logger: quiet, minDecided: 3 });
    floor.tools = createToolHandlers({ jobs, store, floor, itemContext, learning: learningLoop });
    const foreman = new Foreman({
      store, jobs, floor, calibrate: pendingCalibration, panel: { entries: [] }, envContext, itemContext, logger: quiet, costSettleMs: 0, learning: learningLoop,
      agentNames: { scout: 'bugfarm-scout', env_builder: 'bugfarm-env-builder', writer: 'bugfarm-writer', teacher: 'bugfarm-teacher' },
    });
    const config: CampaignConfig = { ...DEFAULT_CONFIG, repo: REPO, budget_tag: 'learn', batch_size: 4, batches: 3, writer_concurrency: 4 };

    await foreman.launch('c', config);
    await foreman.whenIdle('c');

    expect(store.payload<Record<string, unknown>>('campaign', 'c')).toMatchObject({ status: 'done', learning: { gate: 'controls' } });
    const curve = [1, 2, 3].map((n) => store.payload<{ learning: BatchLearning; campaign?: string; started_at?: number }>('batch', `c:${n}`));
    // Batch 1: 2 of 4 pass; the old fixes fail no_fail_to_pass.
    expect(curve[0]?.learning).toMatchObject({ accepted: 2, decided: 4, share: 0.5, reasons: { no_fail_to_pass: 2 }, teacher: { state: 'done', rules: ['c:rule-b2-1'] } });
    // Batch 2: the age filter drops both old fixes before they become cards; one card leaks.
    expect(curve[1]?.learning).toMatchObject({ accepted: 3, decided: 4, share: 0.75, filtered: 2, filtered_by: { 'c:rule-b2-1': 2 }, reasons: { instruction_leaks_fix: 1 }, rules_served: ['c:rule-b2-1'] });
    expect(curve[1]?.learning.teacher_usd).toBeCloseTo(0.2, 6);
    // The Teacher's turn landed spend on batch 2 before it started; the batch row still got its fields.
    expect(curve[1]).toMatchObject({ campaign: 'c', status: 'done' });
    expect(typeof curve[1]?.started_at).toBe('number');
    // Batch 3: two of four leak; no Teacher after the last batch.
    expect(curve[2]?.learning).toMatchObject({ accepted: 2, decided: 4, filtered: 1, reasons: { instruction_leaks_fix: 2 }, teacher: { state: 'skipped' } });

    const filter = store.payload<Record<string, unknown>>('rule', 'c:rule-b2-1');
    expect(filter).toMatchObject({
      status: 'kept', kind: 'scout_filter', batch_introduced: 2, measured_batch: 2, targets: 'no_fail_to_pass', source: 'teacher', predicate_text: 'age_days > 300',
      effect: { accepted_share_pts: 25, filtered: 2, target_before: { count: 2, decided: 4 }, target_after: { count: 0, decided: 4 }, before: { batch: 1, accepted: 2, decided: 4 }, after: { batch: 2, accepted: 3, decided: 4 } },
    });
    const writerRule = store.payload<Record<string, unknown>>('rule', 'c:rule-b3-1');
    expect(writerRule).toMatchObject({ status: 'reverted', kind: 'writer_rule', measured_batch: 3, effect: { checks: { target_dropped: false, share_improved: false } } });

    // A reverted rule is kept on the board but no longer served; the kept filter still is.
    const playbook = await loadPlaybook(store, REPO);
    expect(playbook.writer_rules.map((r) => r.id)).toEqual([]);
    expect(rulesFor(playbook, 'scout')).toContain('"skip_if"');

    // The Teacher was tagged with the batch whose rules it wrote; its tool calls were answered.
    const teach = floor.started.filter((t) => t.tags.stage === 'teach');
    expect(teach.map((t) => t.tags.batch)).toEqual(['2', '3']);
    expect(teach[0].task).toContain('Learn from Bugfarm batch 1');
    expect(teach[0].task).toContain('"age_days": 420');
    expect(floor.answers.some((a) => typeof a.message === 'string' && a.message.includes('filters dropped 2'))).toBe(true);
    // Features ride on the cards for the receipts.
    expect(store.payload<ItemPayload & { features?: CandidateFeatures }>('item', itemKeyFor('c', REPO, sha('a', 1, 1)))?.features).toMatchObject({ age_days: 15, title_prefix: '🐛', labels: ['bug'], scout_rank: 1 });
  });

  it('refuses propose_rules outside a Teacher turn', async () => {
    const store = new MemoryStore();
    await store.upsert([{ kind: 'turn', key: 't1', payload: { turn_id: 't1', role: 'writer', agent_id: 'a', campaign: 'c', batch: 2, stage: 'write', item: 'i', status: 'running' } }]);
    const tools = createToolHandlers({ jobs: new Jobs(), store, floor: null, itemContext, learning: new LearningLoop({ store, features: fakeFeatures, logger: quiet }) });
    await expect(tools.handle('propose_rules', { rules: [] }, { headers: { 'x-turn-id': 't1' } } as unknown as IncomingMessage)).rejects.toThrow('only works inside a Bugfarm Teacher turn');
  });
});
