import {
  API_CONVERSATION_STATUSES,
  API_TURN_STATUSES,
  SANDBOX_SESSION_STATUSES,
  type ApiSandboxSessionStatusCounts,
} from '@stablehand/shared';

const KNOWN_SANDBOX_SESSION_STATUSES = new Set<string>(SANDBOX_SESSION_STATUSES);
const KNOWN_TURN_STATUSES = new Set<string>(API_TURN_STATUSES);
const KNOWN_CONVERSATION_STATUSES = new Set<string>(API_CONVERSATION_STATUSES);

export function normalizeSandboxSessionStatus(status: string | null | undefined): string {
  if (!status) return '';
  const trimmed = String(status).trim();
  const canonical = trimmed.toUpperCase();
  return KNOWN_SANDBOX_SESSION_STATUSES.has(canonical) ? canonical : trimmed;
}

const TERMINAL_CONVERSATION_STATUSES = new Set<string>(['COMPLETED', 'ERROR', 'CANCELLED']);

/** Terminal conversation states: the conversation has ended, so there is nothing left to cancel. */
export function isTerminalConversationStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const canonical = String(status).trim().toUpperCase();
  return KNOWN_CONVERSATION_STATUSES.has(canonical)
    && TERMINAL_CONVERSATION_STATUSES.has(canonical);
}

export function normalizeTurnStatus(status: string | null | undefined): string {
  if (!status) return '';
  const trimmed = String(status).trim();
  const canonical = trimmed.toUpperCase();
  return (KNOWN_TURN_STATUSES.has(canonical) ? canonical : trimmed).toLowerCase();
}

export function normalizeSandboxSessionStatusCounts(
  stats?: Partial<ApiSandboxSessionStatusCounts> | null,
): ApiSandboxSessionStatusCounts | null | undefined {
  if (!stats) return stats;

  const normalized: ApiSandboxSessionStatusCounts = {
    ACTIVE: 0,
    CHECKPOINTED: 0,
    RESTORING: 0,
    TERMINATED: 0,
  };
  for (const [rawStatus, rawCount] of Object.entries(stats) as Array<[string, number | undefined]>) {
    const status = normalizeSandboxSessionStatus(rawStatus) as keyof ApiSandboxSessionStatusCounts;
    const count = Number(rawCount ?? 0);
    if (!Number.isFinite(count)) continue;
    if (status in normalized) {
      normalized[status] = (normalized[status] ?? 0) + count;
    }
  }
  return normalized;
}

export function countActiveSandboxSessions(stats?: Partial<ApiSandboxSessionStatusCounts> | null): number {
  const normalized = normalizeSandboxSessionStatusCounts(stats);
  return (normalized?.ACTIVE ?? 0) + (normalized?.RESTORING ?? 0);
}

export function countAllSandboxSessions(stats?: Partial<ApiSandboxSessionStatusCounts> | null): number {
  const normalized = normalizeSandboxSessionStatusCounts(stats);
  return (
    (normalized?.ACTIVE ?? 0)
    + (normalized?.CHECKPOINTED ?? 0)
    + (normalized?.RESTORING ?? 0)
    + (normalized?.TERMINATED ?? 0)
  );
}

export function describeSandboxSessionCounts(stats?: Partial<ApiSandboxSessionStatusCounts> | null): string {
  const normalized = normalizeSandboxSessionStatusCounts(stats);
  if (!normalized) return '';

  const parts = [];
  if ((normalized.ACTIVE ?? 0) > 0) parts.push(`${normalized.ACTIVE} running`);
  if ((normalized.RESTORING ?? 0) > 0) parts.push(`${normalized.RESTORING} restoring`);
  if ((normalized.CHECKPOINTED ?? 0) > 0) parts.push(`${normalized.CHECKPOINTED} resumable`);
  if ((normalized.TERMINATED ?? 0) > 0) parts.push(`${normalized.TERMINATED} ended`);
  return parts.join(', ');
}
