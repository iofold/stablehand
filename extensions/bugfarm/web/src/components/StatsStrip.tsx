import { ArrowDownRight, ArrowUpRight, RotateCcw } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import type { Batch, BoardView } from '../lib/derive';
import { elapsed, pct, signedPts, signedUsd, usd } from '../lib/format';
import { useNow } from '../lib/hooks';
import { AnimatedNumber } from './AnimatedNumber';
import { SpendRing } from './SpendRing';

/** A running batch's share is noise until a few candidates are decided. */
const MIN_DECIDED = 4;

function Delta({ value, good, children }: { value: number; good: boolean; children: ReactNode }) {
  if (!Number.isFinite(value) || Math.abs(value) < 1e-9) return null;
  const Icon = value > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-ink-2">
      <Icon size={16} strokeWidth={2.6} className={good ? 'text-sprout' : 'text-ember'} aria-hidden />
      {children}
    </span>
  );
}

function Stat({ value, label, detail, className = '' }: { value: ReactNode; label: string; detail?: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="wdth-wide whitespace-nowrap text-[1.5rem] font-semibold leading-none tracking-tight sm:text-[1.9rem] xl:text-[2.1rem]">{value}</div>
      <div className="mt-1 text-[0.85rem] leading-snug text-ink-2 sm:mt-1.5 sm:text-[0.92rem]">{label}</div>
      {detail && <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[0.8rem] leading-snug text-ink-3 sm:text-[0.85rem]">{detail}</div>}
    </div>
  );
}

function decidedOf(batch: Batch | null): number {
  return batch ? (batch.accepted ?? 0) + (batch.rejected ?? 0) : 0;
}

export function StatsStrip({ view }: { view: BoardView }) {
  const now = useNow(1000);
  const campaign = view.campaign;
  const currentN = campaign?.batch ?? view.batches[view.batches.length - 1]?.n ?? 0;
  const current = view.batches.find((batch) => batch.n === currentN) ?? null;
  const done = view.batches.filter((batch) => batch.status === 'done' && batch.n <= currentN);

  // Compare this batch with the last finished one. While this batch is too
  // young to say anything, show the last finished batch against the one before.
  const currentReady = current !== null && (current.status === 'done' || decidedOf(current) >= MIN_DECIDED);
  const shown = currentReady ? current : done.filter((batch) => batch.n !== currentN).at(-1) ?? null;
  const baseline = shown ? done.filter((batch) => batch.n < shown.n).at(-1) ?? null : null;
  const shownLabel = shown === current ? 'this batch' : shown ? `in batch ${shown.n}` : 'this batch';

  const spent = campaign?.spend_usd ?? 0;
  const cap = campaign?.cap_usd ?? 0;
  const share = shown?.share ?? null;
  const perAccepted = shown?.usdPerAccepted ?? null;
  const unattendedSince = campaign?.unattended_since ?? null;
  const recovered = campaign?.recovered_from_crash ?? 0;

  return (
    <section
      aria-label="Campaign"
      className="mx-4 mt-3 grid grid-cols-2 gap-x-4 gap-y-4 rounded-well bg-well px-4 py-4 sm:mx-6 sm:mt-4 sm:px-6 md:grid-cols-3 xl:grid-cols-[auto_1fr_1fr_0.8fr_auto] xl:items-center xl:gap-x-0 xl:divide-x xl:divide-line xl:py-5 [&>*]:xl:px-7 [&>*:first-child]:xl:pl-1 [&>*:last-child]:xl:pr-1"
    >
      <div className="order-1 flex min-w-0 items-center gap-3 sm:gap-4">
        <span className="sm:hidden"><SpendRing spent={spent} cap={cap} size={44} /></span>
        <span className="hidden sm:block"><SpendRing spent={spent} cap={cap} size={66} /></span>
        <Stat
          value={<AnimatedNumber value={spent} from={0} format={(v) => usd(v)} />}
          label={cap > 0 ? `of the ${usd(cap, 0)} cap` : 'spent, no cap set'}
          detail={cap > 0 ? <span className="hidden sm:inline">{pct(spent / cap)} used</span> : undefined}
        />
      </div>

      <Stat
        className="order-3 xl:order-2"
        value={share === null ? '—' : <AnimatedNumber value={share} from={0} format={(v) => pct(v)} />}
        label={`accepted ${shownLabel}`}
        detail={baseline?.share != null && share !== null ? (
          <>
            <span>was {pct(baseline.share)}</span>
            <Delta value={share - baseline.share} good={share >= baseline.share}>{signedPts((share - baseline.share) * 100)}</Delta>
          </>
        ) : undefined}
      />

      <Stat
        className="order-4 xl:order-3"
        value={perAccepted === null ? '—' : <AnimatedNumber value={perAccepted} from={0} format={(v) => usd(v)} />}
        label="per accepted task"
        detail={baseline?.usdPerAccepted != null && perAccepted !== null ? (
          <>
            <span>was {usd(baseline.usdPerAccepted)}</span>
            <Delta value={perAccepted - baseline.usdPerAccepted} good={perAccepted <= baseline.usdPerAccepted}>{signedUsd(perAccepted - baseline.usdPerAccepted)}</Delta>
          </>
        ) : undefined}
      />

      <Stat
        className="order-5 xl:order-4"
        value={<>Batch <AnimatedNumber value={currentN} format={(v) => String(Math.round(v))} duration={0.4} /></>}
        label={current?.candidates ? `${decidedOf(current)} of ${current.candidates} decided` : 'no batch running'}
        detail={current?.status === 'done' ? <span>finished</span> : undefined}
      />

      <div className="order-2 min-w-0 text-right xl:order-5">
        <div className="wdth-x-wide whitespace-nowrap text-[1.5rem] font-bold leading-none tracking-tight tnum sm:text-[2.2rem] xl:text-[2.6rem]">
          {unattendedSince ? elapsed(now - unattendedSince) : '—'}
        </div>
        <div className="mt-1 text-[0.85rem] text-ink-2 sm:mt-1.5 sm:text-[0.92rem]">{unattendedSince ? 'running unattended' : 'not unattended yet'}</div>
        {recovered > 0 && (
          <motion.div
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: 'spring', stiffness: 420, damping: 22, delay: 0.4 }}
            className="mt-1.5 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-pollen/60 bg-pollen/10 px-2.5 py-0.5 text-[0.78rem] font-semibold text-ink sm:mt-2 sm:px-3 sm:py-1 sm:text-[0.85rem]"
            title="The worker was stopped mid-run and picked up where it left off"
          >
            <RotateCcw size={14} strokeWidth={2.6} className="text-pollen" aria-hidden />
            Recovered from crash ×{recovered}
          </motion.div>
        )}
      </div>
    </section>
  );
}
