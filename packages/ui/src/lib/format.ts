export function formatTimestamp(timestamp: number): string {
  if (!timestamp) return '--';
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDurationBetween(start: number, end: number): string {
  return formatElapsedMilliseconds(Math.max(0, end - start));
}

export function formatRunningDuration(startedAt: number): string {
  return formatElapsedMilliseconds(Math.max(0, Date.now() - startedAt));
}

function formatElapsedMilliseconds(elapsed: number): string {
  const secs = Math.floor(elapsed / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export function formatEventDuration(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function formatEventTime(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return `${Math.max(0, Math.floor(elapsed / 1000))}s ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return 'Never';
  const secs = Math.floor((Date.now() - timestamp) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** "in 5m", "in 3h", "in 2d" for a time ahead of now. */
export function formatTimeUntil(timestamp: number, now = Date.now()): string {
  const mins = Math.round((timestamp - now) / 60_000);
  if (mins < 1) return 'in under a minute';
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  return `in ${Math.round(hrs / 24)}d`;
}

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatBytes(bytes: number, decimals = 2): string {
  if (!+bytes) return '0 Bytes';
  const base = 1024;
  const precision = Math.max(0, decimals);
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const unitIndex = Math.floor(Math.log(bytes) / Math.log(base));
  const value = parseFloat((bytes / Math.pow(base, unitIndex)).toFixed(precision));
  return `${value} ${units[unitIndex]}`;
}
