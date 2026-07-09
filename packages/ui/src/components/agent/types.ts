export type TabId = 'overview' | 'sessions' | 'tools' | 'files' | 'artifacts' | 'secrets';

/** Format a timestamp for display */
export function formatTime(ts: number): string {
  if (!ts) return '--';
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Format duration between two timestamps */
export function formatDuration(start: number, end: number): string {
  const elapsed = Math.max(0, end - start);
  const secs = Math.floor(elapsed / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}
