import type { BatchLearning, MeasuredEffect } from '../shared/learning.js';
import { numbersOf } from './metrics.js';

/**
 * A rule earns its place by measurement. A new rule is on `trial` for the batch after the one it
 * was learned from; when that batch finishes it is compared with the batch before:
 *
 * - **kept** when the reason it targets drops (as a share of decided candidates) and the batch's
 *   accepted share rises or its dollars per accepted task fall;
 * - **reverted** otherwise. A reverted rule stays in the store, marked, and is no longer served.
 *
 * Rules on trial in the same batch share one measurement; only their targets tell them apart.
 * Batches of about ten are noisy (one card moves the share by ten points), so the effect keeps
 * the counts as well as the rates.
 */

export interface Verdict {
  status: 'kept' | 'reverted';
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

export function judgeRule(opts: {
  target: string | null | undefined;
  before: BatchLearning;
  after: BatchLearning;
  filtered?: number;
  measuredWith?: string[];
}): Verdict {
  const { before, after } = opts;
  const target = opts.target ?? '';
  const tb = before.reasons[target] ?? 0;
  const ta = after.reasons[target] ?? 0;
  const rb = rate(tb, before.decided);
  const ra = rate(ta, after.decided);
  const targetDropped = target !== '' && rb !== null && rb > 0 && ra !== null && ra < rb;
  const shareImproved = before.share !== null && after.share !== null && after.share > before.share;
  const usdImproved = after.usd_per_accepted !== null && (before.usd_per_accepted === null || after.usd_per_accepted < before.usd_per_accepted);
  const kept = targetDropped && (shareImproved || usdImproved);

  const why: string[] = [];
  why.push(target
    ? `${target} ${tb}/${before.decided} → ${ta}/${after.decided}${targetDropped ? ' (fell)' : ' (did not fall)'}`
    : 'no target reason');
  why.push(`accepted ${before.accepted}/${before.decided} (${pct(before.share)}) → ${after.accepted}/${after.decided} (${pct(after.share)})`);
  why.push(`per accepted ${usd(before.usd_per_accepted)} → ${usd(after.usd_per_accepted)}`);

  const effect: MeasuredEffect = {
    gate: after.gate,
    summary: `${kept ? 'Kept' : 'Reverted'} on batch ${after.batch} vs ${before.batch}: ${why.join('; ')}.`,
    target_reason: target || undefined,
    target_before: { count: tb, decided: before.decided },
    target_after: { count: ta, decided: after.decided },
    before: numbersOf(before),
    after: numbersOf(after),
    checks: { target_dropped: targetDropped, share_improved: shareImproved, usd_improved: usdImproved },
  };
  if (before.share !== null && after.share !== null) effect.accepted_share_pts = Math.round((after.share - before.share) * 1000) / 10;
  if (before.usd_per_accepted !== null && after.usd_per_accepted !== null) {
    effect.usd_per_accepted = Math.round((after.usd_per_accepted - before.usd_per_accepted) * 10_000) / 10_000;
  }
  if (opts.filtered !== undefined) effect.filtered = opts.filtered;
  if (opts.measuredWith && opts.measuredWith.length > 0) effect.measured_with = opts.measuredWith;
  return { status: kept ? 'kept' : 'reverted', effect };
}
