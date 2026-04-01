import { cn } from '@/lib/utils';

interface RunStatusBadgeProps {
  status: string;
  pausedReason?: string | null;
  className?: string;
}

const config: Record<string, { color: string }> = {
  queued: { color: 'bg-surface-500' },
  running: { color: 'bg-status-success' },
  paused: { color: 'bg-status-warning' },
  PAUSED: { color: 'bg-status-warning' },
  completed: { color: 'bg-surface-400' },
  error: { color: 'bg-status-error' },
  cancelled: { color: 'bg-surface-500' },
  suspended: { color: 'bg-status-warning' },
};

export function RunStatusBadge({ status, pausedReason, className }: RunStatusBadgeProps) {
  const normalizedStatus = status.toLowerCase();
  const { color } = config[status] ?? config[normalizedStatus] ?? config.queued;

  let displayStatus = status;
  if (normalizedStatus === 'paused') {
    displayStatus = pausedReason === 'idle' ? 'Paused (Idle)' : 'Paused (HITL)';
  }

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
