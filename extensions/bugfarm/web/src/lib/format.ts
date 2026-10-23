export function usd(value: number | null | undefined, digits?: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const places = digits ?? (Math.abs(value) >= 100 ? 0 : 2);
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places })}`;
}

export function signedUsd(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
  return `${sign}${usd(Math.abs(value))}`;
}

export function pct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function signedPts(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
  return `${sign}${Math.abs(value).toFixed(1)} pts`;
}

export function shortSha(sha: string | undefined, length = 7): string {
  return sha ? sha.slice(0, length) : '';
}

/** "7h 12m 03s"; days roll over as "1d 4h 02m". */
export function elapsed(ms: number, withSeconds = true): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (days > 0) return `${days}d ${hours}h ${pad(minutes)}m`;
  if (hours > 0) return withSeconds ? `${hours}h ${pad(minutes)}m ${pad(seconds)}s` : `${hours}h ${pad(minutes)}m`;
  return withSeconds ? `${minutes}m ${pad(seconds)}s` : `${minutes}m`;
}

/** Compact duration between two stage times: "42s", "6m", "2h 10m". */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export function clock(ms: number | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function clockSeconds(ms: number | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function repoName(repo: string | undefined): string {
  if (!repo) return '';
  const parts = repo.split('/');
  return parts[parts.length - 1];
}
