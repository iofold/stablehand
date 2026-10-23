import { motion } from 'motion/react';
import type { PassCount } from '../../../src/shared/board';
import { familyLabel } from '../../../src/shared/board';

/** Families in a fixed order, so a dot's position always means the same family. */
export const FAMILY_ORDER = ['anthropic', 'openai', 'google', 'open'];

export function orderedFamilies(difficulty: Record<string, PassCount> | undefined): [string, PassCount][] {
  if (!difficulty) return [];
  return Object.entries(difficulty).sort(([a], [b]) => {
    const ia = FAMILY_ORDER.indexOf(a);
    const ib = FAMILY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
}

/**
 * One pie per model family: the filled share is how often that family solved
 * the task. Empty means no family member solved it; full means every try did.
 */
export function PassPie({ passes, attempts, size = 16 }: PassCount & { size?: number }) {
  const fraction = attempts > 0 ? passes / attempts : 0;
  const r = size / 2;
  const inner = r - 2;
  const angle = fraction * 2 * Math.PI;
  const x = r + inner * Math.sin(angle);
  const y = r - inner * Math.cos(angle);
  const large = fraction > 0.5 ? 1 : 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="shrink-0">
      <circle cx={r} cy={r} r={r - 0.75} fill="none" strokeWidth={1.5} className={attempts > 0 ? 'stroke-ink-2' : 'stroke-ink-3'} />
      {fraction >= 0.999 ? (
        <circle cx={r} cy={r} r={inner} className="fill-ink" />
      ) : fraction > 0 ? (
        <motion.path
          key={`${passes}/${attempts}`}
          initial={{ opacity: 0.2 }}
          animate={{ opacity: 1 }}
          d={`M ${r} ${r} L ${r} ${r - inner} A ${inner} ${inner} 0 ${large} 1 ${x} ${y} Z`}
          className="fill-ink"
        />
      ) : null}
    </svg>
  );
}

export function DifficultyDots({ difficulty, compact = false }: { difficulty: Record<string, PassCount> | undefined; compact?: boolean }) {
  const families = orderedFamilies(difficulty);
  if (families.length === 0) return null;
  return (
    <ul className={`flex min-w-0 items-center ${compact ? 'gap-x-1.5' : 'gap-x-2'}`} aria-label="Solved by model family">
      {families.map(([family, count]) => (
        <li
          key={family}
          className="flex shrink-0 items-center gap-[3px]"
          title={`${familyLabel(family)}: solved ${count.passes} of ${count.attempts} tries`}
        >
          <PassPie passes={count.passes} attempts={count.attempts} size={compact ? 13 : 14} />
          {!compact && <span className="tnum text-[0.72rem] font-medium tracking-tight text-ink-2">{count.passes}/{count.attempts}</span>}
          <span className="sr-only">{familyLabel(family)} solved {count.passes} of {count.attempts}</span>
        </li>
      ))}
    </ul>
  );
}
