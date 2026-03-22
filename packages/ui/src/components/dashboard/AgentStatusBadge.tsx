import { cn } from '@/lib/utils';

interface AgentStatusBadgeProps {
  status: string;
}

const statusConfig: Record<string, { label: string; color: string }> = {
  created: { label: 'Created', color: 'bg-surface-500' },
  booting: { label: 'Booting', color: 'bg-status-warning' },
  running: { label: 'Running', color: 'bg-status-success' },
  suspended: { label: 'Suspended', color: 'bg-surface-500' },
  error: { label: 'Error', color: 'bg-status-error' },
};

export function AgentStatusBadge({ status }: AgentStatusBadgeProps) {
  const config = statusConfig[status] || statusConfig.created;

  return (
    <span
      className="inline-flex items-center gap-2 text-xs font-medium text-surface-400"
    >
      <span
        className={cn('h-1.5 w-1.5 rounded-full', config.color)}
        aria-label={`Status: ${config.label}`}
      />
      {config.label}
    </span>
  );
}
