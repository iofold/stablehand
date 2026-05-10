import { cn } from '@/lib/utils';

interface RunStatusBadgeProps {
  status: string;
  className?: string;
}

const config: Record<string, { color: string }> = {
  QUEUED: { color: 'bg-surface-500' },
  ACTIVE: { color: 'bg-status-success' },
  CHECKPOINTED: { color: 'bg-status-warning' },
  RESTORING: { color: 'bg-sky-400' },
  TERMINATED: { color: 'bg-surface-500' },
  COMPLETED: { color: 'bg-surface-400' },
  ERROR: { color: 'bg-status-error' },
  CANCELLED: { color: 'bg-surface-500' },
  IDLE: { color: 'bg-surface-500' },
};

export function RunStatusBadge({ status, className }: RunStatusBadgeProps) {
  const normalizedStatus = status.toUpperCase();
  const { color } = config[normalizedStatus] ?? config.QUEUED;

  const displayStatus = normalizedStatus.replace(/_/g, ' ').toLowerCase();

  return (
    <span
      data-testid="run-status-badge"
      className={cn(
        'inline-flex items-center gap-2 text-xs font-medium text-surface-400',
        className,
      )}
    >
      <span
        className={cn('h-1.5 w-1.5 rounded-full', color)}
        role="img"
        aria-label={`Run status: ${displayStatus}`}
      />
      <span className="capitalize">{displayStatus}</span>
    </span>
  );
}
