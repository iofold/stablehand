import { RunStatusBadge } from '@/components/dashboard/RunStatusBadge';

export interface SessionStatusBadgeProps {
  status: string;
  pausedReason?: string | null;
  /**
   * Last automatic restore error if any. ADR 013: when status is CHECKPOINTED
   * AND lastRestoreError is non-null, the badge tooltip surfaces the failure
   * detail and the row exposes a "Retry restore" affordance.
   */
  lastRestoreError?: string | null;
  className?: string;
}

/**
 * Per-session status badge per ADR 013. Wraps the existing RunStatusBadge so
 * it renders identically when there is no restore failure, but surfaces
 * tooltip detail when the session is CHECKPOINTED-after-failure.
 */
export function SessionStatusBadge({ status, pausedReason, lastRestoreError, className }: SessionStatusBadgeProps) {
  const normalized = status.toUpperCase();
  const showRestoreFailure = normalized === 'CHECKPOINTED' && Boolean(lastRestoreError);

  if (!showRestoreFailure) {
    return <RunStatusBadge status={status} pausedReason={pausedReason} className={className} />;
  }

  return (
    <span
      data-testid="session-status-badge-restore-failed"
      title={`Last restore error: ${lastRestoreError}`}
      className={className}
    >
      <RunStatusBadge status={status} pausedReason={pausedReason} />
      <span className="ml-1.5 inline-flex items-center rounded-md border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
        restore failed
      </span>
    </span>
  );
}
