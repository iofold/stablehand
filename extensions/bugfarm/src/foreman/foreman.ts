import type { EnvContext } from '../../pipeline/lib/build-env.ts';
import { profileFor } from '../../pipeline/lib/repos.ts';
import type { Calibrate, CalibrationPanel } from '../calibrate.js';
import { StablehandApiError } from '@stablehand/client';
import { BudgetBlockedError, type FloorApi, type TurnInfo } from '../floor/api.js';
import type { JobRecord, JobRunner } from '../jobs/runner.js';
import { checkLeaks, describeLeaks } from '../leak-check.js';
import { loadPlaybook, rulesFor } from '../playbook.js';
import type {
  BatchPayload,
  BoardRow,
  CampaignPayload,
  EnvPayload,
  FloorRole,
  ItemPayload,
  RowKind,
  TurnPayload,
} from '../shared/board.js';
import type { UpsertInput } from '../store/validate.js';
import { diffStats, leakInputFor, type ItemContext } from './context.js';
import { envTask, reviewTask, scoutTask, writerTask, type WriterTaskInput } from './tasks.js';

/**
 * The foreman runs a campaign as batches, entirely from state in the board store:
 *
 *   Scout turn → candidates (cards in Mined)
 *   Env builder turn, once per repo (cards move to Env ready)
 *   per candidate: check job → Writer turn → review turn → package job → controls job
 *   → calibration hand-off (cards in Calibrating)
 *
 * Every step records where it is before it acts: a turn's idempotency key and task text before
 * the turn starts, its id right after; a job's deterministic id. A worker that dies mid-batch
 * comes back, finds the campaign still `running`, counts the recovery on the board, and picks up
 * each card at its step: turns in flight are waited on (Stablehand kept running them), jobs in
 * flight are resumed by the job runner, and nothing that finished runs twice.
 */

export interface CampaignConfig {
  repo: string;
  /** Candidates the Scout picks per batch. */
  batch_size: number;
  batches: number;
  /** Shown on the board; the budget policy on `budget_tag` enforces it. */
  cap_usd: number;
  /** Value of the `campaign` tag on every turn; budget policies select on it. */
  budget_tag: string;
  /** Oldest merge date the Scout may pick. */
  since: string;
  /** Writer turns at once. */
  writer_concurrency: number;
  /** Give up waiting on one turn after this long. */
  turn_timeout_min: number;
  /** Ask the Env builder even when an environment for this HEAD exists. */
  rebuild_env: boolean;
  /** Dollars each task may spend in calibration. */
  calibration_usd: number;
}

export const DEFAULT_CONFIG: Omit<CampaignConfig, 'repo' | 'budget_tag'> = {
  batch_size: 15,
  batches: 1,
  cap_usd: 15,
  since: '2025-07-01',
  writer_concurrency: 3,
  turn_timeout_min: 30,
  rebuild_env: false,
  calibration_usd: 2,
};

export type ItemStep =
  | 'queued'
  | 'checking'
  | 'writing'
  | 'reviewing'
  | 'packaging'
  | 'controls'
  | 'calibrating'
  | 'handed_off'
  | 'accepted'
  | 'rejected';

/** A floor turn's bookkeeping on its owner row (`turns.<stage>`). */
interface TurnRef {
  key: string;
  attempt: number;
  turn_id?: string | null;
  /** Kept until the turn has an id, so a restart re-sends exactly the same request. */
  task?: string | null;
}

interface ForemanItem extends ItemPayload {
  step?: ItemStep;
  turns?: Record<string, TurnRef>;
  pr_body?: string | null;
  issue_title?: string | null;
  issue_body?: string | null;
  task_dir?: string | null;
  draft?: string | null;
}

interface ForemanCampaign extends CampaignPayload {
  config?: CampaignConfig;
  env?: { state: 'pending' | 'building' | 'ready' | 'failed'; tag?: string; built_by?: string } | null;
  turns?: Record<string, TurnRef>;
  last_error?: string | null;
}

interface ForemanBatch extends BatchPayload {
  campaign?: string;
  scouted?: boolean;
  turns?: Record<string, TurnRef>;
  ready?: number;
}

export interface ForemanStore {
  upsert(rows: UpsertInput[]): Promise<unknown>;
  latest(kind: RowKind, key: string): Promise<BoardRow | null>;
  currentOfKind<K extends RowKind>(kind: K): Promise<BoardRow<K>[]>;
}

interface Logger {
  log(message: string): void;
  warn(message: string, ...args: unknown[]): void;
}

export interface ForemanDeps {
  store: ForemanStore;
  jobs: Pick<JobRunner, 'submit' | 'settle' | 'get'>;
  floor: FloorApi;
  agentNames: Record<FloorRole, string>;
  calibrate: Calibrate;
  panel: CalibrationPanel;
  envContext: (repo: string) => Promise<EnvContext>;
  itemContext: (repo: string, sha: string) => ItemContext;
  logger?: Logger;
  now?: () => number;
  /** How long to keep asking for a turn's cost while the gateway prices it. */
  costSettleMs?: number;
}

/** What the Scout submits for each pull request. */
export interface ScoutCandidate {
  pr: number;
  sha: string;
  title: string;
  url?: string;
  merged_at?: string;
  issue?: number | null;
  issue_title?: string | null;
  issue_body?: string | null;
  pr_body?: string | null;
  why?: string;
}

export class CampaignBusyError extends Error {
  constructor(readonly running: string) {
    super(`Campaign ${running} is still running; one campaign runs at a time.`);
    this.name = 'CampaignBusyError';
  }
}

class Gate {
  private free: number;
  private readonly waiters: Array<() => void> = [];

  constructor(size: number) {
    this.free = Math.max(1, size);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    }
  }
}

const TERMINAL_STEPS: ReadonlySet<ItemStep> = new Set(['handed_off', 'accepted', 'rejected']);
const MAX_TURN_ATTEMPTS = 2;
const MAX_TRANSIENT_RETRIES = 10;
const TRANSIENT_RETRY_MS = 30_000;

/** Network blips and a restarting Stablehand: worth waiting out instead of rejecting a card. */
function isTransient(err: unknown): boolean {
  if (err instanceof StablehandApiError) return err.status >= 500 || err.status === 429 || err.status === 408;
  return err instanceof TypeError && /fetch failed|ECONNREFUSED|ECONNRESET|socket/i.test(`${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`);
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

export function itemKeyFor(campaignId: string, repo: string, sha: string): string {
  return `${campaignId}:${profileFor(repo).slug}@${shortSha(sha)}`;
}

function clip(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export class Foreman {
  private readonly active = new Map<string, Promise<void>>();
  private readonly agentIds = new Map<FloorRole, string>();
  private writerGate = new Gate(3);

  constructor(private readonly deps: ForemanDeps) {}

  private get logger(): Logger {
    return this.deps.logger ?? console;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async patch(kind: RowKind, key: string, payload: Record<string, unknown>): Promise<void> {
    await this.deps.store.upsert([{ kind, key, payload }]);
  }

  private async read<T>(kind: RowKind, key: string): Promise<T | null> {
    const row = await this.deps.store.latest(kind, key);
    return row ? (row.payload as T) : null;
  }

  /** Campaigns this process is driving right now. */
  get running(): string[] {
    return [...this.active.keys()];
  }

  /** Resume every campaign a previous process left running. Call once at startup. */
  async resumeAll(): Promise<string[]> {
    const resumed: string[] = [];
    for (const row of await this.deps.store.currentOfKind('campaign')) {
      const campaign = row.payload as ForemanCampaign;
      if (campaign.simulated || !campaign.config) continue;
      if (campaign.status !== 'running' && campaign.status !== 'recovering') continue;
      const count = (campaign.recovered_from_crash ?? 0) + 1;
      await this.patch('campaign', row.key, { recovered_from_crash: count, status: 'running', last_recovered_at: this.now() });
      const items = (await this.itemsOf(row.key)).filter((item) => item.payload.batch === campaign.batch);
      const steps = new Map<string, number>();
      for (const item of items) steps.set(item.payload.step ?? 'queued', (steps.get(item.payload.step ?? 'queued') ?? 0) + 1);
      const summary = [...steps].map(([step, n]) => `${n} ${step}`).join(', ') || 'no cards yet';
      this.logger.log(`[bugfarm] foreman: RECOVERED campaign ${row.key} after a restart (recovery #${count}); resuming batch ${campaign.batch ?? 1} where it left off: ${summary}`);
      resumed.push(row.key);
      this.drive(row.key);
    }
    return resumed;
  }

  /** Start a new campaign. Refuses while another one runs. */
  async launch(id: string, config: CampaignConfig): Promise<void> {
    const busy = (await this.deps.store.currentOfKind('campaign')).find((row) => {
      const c = row.payload as ForemanCampaign;
      return !c.simulated && c.config && (c.status === 'running' || c.status === 'recovering');
    });
    if (busy) throw new CampaignBusyError(busy.key);
    const existing = await this.read<ForemanCampaign>('campaign', id);
    if (existing?.config) throw new Error(`campaign ${id} already exists (status ${existing.status}); pick a new id`);
    profileFor(config.repo);
    const now = this.now();
    const payload: ForemanCampaign = {
      name: `${config.repo} · ${id}`,
      repo: config.repo,
      cap_usd: config.cap_usd,
      spend_usd: 0,
      started_at: now,
      unattended_since: now,
      recovered_from_crash: 0,
      batch: 1,
      status: 'running',
      finished_at: null,
      config,
      env: { state: 'pending' },
      last_error: null,
    };
    await this.deps.store.upsert([{ kind: 'campaign', key: id, payload: payload as Record<string, unknown>, mode: 'replace' }]);
    this.logger.log(`[bugfarm] foreman: campaign ${id} started on ${config.repo}: ${config.batches} batch(es) of ${config.batch_size}, cap $${config.cap_usd}, turns tagged campaign=${config.budget_tag}`);
    this.drive(id);
  }

  /** Resolves when the campaign stops (finished, paused or failed). */
  async whenIdle(id: string): Promise<void> {
    await this.active.get(id);
  }

  private drive(id: string): void {
    if (this.active.has(id)) return;
    const run = this.run(id)
      .catch(async (err: unknown) => {
        const budget = err instanceof BudgetBlockedError;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[bugfarm] foreman: campaign ${id} ${budget ? 'stopped at its budget' : 'paused'}: ${message}`);
        await this.patch('campaign', id, { status: 'paused', last_error: message.slice(0, 2000), ...(budget ? { stopped_by: 'budget' } : {}) });
      })
      .finally(() => this.active.delete(id));
    this.active.set(id, run);
  }

  private async campaign(id: string): Promise<ForemanCampaign & { config: CampaignConfig }> {
    const campaign = await this.read<ForemanCampaign>('campaign', id);
    if (!campaign?.config) throw new Error(`campaign ${id} has no config`);
    return campaign as ForemanCampaign & { config: CampaignConfig };
  }

  private async agentId(role: FloorRole): Promise<string> {
    const cached = this.agentIds.get(role);
    if (cached) return cached;
    const name = this.deps.agentNames[role];
    const id = await this.deps.floor.findAgentByName(name);
    if (!id) throw new Error(`floor agent "${name}" does not exist in Stablehand; run \`bugfarm seed\` first`);
    this.agentIds.set(role, id);
    return id;
  }

  private async run(id: string): Promise<void> {
    let campaign = await this.campaign(id);
    this.writerGate = new Gate(campaign.config.writer_concurrency);
    for (let n = campaign.batch ?? 1; n <= campaign.config.batches; n++) {
      await this.patch('campaign', id, { batch: n });
      await this.runBatch(id, n);
      campaign = await this.campaign(id);
      if (campaign.status !== 'running') return;
    }
    await this.refreshSpend(id);
    await this.patch('campaign', id, { status: 'done', finished_at: this.now() });
    this.logger.log(`[bugfarm] foreman: campaign ${id} finished`);
  }

  private async itemsOf(campaignId: string): Promise<Array<BoardRow<'item'> & { payload: ForemanItem }>> {
    return (await this.deps.store.currentOfKind('item')).filter((row) => (row.payload as ForemanItem).campaign === campaignId) as Array<BoardRow<'item'> & { payload: ForemanItem }>;
  }

  private async runBatch(id: string, n: number): Promise<void> {
    const batchKey = `${id}:${n}`;
    let batch = await this.read<ForemanBatch>('batch', batchKey);
    if (!batch) {
      batch = { n, campaign: id, status: 'running', started_at: this.now(), finished_at: null, candidates: 0, accepted: 0, rejected: 0, cost_usd: 0, scouted: false };
      await this.patch('batch', batchKey, batch as Record<string, unknown>);
    }
    if (batch.status === 'done') return;

    if (!batch.scouted) await this.scoutStep(id, n, batchKey);
    await this.envStep(id);

    const items = (await this.itemsOf(id)).filter((row) => row.payload.batch === n);
    await this.deps.store.upsert(items
      .filter((row) => row.payload.stage === 'mined')
      .map((row) => ({ kind: 'item' as const, key: row.key, payload: { stage: 'env_ready', activity: 'Waiting for a check slot' } })));
    await Promise.all(items.map((row) => this.runItem(id, row.key)));

    const done = (await this.itemsOf(id)).filter((row) => row.payload.batch === n);
    await this.refreshSpend(id);
    const counts = {
      candidates: done.length,
      accepted: done.filter((row) => row.payload.stage === 'accepted').length,
      rejected: done.filter((row) => row.payload.stage === 'rejected').length,
      ready: done.filter((row) => row.payload.stage === 'calibrating').length,
    };
    await this.patch('batch', batchKey, { ...counts, status: 'done', finished_at: this.now() });
    this.logger.log(`[bugfarm] foreman: batch ${n} of ${id} done: ${counts.candidates} candidates, ${counts.ready} handed to calibration, ${counts.rejected} rejected`);
  }

  // ------------------------------------------------------------------------------------------
  // Turns

  private turnTags(campaign: ForemanCampaign & { config: CampaignConfig }, batch: number, stage: string, item: string): Record<string, string> {
    return { campaign: campaign.config.budget_tag, batch: String(batch), stage, item };
  }

  /**
   * Run one floor turn exactly once across restarts. `owner` is the row whose `turns.<stage>`
   * holds the bookkeeping. Returns the finished turn and the last thing the agent submitted.
   */
  private async runTurn(spec: {
    campaignId: string;
    role: FloorRole;
    stage: string;
    batch: number;
    item: string;
    owner: { kind: 'item' | 'batch' | 'campaign'; key: string };
    task: () => Promise<string>;
    attempt: number;
  }): Promise<{ info: TurnInfo; submission: Record<string, unknown> | null; turnId: string }> {
    const campaign = await this.campaign(spec.campaignId);
    const ownerPayload = await this.read<{ turns?: Record<string, TurnRef> }>(spec.owner.kind, spec.owner.key);
    const slot = spec.attempt > 1 ? `${spec.stage}#${spec.attempt}` : spec.stage;
    let ref = ownerPayload?.turns?.[slot] ?? null;
    if (!ref) {
      ref = { key: `bugfarm:${spec.campaignId}:${spec.stage}:${spec.item}:${spec.attempt}`.slice(0, 255), attempt: spec.attempt, turn_id: null, task: await spec.task() };
      await this.patch(spec.owner.kind, spec.owner.key, { turns: { [slot]: ref } });
    }
    let turnId = ref.turn_id ?? null;
    const agentId = await this.agentId(spec.role);
    if (!turnId) {
      if (!ref.task) throw new Error(`turn ${ref.key} has neither an id nor its task text`);
      const tags = this.turnTags(campaign, spec.batch, spec.stage, spec.item);
      ({ turnId } = await this.deps.floor.startTurn({ agentId, task: ref.task, tags, idempotencyKey: ref.key }));
      const turn: TurnPayload = {
        turn_id: turnId,
        role: spec.role,
        agent_id: agentId,
        campaign: spec.campaignId,
        batch: spec.batch,
        stage: spec.stage,
        item: spec.item,
        status: 'running',
        started_at: this.now(),
        finished_at: null,
      };
      await this.deps.store.upsert([
        { kind: 'turn', key: turnId, payload: turn as Record<string, unknown> },
        { kind: spec.owner.kind, key: spec.owner.key, payload: { turns: { [slot]: { turn_id: turnId, task: null } } } },
      ]);
      this.logger.log(`[bugfarm] foreman: ${spec.role} turn ${turnId} started (${spec.stage} ${spec.item})`);
    } else {
      this.logger.log(`[bugfarm] foreman: waiting on ${spec.role} turn ${turnId} again (${spec.stage} ${spec.item})`);
    }

    let info = await this.deps.floor.waitForTurn(turnId, campaign.config.turn_timeout_min * 60_000);
    const settleBy = this.now() + (this.deps.costSettleMs ?? 45_000);
    while (info.costCoverage === 'pending' && this.now() < settleBy) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      info = await this.deps.floor.lookupTurn(turnId);
    }
    const status = info.status === 'COMPLETED' ? 'completed' : info.status === 'CANCELLED' ? 'cancelled' : 'error';
    await this.patch('turn', turnId, {
      status,
      error: info.error ? info.error.slice(0, 2000) : null,
      stop_code: info.stopCode,
      cost_usd: info.costUsd,
      cost_coverage: info.costCoverage,
      finished_at: this.now(),
    });
    await this.refreshSpend(spec.campaignId);
    const row = await this.read<TurnPayload>('turn', turnId);
    this.logger.log(`[bugfarm] foreman: ${spec.role} turn ${turnId} ${status}${info.costUsd !== null ? ` ($${info.costUsd.toFixed(3)})` : ''}`);
    return { info, submission: row?.submission ?? null, turnId };
  }

  /** Re-sum spend from turn rows: per item, per batch and for the campaign. */
  private async refreshSpend(campaignId: string): Promise<void> {
    const turns = (await this.deps.store.currentOfKind('turn')).map((row) => row.payload as TurnPayload).filter((t) => t.campaign === campaignId);
    const byItem = new Map<string, number>();
    const byBatch = new Map<number, number>();
    let total = 0;
    for (const turn of turns) {
      const cost = asNumber(turn.cost_usd) ?? 0;
      total += cost;
      byItem.set(turn.item, (byItem.get(turn.item) ?? 0) + cost);
      byBatch.set(turn.batch, (byBatch.get(turn.batch) ?? 0) + cost);
    }
    const rows: UpsertInput[] = [{ kind: 'campaign', key: campaignId, payload: { spend_usd: round(total) } }];
    for (const item of await this.itemsOf(campaignId)) {
      const cost = byItem.get(item.key);
      if (cost !== undefined) rows.push({ kind: 'item', key: item.key, payload: { cost_usd: round(cost) } });
    }
    for (const [n, cost] of byBatch) rows.push({ kind: 'batch', key: `${campaignId}:${n}`, payload: { n, cost_usd: round(cost) } });
    await this.deps.store.upsert(rows);
  }

  // ------------------------------------------------------------------------------------------
  // Scout and Env builder

  private async scoutStep(id: string, n: number, batchKey: string): Promise<void> {
    const campaign = await this.campaign(id);
    const { repo } = campaign.config;
    const earlier = (await this.itemsOf(id)).filter((row) => (row.payload.batch ?? 0) < n);
    const exclude = earlier.map((row) => row.payload.pr).filter((pr): pr is number => typeof pr === 'number');
    let picked: ScoutCandidate[] = [];
    for (let attempt = 1; attempt <= MAX_TURN_ATTEMPTS && picked.length === 0; attempt++) {
      const result = await this.runTurn({
        campaignId: id,
        role: 'scout',
        stage: 'scout',
        batch: n,
        item: `${id}:batch-${n}`,
        owner: { kind: 'batch', key: batchKey },
        attempt,
        task: async () => scoutTask({
          repo,
          since: campaign.config.since,
          want: campaign.config.batch_size,
          batch: n,
          exclude,
          rulesJson: rulesFor(await loadPlaybook(this.deps.store, repo), 'scout'),
          sourceDirs: profileFor(repo).sourceDirs,
          testDirs: profileFor(repo).testDirs,
        }),
      });
      picked = parseCandidates(result.submission).filter((c) => !exclude.includes(c.pr));
      if (picked.length === 0) this.logger.warn(`[bugfarm] foreman: the Scout submitted no usable candidates (attempt ${attempt}, turn ${result.info.status})`);
    }
    if (picked.length === 0) throw new Error('the Scout found no candidates');

    const seen = new Set<string>();
    const rows: UpsertInput[] = [];
    for (const candidate of picked) {
      const key = itemKeyFor(id, repo, candidate.sha);
      if (seen.has(key) || rows.length >= campaign.config.batch_size) continue;
      seen.add(key);
      const item: ForemanItem = {
        stage: 'mined',
        step: 'queued',
        campaign: id,
        batch: n,
        repo,
        sha: candidate.sha,
        title: clip(cleanTitle(candidate.title), 380) ?? candidate.sha,
        url: candidate.url ?? `https://github.com/${repo}/pull/${candidate.pr}`,
        pr: candidate.pr,
        issue: candidate.issue ?? null,
        issue_title: clip(candidate.issue_title, 300),
        issue_body: clip(candidate.issue_body, 4000),
        pr_body: clip(candidate.pr_body, 4000),
        scout_note: clip(candidate.why, 500),
        merged_at: candidate.merged_at ?? null,
        activity: 'Picked by the Scout',
        cost_usd: 0,
      };
      rows.push({ kind: 'item', key, payload: item as Record<string, unknown>, mode: 'replace' });
    }
    rows.push({ kind: 'batch', key: batchKey, payload: { n, scouted: true, candidates: rows.length } });
    await this.deps.store.upsert(rows);
    this.logger.log(`[bugfarm] foreman: the Scout picked ${rows.length - 1} candidates for batch ${n}`);
  }

  private async envStep(id: string): Promise<void> {
    const campaign = await this.campaign(id);
    if (campaign.env?.state === 'ready') return;
    const { repo } = campaign.config;
    const context = await this.deps.envContext(repo);
    const current = await this.read<EnvPayload>('env', repo);
    if (current?.ok && current.head === context.head && !campaign.config.rebuild_env && !campaign.turns?.env) {
      await this.patch('campaign', id, { env: { state: 'ready', tag: current.tag, built_by: current.built_by ?? 'agent', reused: true } });
      this.logger.log(`[bugfarm] foreman: reusing the ${repo} environment ${current.tag}`);
      return;
    }
    await this.patch('campaign', id, { env: { state: 'building' } });
    let previousFailure: string | null = null;
    for (let attempt = 1; attempt <= MAX_TURN_ATTEMPTS; attempt++) {
      const startedAt = this.now();
      await this.runTurn({
        campaignId: id,
        role: 'env_builder',
        stage: 'env',
        batch: campaign.batch ?? 1,
        item: `${id}:env`,
        owner: { kind: 'campaign', key: id },
        attempt,
        task: async () => envTask({ context, rulesJson: rulesFor(await loadPlaybook(this.deps.store, repo), 'env_builder'), previousFailure }),
      });
      const env = await this.read<EnvPayload>('env', repo);
      if (env?.ok && env.head === context.head && (env.built_at ?? 0) >= startedAt - 60 * 60_000) {
        await this.patch('campaign', id, { env: { state: 'ready', tag: env.tag, built_by: env.built_by ?? 'agent' } });
        this.logger.log(`[bugfarm] foreman: the Env builder got ${repo} to collect: ${env.tag}`);
        return;
      }
      previousFailure = await this.lastBuildFailure(repo);
    }
    // The agent did not get there. Fall back to the repo profile's Dockerfile so the batch can go on.
    this.logger.warn(`[bugfarm] foreman: the Env builder did not produce a working ${repo} image; falling back to the profile Dockerfile`);
    const job = await this.deps.jobs.submit('build_env', { repo }, { id: `${id}:env:profile`, owner: 'foreman', campaign: id });
    const settled = await this.deps.jobs.settle(job.id);
    if (settled.status === 'done' && settled.result?.ok === true) {
      await this.patch('campaign', id, { env: { state: 'ready', tag: String(settled.result.tag), built_by: 'profile' } });
      return;
    }
    await this.patch('campaign', id, { env: { state: 'failed' } });
    throw new Error(`no working environment for ${repo}`);
  }

  private async lastBuildFailure(repo: string): Promise<string | null> {
    const jobs = (await this.deps.store.currentOfKind('job'))
      .filter((row) => row.payload.kind === 'build_env' && row.payload.args.repo === repo && row.payload.status === 'done' && row.payload.result?.ok === false);
    const last = jobs.at(-1)?.payload.result;
    return last ? String(last.logs_tail ?? last.reason ?? '') : null;
  }

  // ------------------------------------------------------------------------------------------
  // One card

  private async setItem(key: string, payload: Partial<ForemanItem>): Promise<void> {
    await this.patch('item', key, payload as Record<string, unknown>);
  }

  private async reject(key: string, reason: string, detail: string | null): Promise<void> {
    await this.setItem(key, { stage: 'rejected', step: 'rejected', reject_reason: reason, reject_detail: detail ? detail.slice(0, 1900) : null, activity: null });
    this.logger.log(`[bugfarm] foreman: ${key} rejected: ${reason}`);
  }

  private async job(kind: JobRecord['kind'], id: string, args: Record<string, unknown>, campaignId: string, item: string): Promise<JobRecord> {
    const job = await this.deps.jobs.submit(kind, args, { id, owner: 'foreman', campaign: campaignId, item });
    return this.deps.jobs.settle(job.id);
  }

  private async runItem(campaignId: string, key: string): Promise<void> {
    let transientFailures = 0;
    for (;;) {
      const item = await this.read<ForemanItem>('item', key);
      if (!item) return;
      const step = item.step ?? 'queued';
      if (TERMINAL_STEPS.has(step)) return;
      const campaign = await this.campaign(campaignId);
      if (campaign.status !== 'running') return;
      const repo = item.repo ?? campaign.config.repo;
      const sha = item.sha ?? '';
      try {
        await this.advance(campaignId, campaign, key, item, step, repo, sha);
        transientFailures = 0;
      } catch (err) {
        if (err instanceof BudgetBlockedError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        if (isTransient(err) && transientFailures < MAX_TRANSIENT_RETRIES) {
          transientFailures++;
          this.logger.warn(`[bugfarm] foreman: ${key} hit a transient error at ${step} (${message}); retrying in ${TRANSIENT_RETRY_MS / 1000}s`);
          await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_MS));
          continue;
        }
        this.logger.warn(`[bugfarm] foreman: ${key} failed at ${step}: ${message}`);
        await this.reject(key, step === 'packaging' ? 'package_error' : step === 'controls' ? 'control_error' : step === 'writing' || step === 'reviewing' ? 'writer_failed' : 'check_error', message);
      }
    }
  }

  private async advance(
    campaignId: string,
    campaign: ForemanCampaign & { config: CampaignConfig },
    key: string,
    item: ForemanItem,
    step: ItemStep,
    repo: string,
    sha: string,
  ): Promise<void> {
    switch (step) {
      case 'queued':
      case 'checking': {
        if (step === 'queued') await this.setItem(key, { step: 'checking', activity: 'Testing before and after the fix' });
        const job = await this.job('check_candidate', `${key}:check`, { repo, sha, ...(item.pr ? { pr: item.pr } : {}) }, campaignId, key);
        if (job.status === 'failed') {
          await this.reject(key, 'check_error', job.error ?? 'the check crashed');
          return;
        }
        const result = job.result ?? {};
        if (result.accepted !== true) {
          await this.reject(key, String(result.reason ?? 'check_error'), result.detail ? String(result.detail) : null);
          return;
        }
        const fullSha = typeof result.sha === 'string' && result.sha ? result.sha : sha;
        const context = this.deps.itemContext(repo, fullSha);
        await this.setItem(key, {
          stage: 'fail_pass',
          step: 'writing',
          sha: fullSha,
          failing_tests: context.check.fail_to_pass.slice(0, 200),
          failing_output: context.check.failing_output?.slice(0, 20_000) ?? '',
          diff: context.fixDiff.slice(0, 200_000),
          diff_stats: diffStats(context.fixDiff),
          fix_date: context.check.fix_date,
          buggy_base: context.check.buggy_base ?? null,
          pass_to_pass_count: context.check.pass_to_pass.length,
          test_modules: context.check.suite_modules.length,
          activity: 'Waiting for the Writer',
        });
        return;
      }
      case 'writing': {
        const context = this.deps.itemContext(repo, sha);
        const input = await this.writerInput(campaign, key, item, context);
        const draft = await this.writerGate.run(async () => {
          await this.setItem(key, { activity: 'Writer is drafting the issue' });
          return this.writerPass(campaignId, item, key, 'write', () => writerTask(input));
        });
        if (!draft) {
          await this.reject(key, 'writer_failed', 'the Writer submitted no instruction');
          return;
        }
        await this.setItem(key, { step: 'reviewing', draft, activity: 'Waiting for the leak review' });
        return;
      }
      case 'reviewing': {
        const context = this.deps.itemContext(repo, sha);
        const input = await this.writerInput(campaign, key, item, context);
        const draft = item.draft ?? '';
        const reviewed = await this.writerGate.run(async () => {
          await this.setItem(key, { activity: 'Writer is checking for leaks' });
          return this.writerPass(campaignId, item, key, 'review', () => reviewTask({ ...input, draft }));
        });
        const final = reviewed ?? draft;
        const report = checkLeaks(leakInputFor(context, final));
        if (!report.clean) {
          await this.reject(key, 'instruction_leaks_fix', describeLeaks(report));
          return;
        }
        await this.setItem(key, { step: 'packaging', instruction: final, activity: 'Packaging the Harbor task' });
        return;
      }
      case 'packaging': {
        const job = await this.job('package_task', `${key}:package`, {
          repo,
          sha,
          instruction: item.instruction ?? '',
          ...(item.pr ? { pr: item.pr } : {}),
          ...(item.issue ? { issue: item.issue } : {}),
          ...(item.url ? { url: item.url } : {}),
        }, campaignId, key);
        if (job.status === 'failed') {
          await this.reject(key, 'package_error', job.error ?? 'packaging failed');
          return;
        }
        await this.setItem(key, { step: 'controls', task_dir: String(job.result?.task_dir ?? ''), activity: 'Running the oracle and nop controls' });
        return;
      }
      case 'controls': {
        const job = await this.job('run_controls', `${key}:controls`, { repo, sha }, campaignId, key);
        if (job.status === 'failed') {
          await this.reject(key, 'control_error', job.error ?? 'controls crashed');
          return;
        }
        const result = job.result ?? {};
        if (result.passed !== true) {
          await this.reject(key, String(result.reason ?? 'control_error'), result.detail ? String(result.detail) : `oracle ${String(result.oracle)}, nop ${String(result.nop)}`);
          return;
        }
        await this.setItem(key, { stage: 'controls', step: 'calibrating', controls: { oracle: asNumber(result.oracle), nop: asNumber(result.nop) }, activity: 'Controls passed' });
        return;
      }
      case 'calibrating': {
        const outcome = await this.deps.calibrate(item.task_dir ?? '', this.deps.panel, {
          maxUsd: campaign.config.calibration_usd,
          tags: { campaign: campaign.config.budget_tag, batch: String(item.batch ?? 1), stage: 'calibrate', item: key },
          item: key,
        });
        if (outcome.state === 'pending') {
          await this.setItem(key, { stage: 'calibrating', step: 'handed_off', activity: 'Waiting for calibration' });
        } else if (outcome.state === 'accepted') {
          await this.setItem(key, { stage: 'accepted', step: 'accepted', difficulty: outcome.difficulty, activity: null });
        } else {
          await this.reject(key, outcome.reason ?? 'out_of_band', null);
        }
        return;
      }
      default:
        return;
    }
  }

  private async writerInput(campaign: ForemanCampaign & { config: CampaignConfig }, key: string, item: ForemanItem, context: ItemContext): Promise<WriterTaskInput> {
    return {
      repo: campaign.config.repo,
      item: key,
      pr: item.pr ?? null,
      title: item.title ?? '',
      prBody: item.pr_body ?? null,
      issue: item.issue ?? null,
      issueTitle: item.issue_title ?? null,
      issueBody: item.issue_body ?? null,
      context,
      rulesJson: rulesFor(await loadPlaybook(this.deps.store, campaign.config.repo), 'writer'),
    };
  }

  /** One Writer pass, retried once when the agent submits nothing. Returns the last instruction it submitted. */
  private async writerPass(campaignId: string, item: ForemanItem, key: string, stage: 'write' | 'review', task: () => string): Promise<string | null> {
    for (let attempt = 1; attempt <= MAX_TURN_ATTEMPTS; attempt++) {
      const { submission } = await this.runTurn({
        campaignId,
        role: 'writer',
        stage,
        batch: item.batch ?? 1,
        item: key,
        owner: { kind: 'item', key },
        attempt,
        task: async () => task(),
      });
      const text = typeof submission?.instruction === 'string' ? submission.instruction.trim() : '';
      if (text) return text;
    }
    return null;
  }
}

/** PR titles without a leading emoji or gitmoji code, which the card has no room for. */
export function cleanTitle(title: string): string {
  return title.replace(/^(?::[a-z0-9_+-]+:|[^\p{L}\p{N}`'"(])+/u, '').trim() || title;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Validate what the Scout submitted; drop entries without a commit or a PR number. */
export function parseCandidates(submission: Record<string, unknown> | null): ScoutCandidate[] {
  const list = submission?.candidates;
  if (!Array.isArray(list)) return [];
  const out: ScoutCandidate[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const pr = typeof entry.pr === 'number' ? entry.pr : Number(entry.pr);
    const sha = typeof entry.sha === 'string' ? entry.sha.trim() : '';
    if (!Number.isInteger(pr) || pr <= 0 || !/^[0-9a-f]{7,40}$/.test(sha)) continue;
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
    const issue = typeof entry.issue === 'number' ? entry.issue : Number(entry.issue);
    out.push({
      pr,
      sha,
      title: text(entry.title) ?? `PR #${pr}`,
      url: text(entry.url) ?? undefined,
      merged_at: text(entry.merged_at) ?? undefined,
      issue: Number.isInteger(issue) && issue > 0 ? issue : null,
      issue_title: text(entry.issue_title),
      issue_body: text(entry.issue_body),
      pr_body: text(entry.pr_body),
      why: text(entry.why) ?? undefined,
    });
  }
  return out;
}
