import { ArrowDownRight, ArrowUpRight, RotateCcw } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import type { Batch, BoardView } from '../lib/derive';
import { elapsed, pct, signedPts, signedUsd, usd } from '../lib/format';
import { useNow } from '../lib/hooks';
import { AnimatedNumber } from './AnimatedNumber';
import { SpendRing } from './SpendRing';

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

function RecoveredBadge({ count, className }: { count: number; className: string }) {
  return (
    <motion.span
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 22, delay: 0.4 }}
      className={`${className} items-center gap-1.5 whitespace-nowrap rounded-full border border-pollen/60 bg-pollen/10 px-3 py-1 text-[0.85rem] font-semibold text-ink`}
      title="The worker was stopped mid-run and picked up where it left off"
    >
      <RotateCcw size={14} strokeWidth={2.6} className="text-pollen" aria-hidden />
      Recovered from crash ×{count}
    </motion.span>
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

  // Rejects land early in a batch and accepts late, so accepted-of-decided
  // swings low mid-batch. A running batch shows accepted out of all its
  // candidates instead: it only counts up and ends at the final share.
  const running = current !== null && current.status !== 'done';
  const lastDone = done.filter((batch) => batch.n !== currentN || current?.status === 'done').at(-1) ?? null;
  const before = (batch: Batch | null) => (batch ? done.filter((entry) => entry.n < batch.n).at(-1) ?? null : null);

  const shareBatch = current ?? lastDone;
  const share = running && current?.candidates
    ? (current.accepted ?? 0) / current.candidates
    : shareBatch?.share ?? null;
  const shareBaseline = running ? lastDone : before(shareBatch);
  const shareLabel = running ? 'accepted this batch so far' : shareBatch === current ? 'accepted this batch' : `accepted in batch ${shareBatch?.n ?? ''}`;
  // While running, only an improvement is certain (the share can still rise).
  const showShareDelta = share !== null && shareBaseline?.share != null && (!running || share > shareBaseline.share);

  // Dollars per accepted task are only meaningful for a finished batch.
  const costBatch = running ? lastDone : current ?? lastDone;
  const perAccepted = costBatch?.usdPerAccepted ?? null;
  const costBaseline = before(costBatch);
  const costLabel = costBatch && costBatch !== current ? `per accepted task in batch ${costBatch.n}` : 'per accepted task';

  const spent = campaign?.spend_usd ?? 0;
  const cap = campaign?.cap_usd ?? 0;
  const unattendedSince = campaign?.unattended_since ?? null;
  const finished = campaign?.status === 'done';
  const clockEnd = finished && campaign?.finished_at ? campaign.finished_at : now;
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
        label={shareLabel}
        detail={shareBaseline?.share != null && share !== null ? (
          <>
            <span>{pct(shareBaseline.share)} in batch {shareBaseline.n}</span>
            {showShareDelta && (
              <Delta value={share - shareBaseline.share} good={share >= shareBaseline.share}>{signedPts((share - shareBaseline.share) * 100)}</Delta>
            )}
          </>
        ) : undefined}
      />

      <Stat
        className="order-4 xl:order-3"
        value={perAccepted === null ? '—' : <AnimatedNumber value={perAccepted} from={0} format={(v) => usd(v)} />}
        label={costLabel}
        detail={costBaseline?.usdPerAccepted != null && perAccepted !== null ? (
          <>
            <span>{usd(costBaseline.usdPerAccepted)} in batch {costBaseline.n}</span>
            <Delta value={perAccepted - costBaseline.usdPerAccepted} good={perAccepted <= costBaseline.usdPerAccepted}>{signedUsd(perAccepted - costBaseline.usdPerAccepted)}</Delta>
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
          {unattendedSince ? elapsed(clockEnd - unattendedSince) : '—'}
        </div>
        <div className="mt-1 text-[0.85rem] text-ink-2 sm:mt-1.5 sm:text-[0.92rem]">{!unattendedSince ? 'not unattended yet' : finished ? 'ran unattended, then stopped under the cap' : 'running unattended'}</div>
        {recovered > 0 && <RecoveredBadge count={recovered} className="mt-2 hidden xl:inline-flex" />}
      </div>
      {recovered > 0 && (
        // Narrow layouts give the badge its own row instead of squeezing it under the clock.
        <div className="order-6 col-span-2 md:col-span-3 xl:hidden">
          <RecoveredBadge count={recovered} className="inline-flex" />
        </div>
      )}
    </section>
  );
}
