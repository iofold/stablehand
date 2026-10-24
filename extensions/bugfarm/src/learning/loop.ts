import { BudgetBlockedError } from '../floor/api.js';
import type { CampaignConfig, ScoutCandidate } from '../foreman/foreman.js';
import { loadPlaybook, RULE_KINDS } from '../playbook.js';
import type { AttemptPayload, BoardRow, ItemPayload, RowKind, RulePayload, TurnPayload } from '../shared/board.js';
import type { BatchLearning, LearningGate } from '../shared/learning.js';
import { describePredicate, matches, type CandidateFeatures, type Predicate } from '../shared/predicate.js';
import type { UpsertInput } from '../store/validate.js';
import { extrasFromRaw, textFeatures, type GitFeatures } from './features.js';
import { judgeRule, MIN_DECIDED, poolBatches } from './lifecycle.js';
import { batchMetrics, gateFromItems, passedControls } from './metrics.js';
import { MAX_RULES_PER_BATCH, ProposeRulesSchema, reviewProposals, type ExistingRule, type Proposal, type ProposalCard, type ProposalReport } from './proposals.js';
import { teacherTask, type TeacherCard, type TeacherRule } from './teacher-task.js';

/**
 * Bugfarm's learning loop. The foreman calls `afterBatch` when a batch finishes, before the next
 * batch's Scout turn:
 *
 * 1. attach each card's features (git and the Scout's text) to its row;
 * 2. compute the batch's learning numbers at the campaign's gate and write them on its `batch` row:
 *    the curve the Learning tab charts;
 * 3. measure the rules that were on trial in this batch against the batch before: kept or
 *    reverted, with the deltas and both batches' numbers on the rule row;
 * 4. unless this was the last batch, run the Teacher: it reads the batch's cards and proposes at
 *    most three rules through `propose_rules`, which go on trial in the next batch.
 *
 * The HTTP tools call `screen` (Scout filters with `skip_if` drop candidates before they become
 * cards) and `review` (the Teacher's proposals, checked against its batch).
 *
 * Every step is recomputed from the board rows and written idempotently, so a worker killed in the
 * middle repeats it on restart with the same result; the Teacher's turn goes through the
 * foreman's crash-safe turn bookkeeping.
 */

export interface LearningStore {
  upsert(rows: UpsertInput[]): Promise<unknown>;
  latest(kind: RowKind, key: string): Promise<BoardRow | null>;
  currentOfKind<K extends RowKind>(kind: K): Promise<BoardRow<K>[]>;
}

interface Logger {
  log(message: string): void;
  warn(message: string, ...args: unknown[]): void;
}

export interface LearningDeps {
  store: LearningStore;
  features: GitFeatures;
  /** A trial with fewer decided candidates is pooled with the next batch (default MIN_DECIDED). */
  minDecided?: number;
  logger?: Logger;
  now?: () => number;
}

export interface TeacherTurnResult {
  submission: Record<string, unknown> | null;
  status: string;
  turnId: string;
}

/** What the foreman hands over when a batch finishes. */
export interface BatchEnd {
  campaignId: string;
  batch: number;
  /** The campaign's last batch: measured, but no Teacher turn (nothing would run its rules). */
  last: boolean;
  config: CampaignConfig;
  /** Runs the Teacher's turn through the foreman, tagged with the next batch (which its rules serve). */
  runTeacherTurn: (task: () => Promise<string>) => Promise<TeacherTurnResult>;
}

export interface ScreenResult {
  kept: ScoutCandidate[];
  skipped: Array<{ pr: number; sha: string; title: string; rule: string; predicate: string }>;
  /** Labels and rank by PR number, from the Scout's raw list. */
  extras: Record<string, { labels: string[] | null; rank: number }>;
  /** Features computed while screening, by PR number. */
  features: Record<string, CandidateFeatures>;
}

interface LearningItem extends ItemPayload {
  features?: CandidateFeatures;
  pr_body?: string | null;
  issue_body?: string | null;
  step?: string;
}

type Row<T> = { key: string; payload: T };

const DETAIL_CHARS = 600;

function clip(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function ruleKey(campaignId: string, batch: number, index: number): string {
  return `${campaignId}:rule-b${batch}-${index + 1}`;
}

export class LearningLoop {
  constructor(private readonly deps: LearningDeps) {}

  private get logger(): Logger {
    return this.deps.logger ?? console;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async rows<T>(kind: RowKind, filter: (payload: T) => boolean = () => true): Promise<Array<Row<T>>> {
    return (await this.deps.store.currentOfKind(kind))
      .map((row) => ({ key: row.key, payload: row.payload as T }))
      .filter((row) => filter(row.payload));
  }

  private async payload<T>(kind: RowKind, key: string): Promise<T | null> {
    const row = await this.deps.store.latest(kind, key);
    return row ? (row.payload as T) : null;
  }

  // ------------------------------------------------------------------------------------------
  // After a batch

  async afterBatch(end: BatchEnd): Promise<void> {
    if (end.config.learning === false) return;
    const { campaignId: id, batch: n } = end;
    const repo = end.config.repo;
    const batchKey = `${id}:${n}`;

    const items = await this.rows<LearningItem>('item', (p) => p.campaign === id);
    const own = items.filter((row) => row.payload.batch === n);
    await this.attachFeatures(id, n, repo, own);

    const gate = await this.gateFor(id, end.config, own.map((row) => row.payload));
    const metrics = await this.metricsFor(id, n, gate, repo);
    const stored = (await this.payload<{ learning?: BatchLearning }>('batch', batchKey))?.learning;
    await this.deps.store.upsert([{ kind: 'batch', key: batchKey, payload: { n, learning: { ...metrics, teacher: stored?.teacher ?? null } } }]);

    await this.measureTrials(id, n, metrics, end.last);
    this.logger.log(`[bugfarm] learning: batch ${n} of ${id}: ${metrics.accepted}/${metrics.decided} ${gate === 'controls' ? 'passed the checks' : 'accepted'}, $${metrics.cost_usd.toFixed(2)}${metrics.usd_per_accepted === null ? '' : ` ($${metrics.usd_per_accepted.toFixed(2)} each)`}, rejects ${JSON.stringify(metrics.reasons)}`);

    if (stored?.teacher && stored.teacher.state !== 'failed') return;
    await this.teach(end, metrics);
  }

  /** The gate a campaign measures at: fixed in its config, or picked from its first batch and kept. */
  private async gateFor(id: string, config: CampaignConfig, items: ItemPayload[]): Promise<LearningGate> {
    if (config.learning_gate === 'controls' || config.learning_gate === 'calibration') return config.learning_gate;
    const campaign = await this.payload<{ learning?: { gate?: LearningGate } }>('campaign', id);
    const known = campaign?.learning?.gate;
    if (known === 'controls' || known === 'calibration') return known;
    const gate = gateFromItems(items);
    await this.deps.store.upsert([{ kind: 'campaign', key: id, payload: { learning: { gate } } }]);
    return gate;
  }

  private async metricsFor(id: string, n: number, gate: LearningGate, repo: string): Promise<BatchLearning> {
    const items = await this.rows<LearningItem>('item', (p) => p.campaign === id);
    const turns = (await this.rows<TurnPayload>('turn', (p) => p.campaign === id)).map((row) => row.payload);
    const ownKeys = items.filter((row) => row.payload.batch === n).map((row) => row.key);
    const attempts = (await this.rows<AttemptPayload>('attempt', (p) => ownKeys.includes(p.item))).map((row) => row.payload);
    const filteredBy: Record<string, number> = {};
    let filtered = 0;
    for (const turn of turns) {
      if (turn.role !== 'scout' || turn.batch !== n) continue;
      const skipped = (turn.submission as { skipped?: Array<{ rule?: string }> } | null | undefined)?.skipped ?? [];
      for (const entry of skipped) {
        filtered++;
        if (entry.rule) filteredBy[entry.rule] = (filteredBy[entry.rule] ?? 0) + 1;
      }
    }
    const rules = await loadPlaybook(this.deps.store, repo);
    const served = [...rules.scout_filters, ...rules.writer_rules, ...rules.env_recipes].map((rule) => rule.id);
    return batchMetrics({
      batch: n,
      gate,
      items: items.map((row) => row.payload),
      turns,
      attempts,
      itemKeys: ownKeys,
      filtered,
      filteredBy,
      rulesServed: served,
      now: this.now(),
    });
  }

  /**
   * Measure the rules on trial in this campaign against the batch before their trial began, as
   * the batch rows recorded them. A trial that is still too small pools every batch since.
   */
  private async measureTrials(id: string, n: number, current: BatchLearning, last: boolean): Promise<void> {
    const trials = await this.rows<RulePayload>('rule', (p) => !p.simulated && p.campaign === id && p.status === 'trial' && p.batch_introduced >= 2 && p.batch_introduced <= n);
    if (trials.length === 0) return;
    const learningOf = async (b: number) => (b === n ? current : (await this.payload<{ learning?: BatchLearning }>('batch', `${id}:${b}`))?.learning ?? null);
    const rows: UpsertInput[] = [];
    for (const rule of trials) {
      const start = rule.payload.batch_introduced;
      const before = await learningOf(start - 1);
      const trialBatches: BatchLearning[] = [];
      for (let b = start; b <= n; b++) {
        const batch = await learningOf(b);
        if (batch) trialBatches.push(batch);
      }
      if (!before || trialBatches.length === 0) {
        this.logger.warn(`[bugfarm] learning: no numbers for batch ${start - 1} of ${id}; rule ${rule.key} stays on trial`);
        continue;
      }
      const after = trialBatches.length === 1 ? trialBatches[0] : poolBatches(trialBatches);
      const verdict = judgeRule({
        target: rule.payload.targets,
        before,
        after,
        ...(rule.payload.kind === 'scout_filter' && rule.payload.skip_if ? { filtered: after.filtered_by[rule.key] ?? 0 } : {}),
        measuredWith: trials.filter((other) => other.key !== rule.key && other.payload.batch_introduced === start).map((other) => other.key),
        minDecided: this.deps.minDecided ?? MIN_DECIDED,
        final: last,
      });
      rows.push({
        kind: 'rule',
        key: rule.key,
        payload: { status: verdict.status, measured_batch: verdict.status === 'trial' ? null : n, measured_at: this.now(), effect: verdict.effect as Record<string, unknown> },
      });
      this.logger.log(`[bugfarm] learning: rule ${rule.key} ${verdict.status === 'trial' ? 'stays on trial' : verdict.status}: ${verdict.effect.summary}`);
    }
    await this.deps.store.upsert(rows);
  }

  /** Features for every card of the batch that has none yet: git (from the worker's clone) plus the Scout's text. */
  private async attachFeatures(id: string, n: number, repo: string, own: Array<Row<LearningItem>>): Promise<void> {
    const scoutTurns = (await this.rows<TurnPayload>('turn', (p) => p.campaign === id && p.role === 'scout' && p.batch === n)).map((row) => row.payload);
    const extras: ScreenResult['extras'] = {};
    const screened: ScreenResult['features'] = {};
    // The card's title has its emoji stripped; the Scout's submission keeps the title as written.
    const submitted = new Map<string, ScoutCandidate>();
    for (const turn of scoutTurns) {
      const submission = turn.submission as (Partial<ScreenResult> & { candidates?: ScoutCandidate[] }) | null | undefined;
      Object.assign(extras, submission?.extras ?? {});
      Object.assign(screened, submission?.features ?? {});
      for (const candidate of submission?.candidates ?? []) submitted.set(String(candidate.pr), candidate);
    }
    const rows: UpsertInput[] = [];
    for (const row of own) {
      const item = row.payload;
      if (item.features && Object.keys(item.features).length > 0) continue;
      const pr = typeof item.pr === 'number' ? String(item.pr) : '';
      let git: CandidateFeatures | null = screened[pr] ?? null;
      if (!git && item.sha) {
        try {
          git = await this.deps.features(repo, item.sha);
        } catch (err) {
          this.logger.warn(`[bugfarm] learning: features for ${row.key} failed: ${(err as Error).message}`);
        }
      }
      const text = textFeatures({
        title: submitted.get(pr)?.title ?? item.title ?? '',
        labels: extras[pr]?.labels ?? null,
        issue: item.issue ?? null,
        pr_body: item.pr_body ?? null,
        issue_body: item.issue_body ?? null,
        rank: extras[pr]?.rank ?? null,
      });
      rows.push({ kind: 'item', key: row.key, payload: { features: { ...(git ?? {}), ...text } } });
      row.payload = { ...item, features: { ...(git ?? {}), ...text } };
    }
    if (rows.length > 0) await this.deps.store.upsert(rows);
  }

  private async teach(end: BatchEnd, learning: BatchLearning): Promise<void> {
    const { campaignId: id, batch: n } = end;
    const batchKey = `${id}:${n}`;
    const record = (teacher: BatchLearning['teacher']) => this.deps.store.upsert([{ kind: 'batch', key: batchKey, payload: { learning: { teacher } } }]);
    if (end.last) {
      await record({ state: 'skipped', note: 'last batch of the campaign: no batch left to run new rules' });
      return;
    }
    const rejects = Object.values(learning.reasons).reduce((sum, count) => sum + count, 0);
    if (rejects === 0) {
      await record({ state: 'skipped', note: 'nothing was rejected, so there is nothing to learn from' });
      this.logger.log(`[bugfarm] learning: batch ${n} of ${id} had no rejects; no Teacher turn`);
      return;
    }
    try {
      const result = await end.runTeacherTurn(() => this.teacherTaskFor(end, learning));
      const proposal = this.proposalFrom(result.submission);
      const context = await this.reviewContext(id, n, end.config.repo);
      const reports = reviewProposals({ rules: proposal.rules, batch: n, reasons: context.reasons, cards: context.cards, existing: context.existing, envBuilt: context.envBuilt });
      const ok = reports.filter((report): report is ProposalReport & { rule: Proposal } => report.ok && Boolean(report.rule)).slice(0, MAX_RULES_PER_BATCH);
      const rows: UpsertInput[] = ok.map((report, index) => ({
        kind: 'rule',
        key: ruleKey(id, n + 1, index),
        payload: {
          text: report.rule.text,
          kind: report.rule.kind,
          batch_introduced: n + 1,
          learned_from_batch: n,
          status: 'trial',
          campaign: id,
          repo: end.config.repo,
          source: 'teacher',
          targets: report.rule.targets,
          expected_effect: report.rule.expected_effect,
          ...(report.rule.skip_if ? { skip_if: report.rule.skip_if as unknown as Record<string, unknown>, predicate_text: report.predicate ?? describePredicate(report.rule.skip_if) } : {}),
          ...(report.dry_run ? { dry_run: report.dry_run as unknown as Record<string, unknown> } : {}),
          teacher_turn: result.turnId,
          effect: null,
          measured_batch: null,
        },
      }));
      if (rows.length > 0) await this.deps.store.upsert(rows);
      await record({ state: 'done', turn_id: result.turnId, rules: rows.map((row) => row.key), summary: clip(proposal.summary, 2000), note: result.status === 'completed' ? null : `turn ${result.status}` });
      this.logger.log(`[bugfarm] learning: the Teacher proposed ${rows.length} rule(s) after batch ${n} of ${id}: ${rows.map((row) => row.key).join(', ') || 'none'}`);
    } catch (err) {
      if (err instanceof BudgetBlockedError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[bugfarm] learning: the Teacher turn after batch ${n} of ${id} failed: ${message}`);
      await record({ state: 'failed', note: message.slice(0, 500) });
    }
  }

  private proposalFrom(submission: Record<string, unknown> | null): { rules: unknown[]; summary: string | null } {
    const parsed = ProposeRulesSchema.safeParse(submission ?? {});
    if (!parsed.success) return { rules: [], summary: null };
    return { rules: parsed.data.rules, summary: parsed.data.summary ?? null };
  }

  private async teacherTaskFor(end: BatchEnd, learning: BatchLearning): Promise<string> {
    const { campaignId: id, batch: n } = end;
    const items = await this.rows<LearningItem>('item', (p) => p.campaign === id && p.batch === n);
    const turns = (await this.rows<TurnPayload>('turn', (p) => p.campaign === id)).map((row) => row.payload);
    const history: BatchLearning[] = [];
    for (let b = 1; b < n; b++) {
      const earlier = (await this.payload<{ learning?: BatchLearning }>('batch', `${id}:${b}`))?.learning;
      if (earlier) history.push(earlier);
    }
    const cards: TeacherCard[] = items.map(({ key, payload: item }) => {
      const writerTurns = turns.filter((turn) => turn.item === key && turn.role === 'writer');
      const draft = writerTurns.filter((turn) => turn.stage === 'write').at(-1);
      const review = writerTurns.filter((turn) => turn.stage === 'review').at(-1);
      const last = (review ?? draft)?.submission as { clean?: boolean; leaks?: Array<{ kind?: string; text?: string } | string> } | null | undefined;
      const outcome = learning.gate === 'controls'
        ? (passedControls(item) ? 'accepted' : item.stage === 'rejected' ? 'rejected' : 'pending')
        : (item.stage === 'accepted' || item.stage === 'published' ? 'accepted' : item.stage === 'rejected' ? 'rejected' : 'pending');
      return {
        pr: typeof item.pr === 'number' ? item.pr : null,
        title: item.title ?? '',
        outcome,
        reason: outcome === 'rejected' ? item.reject_reason ?? 'unknown' : null,
        detail: outcome === 'rejected' ? clip(item.reject_detail, DETAIL_CHARS) : null,
        features: item.features ?? {},
        writer: writerTurns.length === 0 ? null : {
          draft_submissions: draft?.submissions ?? 0,
          draft_clean: typeof (draft?.submission as { clean?: unknown } | undefined)?.clean === 'boolean' ? Boolean((draft?.submission as { clean: boolean }).clean) : null,
          review_submissions: review?.submissions ?? 0,
          final_clean: typeof last?.clean === 'boolean' ? last.clean : null,
          leaks: (last?.leaks ?? []).slice(0, 6).map((leak) => (typeof leak === 'string' ? leak : `${leak.kind ?? 'leak'}: ${leak.text ?? ''}`)),
        },
        buggy_base: typeof item.buggy_base === 'string' ? item.buggy_base : null,
        fail_to_pass: Array.isArray(item.failing_tests) ? item.failing_tests.length : null,
        cost_usd: typeof item.cost_usd === 'number' ? item.cost_usd : null,
      };
    });
    const filtered = turns
      .filter((turn) => turn.role === 'scout' && turn.batch === n)
      .flatMap((turn) => ((turn.submission as Partial<ScreenResult> | null | undefined)?.skipped ?? []).map((entry) => ({ pr: entry.pr ?? null, title: entry.title ?? '', rule: entry.rule ?? '' })));
    const rules: TeacherRule[] = (await this.rows<RulePayload>('rule', (p) => !p.simulated && (!p.repo || p.repo === end.config.repo)))
      .filter((row) => (RULE_KINDS as readonly string[]).includes(row.payload.kind ?? ''))
      .map(({ key, payload }) => ({
        id: key,
        kind: payload.kind ?? '',
        status: payload.status ?? 'kept',
        text: payload.text,
        ...(payload.skip_if ? { skip_if: payload.skip_if } : {}),
        targets: payload.targets ?? null,
        batch_introduced: payload.batch_introduced,
        effect: payload.effect?.summary ?? null,
      }));
    return teacherTask({ repo: end.config.repo, campaign: id, batch: n, learning, history, cards, rules, filtered });
  }

  // ------------------------------------------------------------------------------------------
  // For the HTTP tools

  /** The batch a Teacher turn learns from: its turn is tagged with the next batch. */
  private async reviewContext(id: string, n: number, repo: string): Promise<{ reasons: Record<string, number>; cards: ProposalCard[]; existing: ExistingRule[]; envBuilt: string | null }> {
    const learning = (await this.payload<{ learning?: BatchLearning }>('batch', `${id}:${n}`))?.learning;
    const gate = learning?.gate ?? 'controls';
    const items = await this.rows<LearningItem>('item', (p) => p.campaign === id && p.batch === n);
    const cards: ProposalCard[] = items.map(({ key, payload }) => {
      const accepted = gate === 'controls' ? passedControls(payload) : payload.stage === 'accepted' || payload.stage === 'published';
      return { key, pr: typeof payload.pr === 'number' ? payload.pr : null, accepted, reason: !accepted && payload.stage === 'rejected' ? payload.reject_reason ?? 'unknown' : null, features: payload.features ?? {} };
    });
    const existing: ExistingRule[] = (await this.rows<RulePayload>('rule', (p) => !p.simulated && (!p.repo || p.repo === repo)))
      .map(({ key, payload }) => ({ id: key, kind: payload.kind, text: payload.text, status: payload.status, skip_if: payload.skip_if ?? null }));
    const campaign = await this.payload<{ env?: { state?: string; tag?: string } | null }>('campaign', id);
    const envBuilt = campaign?.env?.state === 'ready' ? campaign.env.tag ?? repo : null;
    return { reasons: learning?.reasons ?? {}, cards, existing, envBuilt };
  }

  /** `propose_rules`: check the Teacher's rules against the batch it learns from. */
  async review(turn: TurnPayload, body: unknown): Promise<{ rules: Proposal[]; summary: string | null; reports: ProposalReport[]; message: string }> {
    const parsed = ProposeRulesSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw Object.assign(new Error(`propose_rules: ${issue?.path.join('.') || '(body)'}: ${issue?.message ?? 'invalid'}`), { status: 400 });
    }
    const campaign = await this.payload<{ config?: CampaignConfig }>('campaign', turn.campaign);
    const repo = campaign?.config?.repo ?? '';
    const n = turn.batch - 1;
    const context = await this.reviewContext(turn.campaign, n, repo);
    const reports = reviewProposals({ rules: parsed.data.rules, batch: n, reasons: context.reasons, cards: context.cards, existing: context.existing, envBuilt: context.envBuilt });
    const ok = reports.filter((report) => report.ok && report.rule).map((report) => report.rule as Proposal);
    const failed = reports.filter((report) => !report.ok);
    const message = parsed.data.rules.length === 0
      ? 'Recorded: no rule changes for this batch. You are done; reply with a one-line summary.'
      : failed.length === 0
        ? `Recorded ${ok.length} rule(s); they go on trial in batch ${turn.batch}. You are done; reply with a one-line summary.`
        : `Recorded ${ok.length} valid rule(s); ${failed.length} were rejected (see reports). Fix them and call propose_rules again with the full list, or stop if the valid ones are what you want.`;
    return { rules: ok, summary: parsed.data.summary ?? null, reports, message };
  }

  /**
   * `submit_candidates`: apply the Scout filters that carry a `skip_if` predicate. Features are
   * computed only when there is a predicate to test.
   */
  async screen(turn: TurnPayload, candidates: ScoutCandidate[], raw: unknown[]): Promise<ScreenResult> {
    const extrasBySha = extrasFromRaw(raw);
    const extras: ScreenResult['extras'] = {};
    for (const candidate of candidates) {
      const entry = extrasBySha.get(candidate.sha);
      if (entry) extras[String(candidate.pr)] = entry;
    }
    const result: ScreenResult = { kept: candidates, skipped: [], extras, features: {} };
    const campaign = await this.payload<{ config?: CampaignConfig }>('campaign', turn.campaign);
    const config = campaign?.config;
    if (!config || config.learning === false) return result;
    const filters = (await loadPlaybook(this.deps.store, config.repo)).scout_filters.filter((rule): rule is typeof rule & { skip_if: Predicate } => Boolean(rule.skip_if));
    if (filters.length === 0) return result;
    const kept: ScoutCandidate[] = [];
    for (const candidate of candidates) {
      let git: CandidateFeatures | null = null;
      try {
        git = await this.deps.features(config.repo, candidate.sha);
      } catch (err) {
        this.logger.warn(`[bugfarm] learning: features for PR #${candidate.pr} failed: ${(err as Error).message}`);
      }
      const features: CandidateFeatures = {
        ...(git ?? {}),
        ...textFeatures({ title: candidate.title, labels: extras[String(candidate.pr)]?.labels ?? null, issue: candidate.issue ?? null, pr_body: candidate.pr_body ?? null, issue_body: candidate.issue_body ?? null, rank: extras[String(candidate.pr)]?.rank ?? null }),
      };
      if (git) result.features[String(candidate.pr)] = git;
      const hit = filters.find((rule) => matches(rule.skip_if, features));
      if (hit) result.skipped.push({ pr: candidate.pr, sha: candidate.sha, title: candidate.title, rule: hit.id, predicate: describePredicate(hit.skip_if) });
      else kept.push(candidate);
    }
    result.kept = kept;
    if (result.skipped.length > 0) this.logger.log(`[bugfarm] learning: Scout filters dropped ${result.skipped.length} candidate(s) in batch ${turn.batch}: ${result.skipped.map((s) => `#${s.pr} (${s.rule})`).join(', ')}`);
    return result;
  }
}
