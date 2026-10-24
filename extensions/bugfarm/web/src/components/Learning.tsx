import { ArrowDownRight, ArrowUpRight, CheckCircle2, FlaskConical, Undo2 } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useState } from 'react';
import { rejectReasonLabel } from '../../../src/shared/board';
import { GATE_LABELS, type LearningGate, type MeasuredEffect } from '../../../src/shared/learning';
import { describePredicate, type Predicate } from '../../../src/shared/predicate';
import type { Batch, BoardView, Rule } from '../lib/derive';
import { pct, signedPts, signedUsd, usd } from '../lib/format';

/** One batch on the curve: the learning loop's numbers when it wrote them, else the batch row's. */
interface Point {
  batch: Batch;
  share: number | null;
  perAccepted: number | null;
  accepted: number;
  decided: number;
  cost: number | null;
  running: boolean;
}

function pointOf(batch: Batch): Point {
  const learn = batch.learn;
  if (learn) {
    return { batch, share: learn.share, perAccepted: learn.usd_per_accepted, accepted: learn.accepted, decided: learn.decided, cost: learn.cost_usd, running: false };
  }
  const accepted = batch.accepted ?? 0;
  const decided = batch.status === 'done' && batch.candidates ? batch.candidates : accepted + (batch.rejected ?? 0);
  return { batch, share: batch.share, perAccepted: batch.usdPerAccepted, accepted, decided, cost: batch.cost_usd ?? null, running: batch.status !== 'done' };
}

interface ChartProps {
  title: string;
  note: string;
  points: Point[];
  value: (point: Point) => number | null;
  format: (value: number) => string;
  /** The counts behind a bar, under its batch number. */
  counts: (point: Point) => string;
  /** Lower is better (dollars); only changes the wording of the summary. */
  lowerIsBetter?: boolean;
}

/** Evenly spaced gridlines on round values: the smallest 1/2/2.5/5 step giving at most five. */
function ticksFor(max: number): number[] {
  for (let exp = -2; exp <= 5; exp += 1) {
    for (const base of [1, 2, 2.5, 5]) {
      const step = base * 10 ** exp;
      const count = max / step;
      if (count <= 5 + 1e-9 && Math.abs(count - Math.round(count)) < 1e-9) {
        return Array.from({ length: Math.round(count) + 1 }, (_, index) => index * step);
      }
    }
  }
  return [0, max];
}

function niceMax(max: number, isShare: boolean): number {
  if (isShare) return Math.min(1, Math.max(0.25, Math.ceil(max * 4 + 0.4) / 4));
  const steps = [1, 2, 2.5, 5, 10];
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(max, 0.01)));
  for (const step of steps) if (step * magnitude >= max * 1.1) return step * magnitude;
  return 10 * magnitude;
}

function BatchChart({ title, note, points, value, format, counts, lowerIsBetter = false }: ChartProps) {
  const reduced = useReducedMotion();
  const [hover, setHover] = useState<number | null>(null);
  const values = points.map((point) => ({ point, v: value(point) }));
  const known = values.filter((entry): entry is { point: Point; v: number } => entry.v !== null);
  const isShare = !lowerIsBetter;
  const max = niceMax(Math.max(...known.map((entry) => entry.v), 0), isShare);
  const ticks = ticksFor(max);
  const first = known[0];
  const last = known[known.length - 1];
  const finished = known.filter((entry) => !entry.point.running);
  const firstDone = finished[0];
  const lastDone = finished[finished.length - 1];
  const hovered = hover !== null ? values.find((entry) => entry.point.batch.n === hover) : null;

  return (
    <figure className="min-w-0 rounded-well bg-well p-4 sm:p-5">
      <figcaption>
        <h3 className="wdth-semi text-[1.2rem] font-bold">{title}</h3>
        <p className="text-[0.9rem] text-ink-2">
          {firstDone && lastDone && firstDone !== lastDone
            ? `${format(firstDone.v)} in batch ${firstDone.point.batch.n}, ${format(lastDone.v)} in batch ${lastDone.point.batch.n}. ${note}`
            : note}
        </p>
      </figcaption>
      <div className="mt-5 grid grid-cols-[2.75rem_minmax(0,1fr)]">
        <div className="relative h-52 sm:h-60" aria-hidden>
          {ticks.map((tick) => (
            <span key={tick} className="absolute right-2 translate-y-1/2 text-[0.75rem] text-ink-3 tnum" style={{ bottom: `${(tick / max) * 100}%` }}>
              {isShare ? pct(tick) : usd(tick, Number.isInteger(tick) ? 0 : 2)}
            </span>
          ))}
        </div>
        <div className="min-w-0">
          <div className="relative flex h-52 items-end gap-2 sm:h-60">
            {ticks.map((tick) => (
              <span key={tick} className="pointer-events-none absolute inset-x-0 h-px bg-line" style={{ bottom: `${(tick / max) * 100}%` }} aria-hidden />
            ))}
            {values.map(({ point, v }) => {
              const labelled = v !== null && (point === first?.point || point === last?.point || hover === point.batch.n);
              return (
                <button
                  key={point.batch.n}
                  type="button"
                  className="relative flex h-full min-w-0 flex-1 items-end justify-center focus-visible:outline-offset-4"
                  onPointerEnter={() => setHover(point.batch.n)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(point.batch.n)}
                  onBlur={() => setHover(null)}
                  aria-label={`Batch ${point.batch.n}${point.running ? ', still running' : ''}: ${v === null ? 'no data yet' : `${format(v)}, ${counts(point)}`}`}
                >
                  {v !== null && (
                    <motion.span
                      className={`relative block w-6 rounded-t-[4px] sm:w-8 ${point.running ? 'bg-chart/35' : 'bg-chart'} ${hover === point.batch.n ? 'brightness-110' : ''}`}
                      initial={reduced ? false : { height: 0 }}
                      animate={{ height: `${Math.max(1, (v / max) * 100)}%` }}
                      transition={{ type: 'spring', stiffness: 90, damping: 18 }}
                    >
                      {labelled && (
                        <span className="absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2 whitespace-nowrap text-[0.85rem] font-semibold text-ink tnum">
                          {format(v)}
                        </span>
                      )}
                    </motion.span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex gap-2" aria-hidden>
            {values.map(({ point, v }) => (
              <span key={point.batch.n} className={`min-w-0 flex-1 text-center leading-tight tnum ${point.running ? 'text-ink-3' : 'text-ink-2'}`}>
                <span className="block text-[0.8rem] font-semibold">{point.batch.n}</span>
                <span className="block truncate text-[0.72rem] text-ink-3">{v === null ? '' : counts(point)}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
      <p className="mt-1 pl-11 text-[0.8rem] text-ink-3">
        {hovered && hovered.v !== null
          ? `Batch ${hovered.point.batch.n}${hovered.point.running ? ' so far' : ''}: ${format(hovered.v)} (${counts(hovered.point)})`
          : `By batch, counts under each bar. Faded bars are still running. ${lowerIsBetter ? 'Lower is better.' : 'Higher is better.'}`}
      </p>
    </figure>
  );
}

const RULE_KIND: Record<string, string> = {
  scout_filter: 'Scout filter',
  writer_rule: 'Writer rule',
  env_recipe: 'Env recipe',
};

function RuleStatus({ status }: { status: Rule['status'] }) {
  if (status === 'kept') {
    return <span className="inline-flex items-center gap-1.5 rounded-full bg-sprout/15 px-2.5 py-0.5 text-[0.85rem] font-semibold"><CheckCircle2 size={15} className="text-sprout" aria-hidden />Kept</span>;
  }
  if (status === 'reverted') {
    return <span className="inline-flex items-center gap-1.5 rounded-full bg-ink-3/15 px-2.5 py-0.5 text-[0.85rem] font-semibold text-ink-2"><Undo2 size={15} aria-hidden />Reverted</span>;
  }
  return <span className="inline-flex items-center gap-1.5 rounded-full bg-pollen/15 px-2.5 py-0.5 text-[0.85rem] font-semibold"><FlaskConical size={15} className="text-pollen" aria-hidden />On trial</span>;
}

function count(n: number, of: number): string {
  return `${n} of ${of}`;
}

function batchLine(label: string, numbers: NonNullable<MeasuredEffect['before']>): string {
  return `${label} ${numbers.batch}: ${count(numbers.accepted, numbers.decided)} (${pct(numbers.share)}), ${usd(numbers.usd_per_accepted)} each`;
}

function Effect({ rule }: { rule: Rule }) {
  const effect = rule.effect as MeasuredEffect | null | undefined;
  if (!effect || (effect.accepted_share_pts === undefined && effect.usd_per_accepted === undefined && !effect.after)) {
    return <span className="text-ink-3">Measured when batch {rule.batch_introduced} finishes.</span>;
  }
  const parts: string[] = [];
  if (effect.accepted_share_pts !== undefined) parts.push(`${signedPts(effect.accepted_share_pts)} accepted`);
  if (effect.usd_per_accepted !== undefined) parts.push(`${signedUsd(effect.usd_per_accepted)} per accepted task`);
  const target = effect.target_reason;
  return (
    <span className="block text-ink-2">
      <span className="block">{parts.join(', ') || 'No comparable numbers'}{effect.before && effect.after ? ` (batch ${effect.after.batch} against batch ${effect.before.batch})` : ''}.</span>
      {target && effect.target_before && effect.target_after && (
        <span className="block">
          {rejectReasonLabel(target)}: {count(effect.target_before.count, effect.target_before.decided)} → {count(effect.target_after.count, effect.target_after.decided)}
          {effect.checks ? (effect.checks.target_dropped ? ', fell.' : ', did not fall.') : '.'}
          {effect.filtered !== undefined ? ` The filter dropped ${effect.filtered} candidate${effect.filtered === 1 ? '' : 's'} before they became cards.` : ''}
        </span>
      )}
      {effect.before && effect.after && (
        <span className="block text-ink-3">{batchLine('Batch', effect.before)}; {batchLine('batch', effect.after)}.</span>
      )}
      {effect.measured_with && effect.measured_with.length > 0 && (
        <span className="block text-ink-3">On trial with {effect.measured_with.length} other rule{effect.measured_with.length === 1 ? '' : 's'}: one shared measurement.</span>
      )}
    </span>
  );
}

function RuleRow({ rule }: { rule: Rule }) {
  const predicate = rule.skip_if ? describePredicate(rule.skip_if as Predicate) : null;
  const source = rule.source === 'teacher' ? `Teacher, from batch ${Number(rule.learned_from_batch ?? rule.batch_introduced - 1)}` : rule.source === 'starter' ? 'Starter rule' : rule.source === 'hand' ? 'Added by hand' : null;
  return (
    <li className="grid gap-x-5 gap-y-1.5 px-4 py-3.5 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:px-5">
      <span className="self-start"><RuleStatus status={rule.status} /></span>
      <span className="min-w-0 text-[0.88rem]">
        <span className={`block text-[1.02rem] font-semibold leading-snug ${rule.status === 'reverted' ? 'text-ink-2 line-through decoration-ink-3/60' : ''}`}>{rule.text}</span>
        {predicate && (
          <code className="mt-1 block overflow-x-auto whitespace-pre-wrap break-words rounded-card bg-card px-2.5 py-1.5 font-mono text-[0.8rem] text-ink-2">skip if {predicate}</code>
        )}
        <span className="mt-1 block text-ink-3">
          {RULE_KIND[rule.kind ?? ''] ?? 'Rule'}{source ? ` · ${source}` : ''} · on trial in batch {rule.batch_introduced}
          {rule.targets ? <> · targets <span className="text-ink-2">{rejectReasonLabel(rule.targets)}</span></> : null}
        </span>
        {rule.expected_effect && <span className="block text-ink-3">Expected: {rule.expected_effect}</span>}
        <span className="mt-1 block"><Effect rule={rule} /></span>
      </span>
    </li>
  );
}

/** Rejection reasons by batch: counts of decided candidates, with the change from the batch before. */
function ReasonsTable({ points }: { points: Point[] }) {
  const measured = points.filter((point) => point.batch.learn);
  const reasons = [...new Set(measured.flatMap((point) => Object.keys(point.batch.learn?.reasons ?? {})))]
    .sort((a, b) => {
      const total = (reason: string) => measured.reduce((sum, point) => sum + (point.batch.learn?.reasons[reason] ?? 0), 0);
      return total(b) - total(a) || a.localeCompare(b);
    });
  if (measured.length === 0) return null;
  const share = (point: Point, reason: string) => (point.decided > 0 ? (point.batch.learn?.reasons[reason] ?? 0) / point.decided : 0);
  const fell = reasons.filter((reason) => measured.length > 1 && share(measured[measured.length - 1], reason) < share(measured[0], reason));
  return (
    <section aria-labelledby="reasons-heading">
      <h3 id="reasons-heading" className="wdth-semi text-[1.35rem] font-bold">Why candidates fell out</h3>
      <p className="mt-1 text-[0.92rem] text-ink-2">
        {reasons.length === 0
          ? 'No candidate has been rejected yet.'
          : fell.length > 0
            ? `Fell from batch ${measured[0].batch.n} to batch ${measured[measured.length - 1].batch.n}: ${fell.map(rejectReasonLabel).join(', ')}.`
            : 'No reason has fallen since the first batch yet.'}
        {' '}Each cell is rejects out of decided candidates; arrows compare with the batch before.
      </p>
      {reasons.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-well bg-well scrollbar-thin">
          <table className="w-full min-w-[30rem] text-left text-[0.92rem]">
            <thead className="text-[0.82rem] text-ink-3">
              <tr>
                <th className="px-4 py-2.5 font-medium">Reason</th>
                {measured.map((point) => <th key={point.batch.n} className="px-4 py-2.5 text-right font-medium">Batch {point.batch.n}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-line tnum">
              {reasons.map((reason) => (
                <tr key={reason}>
                  <td className="px-4 py-2.5">{rejectReasonLabel(reason)}<span className="ml-2 font-mono text-[0.75rem] text-ink-3">{reason}</span></td>
                  {measured.map((point, index) => {
                    const n = point.batch.learn?.reasons[reason] ?? 0;
                    const previous = index > 0 ? measured[index - 1] : null;
                    const delta = previous ? share(point, reason) - share(previous, reason) : 0;
                    const Icon = delta < 0 ? ArrowDownRight : ArrowUpRight;
                    return (
                      <td key={point.batch.n} className="px-4 py-2.5 text-right">
                        <span className="inline-flex items-center justify-end gap-1">
                          {previous && Math.abs(delta) > 1e-9 && <Icon size={14} strokeWidth={2.6} className={delta < 0 ? 'text-sprout' : 'text-ember'} aria-label={delta < 0 ? 'fell' : 'rose'} />}
                          {n}/{point.decided}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {measured.some((point) => (point.batch.learn?.filtered ?? 0) > 0) && (
                <tr className="text-ink-2">
                  <td className="px-4 py-2.5">Dropped by Scout filters before checking</td>
                  {measured.map((point) => <td key={point.batch.n} className="px-4 py-2.5 text-right">{point.batch.learn?.filtered ?? 0}</td>)}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function gateOf(points: Point[]): LearningGate | null {
  return points.find((point) => point.batch.learn)?.batch.learn?.gate ?? null;
}

export function Learning({ view }: { view: BoardView }) {
  const points = view.batches.map(pointOf);
  const gate = gateOf(points);
  const sizes = points.filter((point) => point.decided > 0).map((point) => point.decided);
  const typical = sizes.length > 0 ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0;
  const setup = points.reduce((sum, point) => sum + (point.batch.learn?.setup_usd ?? 0), 0);
  return (
    <div className="mx-4 mt-6 space-y-6 pb-10 sm:mx-6">
      <div className="max-w-3xl">
        <h2 className="wdth-semi text-[1.9rem] font-bold leading-tight sm:text-[2.3rem]">Each batch learns from the last one's rejects</h2>
        <p className="mt-2 text-[1rem] text-ink-2">
          After a batch, the Teacher reads why its candidates were rejected and proposes rules. A rule goes on trial in the next batch and stays only if the reason it targets falls and the batch keeps more candidates or spends less per task; otherwise it is reverted.
        </p>
        {gate && (
          <p className="mt-2 text-[0.92rem] text-ink-2">
            Accepted here means {GATE_LABELS[gate]}{gate === 'controls' ? ': the tests fail before the fix and pass after it, the instruction passes the leak review, and the oracle and nop controls score 1 and 0. This campaign ran without calibration verdicts.' : '.'}
          </p>
        )}
        {typical > 0 && (
          <p className="mt-2 text-[0.92rem] text-ink-3">
            Batches are small: at about {typical} decided candidates, one card moves the share by {Math.round(100 / typical)} points. Read the counts, not just the percentages.
          </p>
        )}
      </div>

      {points.length === 0 ? (
        <div className="rounded-well bg-well p-8 text-ink-2">The curve appears after the first batch finishes.</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <BatchChart
            title="Accepted share"
            note="Accepted out of decided candidates."
            points={points}
            value={(point) => point.share}
            format={(v) => pct(v)}
            counts={(point) => count(point.accepted, point.decided)}
          />
          <BatchChart
            title="Dollars per accepted task"
            note={`The batch's floor-agent spend, divided by what it accepted${setup > 0 ? `. The one-off environment build (${usd(setup)}) is left out` : ''}.`}
            points={points}
            value={(point) => point.perAccepted}
            format={(v) => usd(v)}
            counts={(point) => `${usd(point.cost)} ÷ ${point.accepted}`}
            lowerIsBetter
          />
        </div>
      )}

      <section aria-labelledby="rules-heading">
        <h3 id="rules-heading" className="wdth-semi text-[1.35rem] font-bold">Rule changes</h3>
        {view.rules.length === 0 ? (
          <p className="mt-2 text-ink-2">No rule changes yet. The first ones come from the first batch's rejects.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line overflow-hidden rounded-well bg-well">
            {view.rules.map((rule) => <RuleRow key={rule.key} rule={rule} />)}
          </ul>
        )}
      </section>

      <ReasonsTable points={points} />

      {points.length > 0 && (
        <section aria-labelledby="batches-heading">
          <h3 id="batches-heading" className="wdth-semi text-[1.35rem] font-bold">Batches</h3>
          <div className="mt-3 overflow-x-auto rounded-well bg-well scrollbar-thin">
            <table className="w-full min-w-[40rem] text-left text-[0.95rem]">
              <thead className="text-[0.82rem] text-ink-3">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Batch</th>
                  <th className="px-4 py-2.5 text-right font-medium">Candidates</th>
                  <th className="px-4 py-2.5 text-right font-medium">Accepted</th>
                  <th className="px-4 py-2.5 text-right font-medium">Share</th>
                  <th className="px-4 py-2.5 text-right font-medium">Spent</th>
                  <th className="px-4 py-2.5 text-right font-medium">Per accepted</th>
                  <th className="px-4 py-2.5 text-right font-medium">Rules run</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line tnum">
                {[...points].reverse().map((point) => (
                  <tr key={point.batch.n}>
                    <td className="px-4 py-2.5 font-semibold">{point.batch.n}{point.running && <span className="ml-2 font-normal text-ink-3">running</span>}</td>
                    <td className="px-4 py-2.5 text-right">{point.batch.learn?.candidates ?? point.batch.candidates ?? '—'}{point.batch.learn?.filtered ? <span className="text-ink-3"> +{point.batch.learn.filtered} dropped</span> : null}</td>
                    <td className="px-4 py-2.5 text-right">{count(point.accepted, point.decided)}</td>
                    <td className="px-4 py-2.5 text-right">{pct(point.share)}</td>
                    <td className="px-4 py-2.5 text-right">{usd(point.cost)}</td>
                    <td className="px-4 py-2.5 text-right">{usd(point.perAccepted)}</td>
                    <td className="px-4 py-2.5 text-right">{point.batch.learn ? point.batch.learn.rules_served.length : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
