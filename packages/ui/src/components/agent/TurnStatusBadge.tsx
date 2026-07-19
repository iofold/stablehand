import { StatusBadge } from '@/components/dashboard/StatusBadge';

export interface TurnStatusBadgeProps {
  status: string;
  /**
   * Sandbox lifecycle state behind this row. When the run itself is finished
   * but the sandbox is CHECKPOINTED, the row shows a "resumable" chip — the
   * conversation can be continued on a warm restore.
   */
  sandboxStatus?: string | null;
  /**
   * Last automatic restore error if any. ADR 013: when status is CHECKPOINTED
   * AND lastRestoreError is non-null, the badge tooltip surfaces the failure
   * detail and the row exposes a "Retry restore" affordance.
   */
  lastRestoreError?: string | null;
  className?: string;
}

/**
 * Per-turn status badge per ADR 013. Wraps StatusBadge (which renders
 * through the shared STATUS_THEME) and layers the two sandbox-domain
 * affordances on top: restore failure and resumability.
 */
export function TurnStatusBadge({ status, sandboxStatus, lastRestoreError, className }: TurnStatusBadgeProps) {
  const checkpointed = sandboxStatus?.toUpperCase() === 'CHECKPOINTED';
  const showRestoreFailure = checkpointed && Boolean(lastRestoreError);
  const showResumable =
    !showRestoreFailure
    && checkpointed;

  if (!showRestoreFailure && !showResumable) {
    return <StatusBadge status={status} subject="Turn" className={className} />;
  }

  if (showRestoreFailure) {
    return (
      <span
        data-testid="turn-status-badge-restore-failed"
        title={`Last restore error: ${lastRestoreError}`}
        className={className}
      >
        <StatusBadge status={status} subject="Turn" />
        <span className="ml-1.5 inline-flex items-center rounded-md border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
          restore failed
        </span>
      </span>
    );
  }

  return (
    <span
      data-testid="turn-status-badge-resumable"
      title="Sandbox checkpoint available; the conversation resumes from a warm restore."
      className={className}
    >
      <StatusBadge status={status} subject="Turn" />
      <span className="ml-1.5 inline-flex items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
        resumable
      </span>
    </span>
  );
}
