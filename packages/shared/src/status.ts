import type { ApiSessionStatus, SandboxSessionStatus } from './api.js';

export const SESSION_CANCELLED_MESSAGE = 'Session cancelled';

export function isSessionCancelled(error: string | null | undefined): boolean {
  return error === SESSION_CANCELLED_MESSAGE;
}

/**
 * The one session-status projection (ctx-bl4): CANCELLED → ERROR → COMPLETED →
 * live sandbox status → fallback. TERMINATED is not a live status — a reaped
 * sandbox falls through to the caller's fallback (ACTIVE for per-turn session
 * views, IDLE for conversation summaries).
 */
export function projectSessionStatus(
  turn: { completedAt: number | null; error: string | null } | null | undefined,
  sandboxStatus: string | null | undefined,
  fallback: ApiSessionStatus,
): ApiSessionStatus {
  if (turn && isSessionCancelled(turn.error)) {
    return 'CANCELLED';
  }
  if (turn?.error) {
    return 'ERROR';
  }
  if (turn && turn.completedAt != null) {
    return 'COMPLETED';
  }
  if (sandboxStatus && sandboxStatus !== 'TERMINATED') {
    return sandboxStatus as SandboxSessionStatus;
  }
  return fallback;
}
