import { motion } from 'motion/react';

interface SpendRingProps {
  spent: number;
  cap: number;
  size?: number;
}

/** Campaign spend against its cap. The fill turns ember from 85%, where alerts fire. */
export function SpendRing({ spent, cap, size = 64 }: SpendRingProps) {
  const fraction = cap > 0 ? Math.min(1, spent / cap) : 0;
  const stroke = Math.max(5, Math.round(size / 10));
  const radius = (size - stroke) / 2;
  const hot = fraction >= 0.85;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`${Math.round(fraction * 100)}% of the spend cap used`}
      className="shrink-0 -rotate-90"
    >
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} className="stroke-line" />
      <motion.circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        className={hot ? 'stroke-ember' : 'stroke-pollen'}
        initial={{ pathLength: 0 }}
        animate={{ pathLength: Math.max(0.001, fraction) }}
        transition={{ type: 'spring', stiffness: 60, damping: 18 }}
      />
    </svg>
  );
}
