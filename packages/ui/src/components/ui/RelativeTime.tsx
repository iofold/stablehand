import { formatRelativeTime } from '@/lib/format';

/**
 * The one way timestamps render in lists and cards: relative time in the
 * cell, full absolute timestamp in the tooltip. Keeps recent-vs-all session
 * views (and the dashboard) on a single time-format policy.
 */
export function RelativeTime({
  timestamp,
  className,
}: {
  timestamp?: number | null;
  className?: string;
}) {
  if (!timestamp) {
    return <span className={className}>--</span>;
  }
  return (
    <span className={className} title={new Date(timestamp).toLocaleString()}>
      {formatRelativeTime(timestamp)}
    </span>
  );
}
