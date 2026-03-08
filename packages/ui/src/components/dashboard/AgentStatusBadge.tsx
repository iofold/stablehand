import { cn } from '@/lib/utils';

interface AgentStatusBadgeProps {
  status: string;
}

const statusConfig: Record<string, { label: string; color: string; pulse: boolean }> = {
  created: { label: 'Created', color: 'bg-surface-500 text-surface-200', pulse: false },
  booting: { label: 'Booting', color: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30', pulse: true },
  running: { label: 'Running', color: 'bg-green-500/20 text-green-300 border-green-500/30', pulse: true },
  suspended: { label: 'Suspended', color: 'bg-blue-500/20 text-blue-300 border-blue-500/30', pulse: false },
  error: { label: 'Error', color: 'bg-red-500/20 text-red-300 border-red-500/30', pulse: false },
};

export function AgentStatusBadge({ status }: AgentStatusBadgeProps) {
  const config = statusConfig[status] || statusConfig.created;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide',
        config.color,
      )}
    >
      {config.pulse && (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-40" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
        </span>
      )}
      {config.label}
    </span>
  );
}
