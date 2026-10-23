import { animate, useReducedMotion } from 'motion/react';
import { useEffect, useRef } from 'react';

interface AnimatedNumberProps {
  value: number;
  format: (value: number) => string;
  className?: string;
  /** Count up from this value on first render (the page-load moment). */
  from?: number;
  duration?: number;
}

/**
 * A number that ticks to its new value. It writes text directly to the node
 * while animating, so a ticking counter never re-renders React.
 */
export function AnimatedNumber({ value, format, className, from, duration = 0.9 }: AnimatedNumberProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();
  const shown = useRef(from ?? value);
  const formatRef = useRef(format);
  formatRef.current = format;

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    if (reduced || shown.current === value || !Number.isFinite(shown.current)) {
      shown.current = value;
      node.textContent = formatRef.current(value);
      return undefined;
    }
    const controls = animate(shown.current, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (latest) => {
        shown.current = latest;
        node.textContent = formatRef.current(latest);
      },
    });
    return () => controls.stop();
  }, [value, reduced, duration]);

  return (
    <span ref={ref} className={className}>
      {format(reduced ? value : shown.current)}
    </span>
  );
}
