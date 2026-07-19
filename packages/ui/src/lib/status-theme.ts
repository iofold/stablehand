/**
 * The single source of truth for lifecycle status presentation.
 *
 * CTXMill has separate sandbox/container lifecycle (ACTIVE,
 * CHECKPOINTED, RESTORING, TERMINATED) and turn lifecycle (QUEUED,
 * RUNNING, COMPLETED, ERROR, CANCELLED) domains. Every
 * surface (dashboard dots, status badges, filter chips) must render them
 * through this map so labels and colors never diverge again.
 *
 * Semantic rules:
 * - Red is reserved for ERROR. TERMINATED is a normal container reap, not a
 *   failure, and renders neutral.
 * - CHECKPOINTED reads as "resumable": the sandbox can be restored warm.
 * - ACTIVE reads as "running" to match the turn-domain vocabulary.
 */
export interface StatusTheme {
  /** User-facing label (lowercase; capitalize via CSS where needed). */
  label: string;
  /** Tailwind background class for the status dot. */
  dot: string;
}

const DEFAULT_THEME: StatusTheme = { label: 'queued', dot: 'bg-surface-500' };

export const STATUS_THEME: Record<string, StatusTheme> = {
  QUEUED: DEFAULT_THEME,
  ACTIVE: { label: 'running', dot: 'bg-status-success' },
  RESTORING: { label: 'restoring', dot: 'bg-sky-400' },
  CHECKPOINTED: { label: 'resumable', dot: 'bg-status-warning' },
  TERMINATED: { label: 'ended', dot: 'bg-surface-500' },
  COMPLETED: { label: 'completed', dot: 'bg-surface-400' },
  ERROR: { label: 'error', dot: 'bg-status-error' },
  CANCELLED: { label: 'cancelled', dot: 'bg-surface-500' },
  IDLE: { label: 'idle', dot: 'bg-surface-500' },
};

export function statusTheme(status: string | null | undefined): StatusTheme {
  if (!status) return DEFAULT_THEME;
  const normalized = status.trim().toUpperCase();
  return (
    STATUS_THEME[normalized]
    // Unknown statuses keep their own name (neutral dot) instead of masquerading as queued.
    ?? { label: normalized.replace(/_/g, ' ').toLowerCase(), dot: DEFAULT_THEME.dot }
  );
}
