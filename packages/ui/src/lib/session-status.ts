import { API_SESSION_STATUSES, type ApiSessionStatusCounts } from '@ctxmill/shared';

const KNOWN_SESSION_STATUSES = new Set<string>(API_SESSION_STATUSES);

export function normalizeSessionStatus(status: string | null | undefined): string {
  if (!status) return '';
  const trimmed = String(status).trim();
  const canonical = trimmed.toUpperCase();
  return KNOWN_SESSION_STATUSES.has(canonical) ? canonical : trimmed;
}

export function normalizeRunStatus(status: string | null | undefined): string {
  const normalized = normalizeSessionStatus(status);
  if (normalized === 'ACTIVE' || normalized === 'RESTORING') return 'running';
  if (normalized === 'CHECKPOINTED') return 'completed';
  if (normalized === 'TERMINATED') return 'cancelled';
  return normalized.toLowerCase();
}

export function normalizeSessionStatusCounts(
  stats?: Partial<ApiSessionStatusCounts> | null,
): ApiSessionStatusCounts | null | undefined {
  if (!stats) return stats;

  const normalized: ApiSessionStatusCounts = {
    ACTIVE: 0,
    CHECKPOINTED: 0,
    RESTORING: 0,
    TERMINATED: 0,
  };
  for (const [rawStatus, rawCount] of Object.entries(stats) as Array<[string, number | undefined]>) {
    const status = normalizeSessionStatus(rawStatus) as keyof ApiSessionStatusCounts;
    const count = Number(rawCount ?? 0);
    if (!Number.isFinite(count)) continue;
    if (status in normalized) {
      normalized[status] = (normalized[status] ?? 0) + count;
    }
  }
  return normalized;
}

export function countActiveSessions(stats?: Partial<ApiSessionStatusCounts> | null): number {
  const normalized = normalizeSessionStatusCounts(stats);
  return (normalized?.ACTIVE ?? 0) + (normalized?.RESTORING ?? 0);
}

export function countAllSessions(stats?: Partial<ApiSessionStatusCounts> | null): number {
  const normalized = normalizeSessionStatusCounts(stats);
  return (
    (normalized?.ACTIVE ?? 0)
    + (normalized?.CHECKPOINTED ?? 0)
    + (normalized?.RESTORING ?? 0)
    + (normalized?.TERMINATED ?? 0)
  );
}

export function describeSessionCounts(stats?: Partial<ApiSessionStatusCounts> | null): string {
  const normalized = normalizeSessionStatusCounts(stats);
  if (!normalized) return '';

  const parts = [];
  if ((normalized.ACTIVE ?? 0) > 0) parts.push(`${normalized.ACTIVE} active`);
  if ((normalized.RESTORING ?? 0) > 0) parts.push(`${normalized.RESTORING} restoring`);
  if ((normalized.CHECKPOINTED ?? 0) > 0) parts.push(`${normalized.CHECKPOINTED} checkpointed`);
  if ((normalized.TERMINATED ?? 0) > 0) parts.push(`${normalized.TERMINATED} terminated`);
  return parts.join(', ');
}
