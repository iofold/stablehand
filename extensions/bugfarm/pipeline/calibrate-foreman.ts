// The foreman's calibration contract (`src/calibrate.ts`: `Calibrate`) on top of calibrate().
//
//   import { foremanCalibrate } from '../pipeline/calibrate-foreman.ts';
//   const cal = calibrationFromEnv(process.env, board);   // or foremanCalibrate({ panel: 'cal-v2', gateway })
//   new Foreman({ ..., calibrate: cal.calibrate, panel: panelEntries(cal.panel) });
//
// The frozen panel is the source of truth: results never pool across panels, so the foreman's
// panel entries are only checked against it, and a mismatch is logged once. The foreman owns the
// item's stage; this adapter writes attempts and per-family difficulty but never moves the card.
//
// Budgets, in the order they bind:
// - per card: `budget.maxUsd` covers every attempt on the card, so a resumed card only gets what
//   it has left;
// - per campaign: one pool per campaign, `capUsd` minus the campaign's other spend (floor turns)
//   minus calibration spend so far, shared by every card calibrating at once. A stage that the
//   pool cannot cover does not launch; when nothing can, the card is `over_budget`;
// - the campaign key's own gateway cap stops everything else.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Calibrate, CalibrationOutcome, CalibrationPanel, CampaignBudget } from '../src/calibrate.js';
import type { BoardSink } from './calibrate-board.ts';
import { AttemptStore, BudgetPool, CostModel, attemptRow, bestCost, calibrate, panelDir, readTaskInfo, recoverInterrupted, rejectDetail } from './calibrate.ts';
import type { AttemptRecord, CalibrationResult, GatewayContext } from './calibrate.ts';
import { SpendLog, readCampaignKey, readDotenv } from './calibrate-gateway.ts';
import { loadFrozenPanel } from './calibrate-panel.ts';
import type { FrozenPanel } from './calibrate-panel.ts';
import { Semaphore, fileExists, isDir, log } from './lib/util.ts';

export interface ForemanCalibrateOptions {
  /** A frozen panel, or its id under `.work/calibration/panels/`. */
  panel: FrozenPanel | string;
  gateway: GatewayContext;
  board?: BoardSink;
  /** Trial slots shared by every task the foreman hands over (default 6). */
  slots?: Semaphore;
}

/** Entries of the foreman's panel that differ from the frozen panel's ladder models, as text. */
export function panelMismatch(frozen: FrozenPanel, requested: CalibrationPanel): string | null {
  const ladder = new Map(frozen.families.filter((f) => f.ladder).map((f) => [f.family as string, f.ladder as string]));
  const diffs: string[] = [];
  if (requested.id && requested.id !== frozen.id) diffs.push(`panel ${requested.id}, frozen ${frozen.id}`);
  for (const e of requested.entries) {
    const family = e.family ?? frozen.models[e.model]?.family;
    if (!family) {
      diffs.push(`${e.model}: unknown family`);
      continue;
    }
    const want = ladder.get(family);
    if (want !== e.model || e.harness !== frozen.harness) diffs.push(`${family}: asked ${e.harness}/${e.model}, frozen ${frozen.harness}/${want ?? 'none'}`);
  }
  return diffs.length ? diffs.join('; ') : null;
}

/** calibrate()'s result in the foreman's terms: accept is Accepted, every other decision Rejected. */
export function toOutcome(r: CalibrationResult, panel?: FrozenPanel): CalibrationOutcome {
  const difficulty: Record<string, { passes: number; attempts: number }> = {};
  for (const [family, f] of Object.entries(r.perFamily)) if (f) difficulty[family] = { passes: f.passes, attempts: f.attempts };
  const base = { difficulty, costUsd: r.cost };
  if (r.decision === 'accept') return { ...base, state: 'accepted' };
  if (r.decision === 'screened') return { ...base, state: 'pending' };
  // too_easy, out_of_band, unsolved_review, over_budget, held. An over_budget card resumes from its
  // stored attempts if calibrated again with more budget; a held card needs a person to look at
  // the errored attempts.
  const reason = r.decision === 'held' ? 'held_errors' : r.decision;
  return { ...base, state: 'rejected', reason, detail: panel ? rejectDetail(r.decision, difficulty, panel) : undefined };
}

/** A campaign's share of the budget gate: its cap, minus floor-turn spend, minus calibration. */
export class CampaignPool extends BudgetPool {
  private readonly otherSpendUsd: () => number;

  constructor(limitUsd: number, otherSpendUsd: () => number) {
    super(limitUsd);
    this.otherSpendUsd = otherSpendUsd;
  }

  override remaining(): number {
    return super.remaining() - this.otherSpendUsd();
  }
}

function taskStores(panelId: string): AttemptStore[] {
  const dir = join(panelDir(panelId), 'tasks');
  return isDir(dir) ? readdirSync(dir).map((t) => new AttemptStore(panelId, t)) : [];
}

/**
 * The worker's calibration, from its environment:
 * - `BUGFARM_CALIBRATION=0` turns it off;
 * - `BUGFARM_CALIBRATION_PANEL`: a frozen panel id or file (default `cal-v2`);
 * - `BUGFARM_CAMPAIGN_KEY_FILE`: the campaign gateway key file (`calibrate.ts mint-key`), required;
 * - `BUGFARM_GATEWAY_URL` (default http://localhost:4400);
 * - `BUGFARM_GATEWAY_METERING_KEY`, or `BUGFARM_STABLEHAND_ENV` naming a Stablehand `.env` with
 *   `STABLEHAND_MODEL_GATEWAY_METERING_KEY`: prices attempts from the spend log (otherwise costs
 *   stay Harbor's estimates);
 * - `BUGFARM_CALIBRATION_SLOTS`: trials at once (default 6).
 * Returns why it is off instead when something is missing, so the worker can say so and leave
 * cards waiting in Calibrating.
 */
export function calibrationFromEnv(env: Record<string, string | undefined>, board?: BoardSink): { calibrate: Calibrate; panel: FrozenPanel } | { off: string } {
  if (env.BUGFARM_CALIBRATION === '0' || env.BUGFARM_CALIBRATION === 'false') return { off: 'BUGFARM_CALIBRATION=0' };
  const panelId = env.BUGFARM_CALIBRATION_PANEL || 'cal-v2';
  let panel: FrozenPanel;
  try {
    panel = loadFrozenPanel(panelId);
  } catch (err) {
    return { off: err instanceof Error ? err.message : String(err) };
  }
  const keyFile = env.BUGFARM_CAMPAIGN_KEY_FILE;
  if (!keyFile || !fileExists(keyFile)) return { off: `no campaign gateway key (set BUGFARM_CAMPAIGN_KEY_FILE to the file calibrate.ts mint-key wrote)` };
  const key = readCampaignKey(keyFile);
  const url = env.BUGFARM_GATEWAY_URL || 'http://localhost:4400';
  const dot = env.BUGFARM_STABLEHAND_ENV && fileExists(env.BUGFARM_STABLEHAND_ENV) ? readDotenv(env.BUGFARM_STABLEHAND_ENV) : {};
  const meteringKey = env.BUGFARM_GATEWAY_METERING_KEY || dot.STABLEHAND_MODEL_GATEWAY_METERING_KEY;
  const slots = Number(env.BUGFARM_CALIBRATION_SLOTS);
  const gateway: GatewayContext = {
    url,
    key,
    spendLog: meteringKey ? new SpendLog({ gatewayUrl: url, meteringKey, keyAlias: key.key_alias, sinceMs: key.created_at || Date.now() - 30 * 86_400_000 }) : undefined,
  };
  return { panel, calibrate: foremanCalibrate({ panel, gateway, board, slots: new Semaphore(Number.isInteger(slots) && slots > 0 ? slots : 6) }) };
}

export function foremanCalibrate(opts: ForemanCalibrateOptions): Calibrate {
  const panel = typeof opts.panel === 'string' ? loadFrozenPanel(opts.panel) : opts.panel;
  const slots = opts.slots ?? new Semaphore(6);
  const costModel = new CostModel(panel.models);
  const pools = new Map<string, Promise<CampaignPool>>();
  let warned = false;

  // Attempts this campaign already made under the panel, e.g. before a restart. Records a dead
  // process left `running` are settled first. No attempt of this campaign is live yet when its
  // pool is created: every attempt launches through the pool, and concurrent first calls share
  // this one promise, so none of them launches before the pool is seeded.
  const createPool = async (c: CampaignBudget): Promise<CampaignPool> => {
    const pool = new CampaignPool(c.capUsd, c.otherSpendUsd);
    const mine = (a: AttemptRecord) => a.item.startsWith(`${c.id}:`);
    const recovered: AttemptRecord[] = [];
    let prior = 0;
    for (const store of taskStores(panel.id)) {
      recovered.push(...recoverInterrupted(store, mine));
      for (const a of store.all()) {
        if (a.status !== 'done' || !mine(a)) continue;
        prior += bestCost(a);
        if (a.cost_usd_estimate !== undefined) costModel.observe(a.model, a.cost_usd_estimate);
      }
    }
    pool.adjust(prior);
    log('cal', `campaign ${c.id}: calibration budget gate on a $${c.capUsd.toFixed(2)} cap; $${prior.toFixed(2)} of calibration already spent, $${pool.remaining().toFixed(2)} left`);
    if (recovered.length && opts.board) await opts.board.write(recovered.map(attemptRow));
    return pool;
  };
  const poolFor = (c: CampaignBudget): Promise<CampaignPool> => {
    let p = pools.get(c.id);
    if (!p) {
      p = createPool(c);
      pools.set(c.id, p);
    }
    return p;
  };

  return async (taskDir, requested, budget) => {
    const mismatch = panelMismatch(panel, requested);
    if (mismatch && !warned) {
      warned = true;
      log('cal', `the foreman's panel differs from frozen panel ${panel.id}; calibrating on ${panel.id} (${mismatch})`);
    }
    const keyCampaign = opts.gateway.key.tags.campaign;
    if (budget.tags.campaign && keyCampaign !== budget.tags.campaign) {
      // The key's tags decide which budget its spend lands on; a mismatch would spend outside the cap.
      throw new Error(`the calibration gateway key is for campaign "${keyCampaign ?? 'none'}", not "${budget.tags.campaign}"; mint a key for this campaign (calibrate.ts mint-key --campaign ${budget.tags.campaign})`);
    }
    const pool = budget.campaign ? await poolFor(budget.campaign) : undefined;

    // The card's own budget covers every attempt it has had under this panel.
    const task = readTaskInfo(taskDir, budget.item);
    const store = new AttemptStore(panel.id, task.name);
    const forItem = (a: AttemptRecord) => a.item === budget.item;
    const recovered = recoverInterrupted(store, forItem);
    if (recovered.length) {
      pool?.adjust(recovered.reduce((s, a) => s + bestCost(a), 0));
      if (opts.board) await opts.board.write(recovered.map(attemptRow));
    }
    const spentOnCard = store.all().filter((a) => a.status === 'done' && forItem(a)).reduce((s, a) => s + bestCost(a), 0);

    const r = await calibrate(taskDir, panel, Math.max(0, budget.maxUsd - spentOnCard), {
      gateway: opts.gateway,
      board: opts.board,
      slots,
      costModel,
      pools: pool ? [pool] : [],
      itemKey: budget.item,
      writeStage: false,
      spendTags: budget.tags,
      runId: budget.tags.campaign ? `${budget.tags.campaign}-${panel.id}` : undefined,
    });
    return toOutcome(r, panel);
  };
}
