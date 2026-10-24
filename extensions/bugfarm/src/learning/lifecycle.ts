import type { BatchLearning, BatchNumbers, MeasuredEffect } from '../shared/learning.js';
import { numbersOf } from './metrics.js';

/**
 * A rule earns its place by measurement. A new rule is on `trial` for the batch after the one it
 * was learned from; when that batch finishes it is compared with the batch before the trial:
 *
 * - **kept** when the reason it targets drops (as a share of decided candidates) and the accepted
 *   share rises or the dollars per accepted task fall;
 * - **reverted** otherwise. A reverted rule stays in the store, marked, and is no longer served.
 *
 * A trial batch with fewer than `minDecided` decided candidates is too small to say anything (a
 * filter that drops most of the Scout's list can make one card look like a 100% batch). The rule
 * then stays on trial, the next batch is pooled with it, and when the campaign ends with the
 * trial still too small, the rule is reverted: it never showed an effect.
 *
 * Rules on trial in the same batch share one measurement; only their targets tell them apart.
 * Batches of about ten are noisy (one card moves the share by ten points), so the effect keeps
 * the counts as well as the rates.
 */

export const MIN_DECIDED = 5;

export interface Verdict {
  /** `trial`: too few decided candidates yet; measured again after the next batch. */
  status: 'kept' | 'reverted' | 'trial';
  effect: MeasuredEffect;
}

function rate(count: number, decided: number): number | null {
  return decided > 0 ? count / decided : null;
}

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function usd(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(2)}`;
}

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Several trial batches as one: counts, reasons, spend and filter drops summed. */
export function poolBatches(batches: BatchLearning[]): BatchLearning & { batches: number[] } {
  const last = batches[batches.length - 1];
  const sum = (pick: (b: BatchLearning) => number) => batches.reduce((total, b) => total + pick(b), 0);
  const accepted = sum((b) => b.accepted);
  const decided = sum((b) => b.decided);
  const cost = sum((b) => b.cost_usd);
  const reasons: Record<string, number> = {};
  const filteredBy: Record<string, number> = {};
  for (const b of batches) {
    for (const [reason, n] of Object.entries(b.reasons)) reasons[reason] = (reasons[reason] ?? 0) + n;
    for (const [rule, n] of Object.entries(b.filtered_by)) filteredBy[rule] = (filteredBy[rule] ?? 0) + n;
  }
  return {
    ...last,
    batches: batches.map((b) => b.batch),
    candidates: sum((b) => b.candidates),
    accepted,
    decided,
    share: decided > 0 ? round(accepted / decided) : null,
    cost_usd: round(cost),
    usd_per_accepted: accepted > 0 ? round(cost / accepted) : null,
    reasons,
    passed_controls: sum((b) => b.passed_controls),
    filtered: sum((b) => b.filtered),
    filtered_by: filteredBy,
  };
}

function label(numbers: BatchNumbers): string {
  const batches = numbers.batches ?? [numbers.batch];
  return batches.length > 1 ? `batches ${batches[0]}–${batches[batches.length - 1]}` : `batch ${numbers.batch}`;
}

export function judgeRule(opts: {
  target: string | null | undefined;
  before: BatchLearning;
  /** The trial: one batch, or several pooled with `poolBatches`. */
  after: BatchLearning & { batches?: number[] };
  filtered?: number;
  measuredWith?: string[];
  /** Fewer decided candidates than this in the trial defers the verdict. */
  minDecided?: number;
  /** The campaign's last batch: no later batch can be pooled, so a deferred rule is reverted. */
  final?: boolean;
}): Verdict {
  const { before, after } = opts;
  const minDecided = opts.minDecided ?? MIN_DECIDED;
  const target = opts.target ?? '';
  const tb = before.reasons[target] ?? 0;
  const ta = after.reasons[target] ?? 0;
  const rb = rate(tb, before.decided);
  const ra = rate(ta, after.decided);
  const targetDropped = target !== '' && rb !== null && rb > 0 && ra !== null && ra < rb;
  const shareImproved = before.share !== null && after.share !== null && after.share > before.share;
  const usdImproved = after.usd_per_accepted !== null && (before.usd_per_accepted === null || after.usd_per_accepted < before.usd_per_accepted);
  const tooSmall = after.decided < minDecided;
  const status: Verdict['status'] = tooSmall ? (opts.final ? 'reverted' : 'trial') : targetDropped && (shareImproved || usdImproved) ? 'kept' : 'reverted';

  const afterNumbers: BatchNumbers = { ...numbersOf(after), ...(after.batches && after.batches.length > 1 ? { batches: after.batches } : {}) };
  const beforeNumbers = numbersOf(before);
  const why: string[] = [];
  why.push(target
    ? `${target} ${tb}/${before.decided} → ${ta}/${after.decided}${targetDropped ? ' (fell)' : ' (did not fall)'}`
    : 'no target reason');
  why.push(`accepted ${before.accepted}/${before.decided} (${pct(before.share)}) → ${after.accepted}/${after.decided} (${pct(after.share)})`);
  why.push(`per accepted ${usd(before.usd_per_accepted)} → ${usd(after.usd_per_accepted)}`);
  const versus = `${label(afterNumbers)} vs ${label(beforeNumbers)}`;
  const summary = !tooSmall
    ? `${status === 'kept' ? 'Kept' : 'Reverted'} on ${versus}: ${why.join('; ')}.`
    : opts.final
      ? `Reverted: only ${after.decided} decided candidate(s) ran with it (${versus}), fewer than the ${minDecided} needed to show an effect; ${why.join('; ')}.`
      : `Too few to judge on ${versus}: ${after.decided} decided, ${minDecided} needed; stays on trial and the next batch is pooled with it. So far: ${why.join('; ')}.`;

  const effect: MeasuredEffect = {
    gate: after.gate,
    summary,
    target_reason: target || undefined,
    target_before: { count: tb, decided: before.decided },
    target_after: { count: ta, decided: after.decided },
    before: beforeNumbers,
    after: afterNumbers,
    checks: { target_dropped: targetDropped, share_improved: shareImproved, usd_improved: usdImproved },
    ...(tooSmall ? { too_small: true, min_decided: minDecided } : {}),
  };
  if (before.share !== null && after.share !== null) effect.accepted_share_pts = Math.round((after.share - before.share) * 1000) / 10;
  if (before.usd_per_accepted !== null && after.usd_per_accepted !== null) {
    effect.usd_per_accepted = Math.round((after.usd_per_accepted - before.usd_per_accepted) * 10_000) / 10_000;
  }
  if (opts.filtered !== undefined) effect.filtered = opts.filtered;
  if (opts.measuredWith && opts.measuredWith.length > 0) effect.measured_with = opts.measuredWith;
  return { status, effect };
}
