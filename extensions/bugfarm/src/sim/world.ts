import type { Stage } from '../shared/board.js';
import type { UpsertInput } from '../store/validate.js';
import { FIX_TEMPLATES, SIM_REPO, fakeSha, renderDiff, type FixTemplate } from './content.js';

/**
 * A synthetic Bugfarm campaign for developing and screen-testing the board.
 * Every payload carries `simulated: true`, and the board shows a banner while
 * any simulated row is current.
 *
 * The shape follows the plan: candidates move Mined → Env ready →
 * Fails→Passes → Controls ✓ → Calibrating → Accepted or Rejected (with a
 * reason), and accepted ones are published after an approval at the end of
 * each batch. Reject rates fall batch over batch, so the learning curve rises.
 */

export const SIM_CAMPAIGN_KEY = 'sim';
const BATCH_SIZE = 16;
const CALIBRATION_HARNESS = 'terminus-2';
const PANEL = [
  { family: 'anthropic', model: 'claude-haiku-4-5', skill: 1.15 },
  { family: 'openai', model: 'gpt-5.4-mini', skill: 1.0 },
  { family: 'google', model: 'gemini-3.1-flash', skill: 0.9 },
  { family: 'open', model: 'glm-5.2', skill: 0.8 },
] as const;
const LADDER_TRIES = 8;

const BENCH_CELLS = [
  { harness: 'claude-code', model: 'claude-sonnet-5', p: 0.58, usd: 0.41 },
  { harness: 'stablehand/claude-agents', model: 'claude-sonnet-5', p: 0.55, usd: 0.38 },
  { harness: 'codex', model: 'gpt-5.6-terra', p: 0.52, usd: 0.33 },
  { harness: 'terminus-2', model: 'claude-sonnet-5', p: 0.49, usd: 0.36 },
  { harness: 'terminus-2', model: 'gpt-5.6-terra', p: 0.46, usd: 0.29 },
  { harness: 'terminus-2', model: 'gemini-3.1-pro', p: 0.41, usd: 0.24 },
  { harness: 'stablehand/pi', model: 'glm-5.2', p: 0.34, usd: 0.07 },
  { harness: 'stablehand/langgraph', model: 'gpt-5.4-mini', p: 0.27, usd: 0.06 },
  { harness: 'terminus-2', model: 'glm-5.2', p: 0.29, usd: 0.06 },
] as const;

const SEED_RULES = [
  { key: 'r1', text: 'Skip commits whose test changes only touch fixtures or snapshots', kind: 'scout_filter', batch: 1, status: 'kept', pts: 5.1, usd: -0.62 },
  { key: 'r2', text: 'Name the failing function in the task instruction', kind: 'writer_rule', batch: 2, status: 'reverted', pts: -1.4, usd: 0.21 },
  { key: 'r3', text: 'Run each fail→pass test 3 times with a pinned random seed before calling it flaky', kind: 'env_recipe', batch: 2, status: 'kept', pts: 4.2, usd: -0.35 },
  { key: 'r4', text: 'Skip fixes that touch more than three source files', kind: 'scout_filter', batch: 3, status: 'kept', pts: 3.0, usd: -0.41 },
] as const;

const TRIAL_RULES = [
  { text: 'Install the optional test extras before the first suite run', kind: 'env_recipe' },
  { text: 'Drop candidates whose only test change is a renamed assertion', kind: 'scout_filter' },
  { text: 'Describe the symptom, never the location, in task instructions', kind: 'writer_rule' },
  { text: 'Skip commits that only bump a dependency pin', kind: 'scout_filter' },
  { text: 'Cache the wheel directory between env builds of the same lockfile', kind: 'env_recipe' },
] as const;

/** Seeded history: accepted share 22% → 30% → 36%, dollars per accepted falling. */
const SEED_BATCHES = [
  { n: 1, accepted: 4, rejected: 12, cost: 31.4 },
  { n: 2, accepted: 5, rejected: 11, cost: 27.9 },
  { n: 3, accepted: 6, rejected: 10, cost: 25.2 },
] as const;

interface BenchCell {
  harness: string;
  model: string;
  p: number;
  usd: number;
  solved: number;
  attempts: number;
  cost: number;
}

type Fate =
  | { kind: 'reject'; at: Stage; reason: string }
  | { kind: 'calibrate'; outcome: 'accept' | 'too_easy' | 'unsolved_broken' };

interface SimItem {
  key: string;
  batch: number;
  stage: Stage;
  nextAt: number;
  fate: Fate;
  template: FixTemplate;
  sha: string;
  cost: number;
  tries: Record<string, number>;
  passes: Record<string, number>;
  solveP: Record<string, number>;
  ladderTarget: number;
  rejectReason: string | null;
}

/** mulberry32: small, fast, deterministic. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const round4 = (value: number) => Math.round(value * 10000) / 10000;

/** Wilson score interval, 95%. */
export function wilson(solved: number, attempts: number): [number, number] {
  if (attempts === 0) return [0, 1];
  const z = 1.96;
  const p = solved / attempts;
  const denom = 1 + (z * z) / attempts;
  const centre = (p + (z * z) / (2 * attempts)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / attempts + (z * z) / (4 * attempts * attempts))) / denom;
  return [Math.max(0, round4(centre - half)), Math.min(1, round4(centre + half))];
}

export interface SimWorldOptions {
  seed?: number;
  /** 2 means twice as fast. */
  speed?: number;
}

export class SimWorld {
  private readonly random: () => number;
  private readonly speed: number;
  private readonly items = new Map<string, SimItem>();
  private batch = 4;
  private spawned = 0;
  private nextSpawnAt = 0;
  private spend = 0;
  private batchCost = 0;
  private batchAccepted = 0;
  private batchRejected = 0;
  private batchStartedAt = 0;
  private phase: 'running' | 'approval' | 'publishing' = 'running';
  private phaseAt = 0;
  private publishQueue: string[] = [];
  private trialRuleKey: string | null = null;
  private trialIndex = 0;
  private previousShare = 6 / 16;
  private previousUsdPerAccepted = 25.2 / 6;
  private nextBenchAt = 0;
  private serial = 0;
  private readonly cells: BenchCell[] = BENCH_CELLS.map((cell) => ({ ...cell, solved: 0, attempts: 0, cost: 0 }));

  constructor(options: SimWorldOptions = {}) {
    this.random = seededRandom(options.seed ?? 20261023);
    this.speed = options.speed && options.speed > 0 ? options.speed : 1;
  }

  private ms(seconds: number): number {
    return (seconds * 1000) / this.speed;
  }

  private between(min: number, max: number): number {
    return min + this.random() * (max - min);
  }

  private pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.random() * list.length)];
  }

  /** Everything the board needs before the live batch starts. */
  seed(now: number): UpsertInput[][] {
    const rows: UpsertInput[] = [];
    const unattendedSince = now - (7 * 3600 + 12 * 60) * 1000;
    this.spend = SEED_BATCHES.reduce((sum, batch) => sum + batch.cost, 0) + 61.8;

    for (const batch of SEED_BATCHES) {
      const startedAt = unattendedSince + (batch.n - 1) * 2.2 * 3600 * 1000;
      rows.push({
        kind: 'batch',
        key: String(batch.n),
        mode: 'replace',
        payload: {
          n: batch.n,
          candidates: batch.accepted + batch.rejected,
          accepted: batch.accepted,
          rejected: batch.rejected,
          cost_usd: batch.cost,
          status: 'done',
          started_at: startedAt,
          finished_at: startedAt + 2 * 3600 * 1000,
          simulated: true,
        },
      });
    }
    for (const rule of SEED_RULES) {
      rows.push({
        kind: 'rule',
        key: rule.key,
        mode: 'replace',
        payload: {
          text: rule.text,
          kind: rule.kind,
          batch_introduced: rule.batch,
          measured_batch: rule.batch + 1,
          status: rule.status,
          effect: {
            accepted_share_pts: rule.pts,
            usd_per_accepted: rule.usd,
            summary: rule.status === 'kept' ? 'Improved the next batch' : 'No gain on the next batch',
          },
          simulated: true,
        },
      });
    }

    // Finished items from earlier batches: published accepts and dated rejects.
    const history: UpsertInput[] = [];
    for (const batch of SEED_BATCHES) {
      const startedAt = unattendedSince + (batch.n - 1) * 2.2 * 3600 * 1000;
      for (let i = 0; i < batch.accepted + batch.rejected; i += 1) {
        const accepted = i < batch.accepted;
        const item = this.newItem(batch.n, startedAt + i * 6 * 60 * 1000);
        const times: Partial<Record<Stage, number>> = {};
        let t = startedAt + i * 6 * 60 * 1000;
        const path: Stage[] = accepted
          ? ['mined', 'env_ready', 'fail_pass', 'controls', 'calibrating', 'accepted', 'published']
          : ['mined', 'env_ready', 'fail_pass'];
        for (const stage of path) {
          times[stage] = t;
          t += this.between(2, 9) * 60 * 1000;
        }
        if (accepted) {
          this.runLadderInstantly(item, 'accept', history, times.calibrating ?? t);
          item.stage = 'published';
        } else {
          const reason = this.pick(['no_fail_to_pass', 'flaky', 'env_build_failed', 'too_easy', 'instruction_leaks_fix', 'no_fail_to_pass', 'unsolved_broken', 'nop_passed']);
          if (reason === 'too_easy' || reason === 'unsolved_broken') {
            times.controls = t;
            times.calibrating = t + 60_000;
            this.runLadderInstantly(item, reason, history, t + 60_000);
          }
          times.rejected = t + 5 * 60 * 1000;
          item.stage = 'rejected';
          item.rejectReason = reason;
        }
        item.cost = round2(item.cost + this.between(0.08, 0.3));
        rows.push(this.itemRow(item, { stage_times: times }));
      }
    }

    for (const cell of this.cells) {
      cell.attempts = 40 + Math.floor(this.random() * 30);
      cell.solved = Math.round(cell.attempts * (cell.p + this.between(-0.04, 0.04)));
      cell.cost = cell.solved * cell.usd;
      rows.push(this.cellRow(cell));
    }

    this.batchStartedAt = now;
    this.nextSpawnAt = now;
    this.nextBenchAt = now + this.ms(4);
    rows.push(this.startTrialRule());
    rows.push(this.batchRow(now));
    rows.push(this.campaignRow({
      name: 'pyline overnight',
      repo: SIM_REPO,
      cap_usd: 500,
      started_at: unattendedSince - 9 * 60 * 1000,
      unattended_since: unattendedSince,
      recovered_from_crash: 1,
      status: 'running',
      approval: null,
    }));

    // The ledger history goes in its own calls to keep each request small.
    const chunks: UpsertInput[][] = [rows];
    for (let i = 0; i < history.length; i += 250) chunks.push(history.slice(i, i + 250));
    return chunks;
  }

  private newItem(batch: number, _at: number): SimItem {
    this.serial += 1;
    const template = FIX_TEMPLATES[(this.serial * 7 + batch) % FIX_TEMPLATES.length];
    const sha = fakeSha(this.random);
    const solveP: Record<string, number> = {};
    for (const member of PANEL) solveP[member.family] = 0;
    return {
      key: `pyline@${sha.slice(0, 10)}`,
      batch,
      stage: 'mined',
      nextAt: 0,
      fate: { kind: 'calibrate', outcome: 'accept' },
      template,
      sha,
      cost: 0,
      tries: {},
      passes: {},
      solveP,
      ladderTarget: LADDER_TRIES,
      rejectReason: null,
    };
  }

  /** Fates get kinder as the factory learns: each batch rejects less. */
  private decideFate(batch: number): Fate {
    // Gains flatten out after a few batches, as real filters do.
    const learned = Math.max(0.62, Math.pow(0.88, batch - 1));
    const roll = this.random();
    const table: [number, Fate][] = [
      [0.12 * learned, { kind: 'reject', at: 'mined', reason: 'env_build_failed' }],
      [0.18 * learned, { kind: 'reject', at: 'env_ready', reason: 'no_fail_to_pass' }],
      [0.08 * learned, { kind: 'reject', at: 'env_ready', reason: 'flaky' }],
      [0.05 * learned, { kind: 'reject', at: 'env_ready', reason: 'reverse_patch_conflict' }],
      [0.03, { kind: 'reject', at: 'fail_pass', reason: 'oracle_failed' }],
      [0.04, { kind: 'reject', at: 'fail_pass', reason: 'nop_passed' }],
      [0.06 * learned, { kind: 'reject', at: 'fail_pass', reason: 'instruction_leaks_fix' }],
      [0.14, { kind: 'calibrate', outcome: 'too_easy' }],
      [0.08 * learned, { kind: 'calibrate', outcome: 'unsolved_broken' }],
    ];
    let edge = 0;
    for (const [p, fate] of table) {
      edge += p;
      if (roll < edge) return fate;
    }
    return { kind: 'calibrate', outcome: 'accept' };
  }

  private setSolveRates(item: SimItem, outcome: 'accept' | 'too_easy' | 'unsolved_broken'): void {
    for (const member of PANEL) {
      if (outcome === 'too_easy') item.solveP[member.family] = 0.97;
      else if (outcome === 'unsolved_broken') item.solveP[member.family] = 0;
      else item.solveP[member.family] = Math.min(0.6, this.between(0.05, 0.42) * member.skill);
    }
    item.ladderTarget = outcome === 'too_easy' ? 2 : LADDER_TRIES;
  }

  private runLadderInstantly(item: SimItem, outcome: 'accept' | 'too_easy' | 'unsolved_broken', out: UpsertInput[], at: number): void {
    this.setSolveRates(item, outcome);
    let t = at;
    let total = 0;
    for (let i = 0; i < item.ladderTarget * PANEL.length; i += 1) {
      const attempt = this.attempt(item, t);
      if (attempt) {
        out.push(attempt.row);
        total += attempt.cost;
      }
      t += 40_000;
    }
    if (outcome === 'accept' && Object.values(item.passes).every((count) => count === 0)) {
      item.passes[PANEL[0].family] = 1;
    }
    item.cost = round2(item.cost + total);
  }

  /** One calibration attempt on the family with the fewest tries. */
  private attempt(item: SimItem, at: number): { row: UpsertInput; cost: number } | null {
    const member = [...PANEL]
      .filter((entry) => (item.tries[entry.family] ?? 0) < item.ladderTarget)
      .sort((a, b) => (item.tries[a.family] ?? 0) - (item.tries[b.family] ?? 0))[0];
    if (!member) return null;
    const tryNumber = (item.tries[member.family] ?? 0) + 1;
    item.tries[member.family] = tryNumber;
    const errored = this.random() < 0.04;
    const passed = !errored && this.random() < item.solveP[member.family];
    if (passed) item.passes[member.family] = (item.passes[member.family] ?? 0) + 1;
    const cost = round4(this.between(0.015, 0.11) * (member.family === 'open' ? 0.3 : 1));
    return {
      cost,
      row: {
        kind: 'attempt',
        key: `${item.key}:${CALIBRATION_HARNESS}:${member.model}:${tryNumber}`,
        mode: 'replace',
        payload: {
          item: item.key,
          harness: CALIBRATION_HARNESS,
          model: member.model,
          family: member.family,
          try: tryNumber,
          result: errored ? 'error' : passed ? 'pass' : 'fail',
          cost_usd: cost,
          seconds: Math.round(this.between(35, passed ? 260 : 420)),
          phase: 'calibration',
          at,
          simulated: true,
        },
      },
    };
  }

  private difficulty(item: SimItem): Record<string, { passes: number; attempts: number }> {
    const out: Record<string, { passes: number; attempts: number }> = {};
    for (const member of PANEL) {
      const attempts = item.tries[member.family] ?? 0;
      if (attempts > 0) out[member.family] = { passes: item.passes[member.family] ?? 0, attempts };
    }
    return out;
  }

  private itemRow(item: SimItem, extra: Record<string, unknown> = {}): UpsertInput {
    const testFile = item.template.test;
    const rendered = renderDiff(item.template, 40 + (item.sha.charCodeAt(0) % 60));
    return {
      kind: 'item',
      key: item.key,
      mode: 'merge',
      payload: {
        stage: item.stage,
        reject_reason: item.rejectReason,
        repo: SIM_REPO,
        sha: item.sha,
        title: item.template.title,
        batch: item.batch,
        diff: rendered.diff,
        diff_stats: rendered.stats,
        failing_tests: [testFile],
        failing_output: `FAILED ${testFile}\n${item.template.failure}`,
        difficulty: this.difficulty(item),
        cost_usd: round2(item.cost),
        simulated: true,
        ...extra,
      },
    };
  }

  private cellRow(cell: BenchCell): UpsertInput {
    const [low, high] = wilson(cell.solved, cell.attempts);
    return {
      kind: 'cell',
      key: `${cell.harness}:${cell.model}`,
      mode: 'replace',
      payload: {
        harness: cell.harness,
        model: cell.model,
        solved: cell.solved,
        attempts: cell.attempts,
        tasks: 15,
        pass_at_1: cell.attempts > 0 ? round4(cell.solved / cell.attempts) : 0,
        ci_low: low,
        ci_high: high,
        usd_per_solve: cell.solved > 0 ? round2(cell.cost / cell.solved) : null,
        cost_usd: round2(cell.cost),
        simulated: true,
      },
    };
  }

  private batchRow(now: number, done = false): UpsertInput {
    return {
      kind: 'batch',
      key: String(this.batch),
      mode: 'merge',
      payload: {
        n: this.batch,
        candidates: BATCH_SIZE,
        accepted: this.batchAccepted,
        rejected: this.batchRejected,
        cost_usd: round2(this.batchCost),
        status: done ? 'done' : 'running',
        started_at: this.batchStartedAt,
        finished_at: done ? now : null,
        simulated: true,
      },
    };
  }

  private campaignRow(extra: Record<string, unknown> = {}): UpsertInput {
    return {
      kind: 'campaign',
      key: SIM_CAMPAIGN_KEY,
      mode: 'merge',
      payload: { spend_usd: round2(this.spend), batch: this.batch, simulated: true, ...extra },
    };
  }

  private startTrialRule(): UpsertInput {
    const rule = TRIAL_RULES[this.trialIndex % TRIAL_RULES.length];
    this.trialIndex += 1;
    this.trialRuleKey = `t${this.batch}`;
    return {
      kind: 'rule',
      key: this.trialRuleKey,
      mode: 'replace',
      payload: { text: rule.text, kind: rule.kind, batch_introduced: this.batch, status: 'trial', effect: null, simulated: true },
    };
  }

  private spendOn(item: SimItem, usd: number): void {
    item.cost += usd;
    this.spend += usd;
    this.batchCost += usd;
  }

  private nextStage(stage: Stage): Stage {
    const order: Stage[] = ['mined', 'env_ready', 'fail_pass', 'controls', 'calibrating'];
    return order[order.indexOf(stage) + 1] ?? 'calibrating';
  }

  /** Advance the world to `now` and return the rows that changed. */
  tick(now: number): UpsertInput[] {
    const rows: UpsertInput[] = [];
    let batchChanged = false;

    if (this.phase === 'running' && this.spawned < BATCH_SIZE && now >= this.nextSpawnAt) {
      const item = this.newItem(this.batch, now);
      item.fate = this.decideFate(this.batch);
      item.nextAt = now + this.ms(this.between(2.5, 5));
      this.spendOn(item, this.between(0.01, 0.03));
      this.items.set(item.key, item);
      this.spawned += 1;
      this.nextSpawnAt = now + this.ms(this.between(1.6, 3.4));
      rows.push(this.itemRow(item));
    }

    for (const item of this.items.values()) {
      if (item.stage === 'accepted' || item.stage === 'rejected' || item.stage === 'published') continue;
      if (item.stage === 'calibrating') {
        if (now < item.nextAt) continue;
        const results: UpsertInput[] = [];
        for (let i = 0; i < 2; i += 1) {
          const attempt = this.attempt(item, now);
          if (!attempt) break;
          this.spendOn(item, attempt.cost);
          results.push(attempt.row);
        }
        rows.push(...results);
        item.nextAt = now + this.ms(this.between(0.6, 1.1));
        if (results.length === 0) {
          const outcome = item.fate.kind === 'calibrate' ? item.fate.outcome : 'accept';
          if (outcome === 'accept') {
            if (Object.values(item.passes).every((count) => count === 0)) item.passes[PANEL[0].family] = 1;
            item.stage = 'accepted';
            this.batchAccepted += 1;
          } else {
            item.stage = 'rejected';
            item.rejectReason = outcome;
            this.batchRejected += 1;
          }
          batchChanged = true;
        }
        rows.push(this.itemRow(item));
        continue;
      }
      if (now < item.nextAt) continue;
      if (item.fate.kind === 'reject' && item.fate.at === item.stage) {
        item.stage = 'rejected';
        item.rejectReason = item.fate.reason;
        this.batchRejected += 1;
        batchChanged = true;
        this.spendOn(item, this.between(0.02, 0.09));
        rows.push(this.itemRow(item, { reject_detail: rejectDetail(item.fate.reason) }));
        continue;
      }
      item.stage = this.nextStage(item.stage);
      this.spendOn(item, item.stage === 'env_ready' ? this.between(0.05, 0.16) : this.between(0.01, 0.05));
      if (item.stage === 'calibrating' && item.fate.kind === 'calibrate') this.setSolveRates(item, item.fate.outcome);
      item.nextAt = now + this.ms(item.stage === 'calibrating' ? this.between(0.8, 1.6) : this.between(2.6, 6));
      rows.push(this.itemRow(item));
    }

    const decided = this.batchAccepted + this.batchRejected;
    if (this.phase === 'running' && decided >= BATCH_SIZE) {
      rows.push(this.batchRow(now, true));
      rows.push(...this.measureTrialRule());
      rows.push(this.campaignRow({ approval: { state: 'waiting', tool: 'request-approval', requested_at: now } }));
      this.phase = 'approval';
      this.phaseAt = now + this.ms(5);
      batchChanged = false;
    } else if (this.phase === 'approval' && now >= this.phaseAt) {
      rows.push(this.campaignRow({ approval: { state: 'approved', resolved_at: now } }));
      this.publishQueue = [...this.items.values()].filter((item) => item.stage === 'accepted').map((item) => item.key);
      this.phase = 'publishing';
      this.phaseAt = now;
    } else if (this.phase === 'publishing' && now >= this.phaseAt) {
      const key = this.publishQueue.shift();
      if (key) {
        const item = this.items.get(key);
        if (item) {
          item.stage = 'published';
          rows.push(this.itemRow(item));
        }
        this.phaseAt = now + this.ms(0.7);
      } else {
        rows.push(...this.startNextBatch(now));
      }
    }

    if (now >= this.nextBenchAt) {
      const cell = this.pick(this.cells);
      const runs = 1 + Math.floor(this.random() * 3);
      for (let i = 0; i < runs; i += 1) {
        cell.attempts += 1;
        if (this.random() < cell.p) {
          cell.solved += 1;
          cell.cost += cell.usd;
        }
      }
      this.spend += runs * cell.usd * cell.p;
      rows.push(this.cellRow(cell));
      this.nextBenchAt = now + this.ms(this.between(2.5, 5));
    }

    if (batchChanged) rows.push(this.batchRow(now));
    if (rows.length > 0) rows.push(this.campaignRow());
    return rows;
  }

  private measureTrialRule(): UpsertInput[] {
    if (!this.trialRuleKey) return [];
    const share = this.batchAccepted / BATCH_SIZE;
    const usdPerAccepted = this.batchAccepted > 0 ? this.batchCost / this.batchAccepted : this.previousUsdPerAccepted;
    const pts = Math.round((share - this.previousShare) * 1000) / 10;
    const usd = round2(usdPerAccepted - this.previousUsdPerAccepted);
    const kept = pts > 0 || usd < 0;
    this.previousShare = share;
    this.previousUsdPerAccepted = usdPerAccepted;
    return [{
      kind: 'rule',
      key: this.trialRuleKey,
      mode: 'merge',
      payload: {
        status: kept ? 'kept' : 'reverted',
        measured_batch: this.batch,
        effect: {
          accepted_share_pts: pts,
          usd_per_accepted: usd,
          summary: kept ? 'Improved this batch' : 'No gain on this batch',
        },
        simulated: true,
      },
    }];
  }

  private startNextBatch(now: number): UpsertInput[] {
    this.batch += 1;
    this.spawned = 0;
    this.batchAccepted = 0;
    this.batchRejected = 0;
    this.batchCost = 0;
    this.batchStartedAt = now;
    this.nextSpawnAt = now + this.ms(1.5);
    this.phase = 'running';
    for (const [key, item] of this.items) {
      if (item.stage === 'published' || item.stage === 'rejected') this.items.delete(key);
    }
    return [this.startTrialRule(), this.batchRow(now), this.campaignRow({ approval: null })];
  }
}

function rejectDetail(reason: string): string {
  switch (reason) {
    case 'env_build_failed': return 'pip could not resolve the pinned build backend after 3 tries';
    case 'no_fail_to_pass': return 'Every selected test also passes on the buggy state';
    case 'flaky': return 'The target test passed 2 of 3 runs on the fixed state';
    case 'reverse_patch_conflict': return 'The fix no longer reverse-applies at HEAD';
    case 'oracle_failed': return 'Applying the reference fix leaves one test failing';
    case 'nop_passed': return 'An agent that changes nothing scores 1';
    case 'instruction_leaks_fix': return 'The instruction names the changed condition';
    default: return '';
  }
}
