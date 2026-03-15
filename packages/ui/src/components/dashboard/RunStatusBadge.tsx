import { cn } from '@/lib/utils';

type RunStatus = 'queued' | 'running' | 'completed' | 'error' | 'cancelled';

interface RunStatusBadgeProps {
  status: RunStatus;
  className?: string;
}

const config: Record<RunStatus, { color: string }> = {
  queued: { color: 'bg-surface-500' },
  running: { color: 'bg-status-success' },
  completed: { color: 'bg-status-success' },
  error: { color: 'bg-status-error' },
  cancelled: { color: 'bg-surface-500' },
};

export function RunStatusBadge({ status, className }: RunStatusBadgeProps) {
  const { color } = config[status] ?? config.queued;

  return (
    <span
      data-testid="run-status-badge"
      className={cn(
        'inline-flex items-center gap-2 text-xs font-medium text-surface-400',
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', color)} />
      {status}
    </span>
  );
}
