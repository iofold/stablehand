import { cn } from '@/lib/utils';
import { getAgentStatusConfig } from '@/lib/agent-status';

interface AgentStatusBadgeProps {
  status: string;
}

export function AgentStatusBadge({ status }: AgentStatusBadgeProps) {
  const config = getAgentStatusConfig(status);

  return (
    <span className="inline-flex items-center gap-2 text-xs font-medium text-surface-400">
      <span className={cn('h-1.5 w-1.5 rounded-full', config.dotColor)} />
      {config.label}
    </span>
  );
}
