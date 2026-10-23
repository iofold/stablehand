import { CheckCircle2, FlaskConical, Undo2 } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useState } from 'react';
import type { Batch, BoardView, Rule } from '../lib/derive';
import { pct, signedPts, signedUsd, usd } from '../lib/format';

interface ChartProps {
  title: string;
  note: string;
  batches: Batch[];
  value: (batch: Batch) => number | null;
  format: (value: number) => string;
  /** Lower is better (dollars); only changes the wording of the summary. */
  lowerIsBetter?: boolean;
}

function niceMax(max: number, isShare: boolean): number {
  if (isShare) return Math.min(1, Math.max(0.25, Math.ceil(max * 4 + 0.4) / 4));
  const steps = [1, 2, 2.5, 5, 10];
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(max, 0.01)));
  for (const step of steps) if (step * magnitude >= max * 1.1) return step * magnitude;
  return 10 * magnitude;
}

function BatchChart({ title, note, batches, value, format, lowerIsBetter = false }: ChartProps) {
  const reduced = useReducedMotion();
  const [hover, setHover] = useState<number | null>(null);
  const points = batches.map((batch) => ({ batch, v: value(batch) }));
  const known = points.filter((point): point is { batch: Batch; v: number } => point.v !== null);
  const isShare = !lowerIsBetter;
  const max = niceMax(Math.max(...known.map((point) => point.v), 0), isShare);
  const ticks = [0, max / 2, max];
  const first = known[0];
  const last = known[known.length - 1];
  const finished = known.filter((point) => point.batch.status === 'done');
  const firstDone = finished[0];
  const lastDone = finished[finished.length - 1];
  const hovered = hover !== null ? points.find((point) => point.batch.n === hover) : null;

  return (
    <figure className="min-w-0 rounded-well bg-well p-4 sm:p-5">
      <figcaption>
        <h3 className="wdth-semi text-[1.2rem] font-bold">{title}</h3>
        <p className="text-[0.9rem] text-ink-2">
          {firstDone && lastDone && firstDone !== lastDone
            ? `${format(firstDone.v)} in batch ${firstDone.batch.n}, ${format(lastDone.v)} in batch ${lastDone.batch.n}. ${note}`
            : note}
        </p>
      </figcaption>
      <div className="mt-5 grid grid-cols-[2.75rem_minmax(0,1fr)]">
        <div className="relative h-52 sm:h-60" aria-hidden>
          {ticks.map((tick) => (
            <span key={tick} className="absolute right-2 translate-y-1/2 text-[0.75rem] text-ink-3 tnum" style={{ bottom: `${(tick / max) * 100}%` }}>
              {format(tick)}
            </span>
          ))}
        </div>
        <div className="min-w-0">
          <div className="relative flex h-52 items-end gap-2 sm:h-60">
            {ticks.map((tick) => (
              <span key={tick} className="pointer-events-none absolute inset-x-0 h-px bg-line" style={{ bottom: `${(tick / max) * 100}%` }} aria-hidden />
            ))}
            {points.map(({ batch, v }) => {
              const running = batch.status !== 'done';
              const labelled = v !== null && (batch === first?.batch || batch === last?.batch || hover === batch.n);
              return (
                <button
                  key={batch.n}
                  type="button"
                  className="relative flex h-full min-w-0 flex-1 items-end justify-center focus-visible:outline-offset-4"
                  onPointerEnter={() => setHover(batch.n)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(batch.n)}
                  onBlur={() => setHover(null)}
                  aria-label={`Batch ${batch.n}${running ? ', still running' : ''}: ${v === null ? 'no data yet' : format(v)}`}
                >
                  {v !== null && (
                    <motion.span
                      className={`relative block w-6 rounded-t-[4px] ${running ? 'bg-chart/35' : 'bg-chart'} ${hover === batch.n ? 'brightness-110' : ''}`}
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
            {points.map(({ batch }) => (
              <span key={batch.n} className={`min-w-0 flex-1 text-center text-[0.8rem] tnum ${batch.status !== 'done' ? 'text-ink-3' : 'text-ink-2'}`}>
                {batch.n}
              </span>
            ))}
          </div>
        </div>
      </div>
      <p className="mt-1 pl-11 text-[0.8rem] text-ink-3">
        {hovered && hovered.v !== null
          ? `Batch ${hovered.batch.n}${hovered.batch.status !== 'done' ? ' so far' : ''}: ${format(hovered.v)}`
          : `By batch. Faded bars are still running. ${lowerIsBetter ? 'Lower is better.' : 'Higher is better.'}`}
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

function Effect({ rule }: { rule: Rule }) {
  const effect = rule.effect;
  if (!effect || (effect.accepted_share_pts === undefined && effect.usd_per_accepted === undefined)) {
    return <span className="text-ink-3">Measured when batch {rule.batch_introduced} finishes</span>;
  }
  const parts: string[] = [];
  if (effect.accepted_share_pts !== undefined) parts.push(`${signedPts(effect.accepted_share_pts)} accepted`);
  if (effect.usd_per_accepted !== undefined) parts.push(`${signedUsd(effect.usd_per_accepted)} per accepted task`);
  return <span className="text-ink-2">{parts.join(', ')}</span>;
}

export function Learning({ view }: { view: BoardView }) {
  const batches = view.batches;
  return (
    <div className="mx-4 mt-6 space-y-6 pb-10 sm:mx-6">
      <div className="max-w-3xl">
        <h2 className="wdth-semi text-[1.9rem] font-bold leading-tight sm:text-[2.3rem]">Each batch learns from the last one's rejects</h2>
        <p className="mt-2 text-[1rem] text-ink-2">
          After a batch, the reviewer turns its reasons for rejection into new rules. A rule stays only if the next batch measurably improves; otherwise it is reverted.
        </p>
      </div>

      {batches.length === 0 ? (
        <div className="rounded-well bg-well p-8 text-ink-2">The curve appears after the first batch finishes.</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <BatchChart title="Accepted share" note="Share of candidates that became tasks." batches={batches} value={(batch) => batch.share} format={(v) => pct(v)} />
          <BatchChart title="Dollars per accepted task" note="Everything the batch spent, divided by what it accepted." batches={batches} value={(batch) => batch.usdPerAccepted} format={(v) => usd(v)} lowerIsBetter />
        </div>
      )}

      <section aria-labelledby="rules-heading">
        <h3 id="rules-heading" className="wdth-semi text-[1.35rem] font-bold">Rule changes</h3>
        {view.rules.length === 0 ? (
          <p className="mt-2 text-ink-2">No rule changes yet. The first ones come from the first batch's rejects.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line overflow-hidden rounded-well bg-well">
            {view.rules.map((rule) => (
              <li key={rule.key} className="grid gap-x-5 gap-y-1.5 px-4 py-3.5 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:px-5">
                <span className="self-start"><RuleStatus status={rule.status} /></span>
                <span className="min-w-0">
                  <span className={`block text-[1.02rem] font-semibold leading-snug ${rule.status === 'reverted' ? 'text-ink-2 line-through decoration-ink-3/60' : ''}`}>{rule.text}</span>
                  <span className="mt-0.5 block text-[0.88rem] text-ink-3">
                    {RULE_KIND[rule.kind ?? ''] ?? 'Rule'} from batch {rule.batch_introduced}. <Effect rule={rule} />
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {batches.length > 0 && (
        <section aria-labelledby="batches-heading">
          <h3 id="batches-heading" className="wdth-semi text-[1.35rem] font-bold">Batches</h3>
          <div className="mt-3 overflow-x-auto rounded-well bg-well scrollbar-thin">
            <table className="w-full min-w-[34rem] text-left text-[0.95rem]">
              <thead className="text-[0.82rem] text-ink-3">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Batch</th>
                  <th className="px-4 py-2.5 text-right font-medium">Candidates</th>
                  <th className="px-4 py-2.5 text-right font-medium">Accepted</th>
                  <th className="px-4 py-2.5 text-right font-medium">Share</th>
                  <th className="px-4 py-2.5 text-right font-medium">Spent</th>
                  <th className="px-4 py-2.5 text-right font-medium">Per accepted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line tnum">
                {[...batches].reverse().map((batch) => (
                  <tr key={batch.n}>
                    <td className="px-4 py-2.5 font-semibold">{batch.n}{batch.status !== 'done' && <span className="ml-2 font-normal text-ink-3">running</span>}</td>
                    <td className="px-4 py-2.5 text-right">{batch.candidates ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right">{batch.accepted ?? 0}</td>
                    <td className="px-4 py-2.5 text-right">{pct(batch.share)}</td>
                    <td className="px-4 py-2.5 text-right">{usd(batch.cost_usd ?? null)}</td>
                    <td className="px-4 py-2.5 text-right">{usd(batch.usdPerAccepted)}</td>
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
