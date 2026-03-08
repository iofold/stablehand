import { Clock, Loader2, Check, X, Slash } from 'lucide-react';
import { cn } from '@/lib/utils';

type RunStatus = 'queued' | 'running' | 'completed' | 'error' | 'cancelled';

interface RunStatusBadgeProps {
  status: RunStatus;
  className?: string;
}

const config: Record<RunStatus, { icon: React.ElementType; color: string; pulse?: boolean }> = {
  queued: { icon: Clock, color: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30' },
  running: { icon: Loader2, color: 'bg-green-500/20 text-green-300 border-green-500/30', pulse: true },
  completed: { icon: Check, color: 'bg-green-500/20 text-green-300 border-green-500/30' },
  error: { icon: X, color: 'bg-red-500/20 text-red-300 border-red-500/30' },
  cancelled: { icon: Slash, color: 'bg-surface-500/20 text-surface-300 border-surface-500/30' },
};

export function RunStatusBadge({ status, className }: RunStatusBadgeProps) {
  const { icon: Icon, color, pulse } = config[status] ?? config.queued;

  return (
    <span
      data-testid="run-status-badge"
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
        color,
        className,
      )}
    >
      <Icon className={cn('h-3 w-3', pulse && 'animate-spin')} />
      {status}
    </span>
  );
}
