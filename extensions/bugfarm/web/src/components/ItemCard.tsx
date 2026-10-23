import { CheckCircle2 } from 'lucide-react';
import { motion, useReducedMotion, type TargetAndTransition } from 'motion/react';
import { memo } from 'react';
import { rejectReasonLabel } from '../../../src/shared/board';
import type { Item } from '../lib/derive';
import { shortSha, usd } from '../lib/format';
import type { Shown } from '../lib/useDisplayStages';
import { DifficultyDots } from './DifficultyDots';

interface ItemCardProps {
  item: Item;
  shown: Shown;
  isNew: boolean;
  onOpen: (key: string) => void;
}

const SPRING = { type: 'spring', stiffness: 520, damping: 40, mass: 0.9 } as const;

function shakeFor(shown: Shown, reduced: boolean): TargetAndTransition | undefined {
  if (reduced) return undefined;
  if (shown.phase === 'shaking') {
    return {
      x: [0, -9, 9, -7, 7, -4, 4, 0],
      rotate: [0, -1.2, 1.2, -0.8, 0.8, 0, 0, 0],
      transition: { duration: 0.5, ease: 'easeInOut' },
    };
  }
  return { x: 0, rotate: 0 };
}

function ItemCardBase({ item, shown, isNew, onOpen }: ItemCardProps) {
  const reduced = useReducedMotion() ?? false;
  const stage = shown.stage;
  const compact = stage === 'rejected' || stage === 'published';
  const shaking = shown.phase === 'shaking';
  const glowing = shown.phase === 'glow' && stage === 'accepted';
  const repo = item.repo ? item.repo.split('/').pop() : item.key.split('@')[0];
  const sha = shortSha(item.sha) || item.key.split('@')[1] || '';
  const stats = item.diff_stats;

  return (
    <motion.li
      layout="position"
      layoutId={`card-${item.key}`}
      initial={isNew && !reduced ? { opacity: 0, scale: 0.55, y: -18 } : false}
      animate={{ opacity: 1, y: 0, scale: glowing && !reduced ? [1, 1.045, 1] : 1, ...shakeFor(shown, reduced) }}
      transition={{
        layout: SPRING,
        scale: glowing && !reduced ? { duration: 0.6, ease: 'easeOut', delay: 0.15 } : { type: 'spring', stiffness: 460, damping: 24 },
        default: { type: 'spring', stiffness: 460, damping: 24 },
      }}
      className="list-none"
    >
      <button
        type="button"
        onClick={() => onOpen(item.key)}
        className={[
          'group relative block w-full rounded-card border text-left transition-colors',
          'bg-card hover:bg-raised focus-visible:bg-raised',
          compact ? 'px-3 py-2.5' : 'px-3.5 py-3',
          stage === 'accepted' ? 'border-sprout/45' : shaking ? 'border-ember/70' : 'border-line',
        ].join(' ')}
      >
        {stage === 'accepted' && (
          <motion.span
            key={`glow-${shown.beat}`}
            aria-hidden
            className="pointer-events-none absolute -inset-px rounded-card"
            initial={glowing && !reduced ? { boxShadow: '0 0 0 0 rgb(var(--sprout) / 0)' } : false}
            animate={
              glowing && !reduced
                ? {
                    boxShadow: [
                      '0 0 0 0 rgb(var(--sprout) / 0), 0 0 0 0 rgb(var(--sprout) / 0)',
                      '0 0 0 3px rgb(var(--sprout) / 0.75), 0 0 42px 10px rgb(var(--sprout) / 0.45)',
                      '0 0 0 1px rgb(var(--sprout) / 0.35), 0 0 16px 2px rgb(var(--sprout) / 0.18)',
                      '0 0 0 3px rgb(var(--sprout) / 0.6), 0 0 34px 8px rgb(var(--sprout) / 0.38)',
                      '0 0 0 1px rgb(var(--sprout) / 0.3), 0 0 16px 0 rgb(var(--sprout) / 0.18)',
                    ],
                  }
                : { boxShadow: '0 0 0 1px rgb(var(--sprout) / 0.3), 0 0 16px 0 rgb(var(--sprout) / 0.18)' }
            }
            transition={{ duration: 2.6, ease: 'easeInOut', times: [0, 0.18, 0.45, 0.68, 1] }}
          />
        )}
        {glowing && !reduced && (
          <motion.span
            key={`wash-${shown.beat}`}
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-card bg-sprout/15"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 1, 0] }}
            transition={{ duration: 1.4, ease: 'easeOut' }}
          />
        )}
        {shaking && !reduced && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-card bg-ember/15"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 1, 0.6] }}
            transition={{ duration: 0.5 }}
          />
        )}

        <span className="relative flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate font-mono text-[0.78rem] text-ink-3">
            {repo}@<span className="text-ink-2">{sha}</span>
          </span>
          <span className="shrink-0 text-[0.85rem] font-semibold text-ink-2 tnum">{usd(item.cost_usd ?? 0)}</span>
        </span>

        <span
          className={`relative mt-1 font-semibold leading-snug text-ink ${compact ? 'line-clamp-2 text-[0.92rem]' : 'line-clamp-3 text-[1rem]'} ${stage === 'rejected' ? 'text-ink-2' : ''}`}
        >
          {item.title ?? item.key}
        </span>

        {item.activity && stage !== 'rejected' && stage !== 'accepted' && stage !== 'published' && (
          <span className="relative mt-1.5 flex min-w-0 items-center gap-1.5 text-[0.8rem] leading-snug text-ink-2" aria-live="polite">
            <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-pollen opacity-60 motion-reduce:hidden" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-pollen" />
            </span>
            <span className="truncate" title={item.activity}>{item.activity}</span>
          </span>
        )}

        {stage === 'rejected' ? (
          <span className="relative mt-2 flex min-w-0">
            <motion.span
              key={`reason-${shown.beat}`}
              initial={shown.phase === 'dropped' && !reduced ? { scale: 0, opacity: 0 } : false}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 600, damping: 18, delay: 0.32 }}
              className="inline-flex min-w-0 max-w-full origin-left items-center gap-1.5 rounded-full bg-ember/15 px-2.5 py-0.5 text-[0.8rem] font-semibold text-ink"
              title={item.reject_detail ?? undefined}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ember" aria-hidden />
              <span className="truncate">{rejectReasonLabel(item.reject_reason)}</span>
            </motion.span>
          </span>
        ) : (
          <span className="relative mt-2 flex min-h-[1.1rem] items-center justify-between gap-x-3">
            {item.difficulty && Object.keys(item.difficulty).length > 0 ? (
              <DifficultyDots difficulty={item.difficulty} compact={compact} />
            ) : stats ? (
              <span className="text-[0.8rem] text-ink-3 tnum">
                <span className="text-ink-2">+{stats.additions}</span> −{stats.deletions} in {stats.files} {stats.files === 1 ? 'file' : 'files'}
              </span>
            ) : <span />}
            {stage === 'published' && (
              <span className="inline-flex shrink-0 items-center gap-1 text-[0.8rem] font-semibold text-ink-2">
                <CheckCircle2 size={14} className="text-pollen" aria-hidden /> Published
              </span>
            )}
          </span>
        )}
      </button>
    </motion.li>
  );
}

export const ItemCard = memo(ItemCardBase, (a, b) =>
  a.item === b.item && a.shown.stage === b.shown.stage && a.shown.phase === b.shown.phase && a.shown.beat === b.shown.beat && a.isNew === b.isNew && a.onOpen === b.onOpen,
);
