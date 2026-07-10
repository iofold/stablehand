import type { AgentStatus as PulseStatus } from '@/components/dashboard/illustrations/StatusPulse';

export interface AgentStatusConfig {
  label: string;
  dotColor: string;
  borderColor: string;
  pulseStatus: PulseStatus;
}

const configs: Record<string, AgentStatusConfig> = {
  idle:    { label: 'Idle',    dotColor: 'bg-surface-500',    borderColor: 'border-l-surface-600/50', pulseStatus: 'idle' },
  running: { label: 'Running', dotColor: 'bg-status-success', borderColor: 'border-l-emerald-500/50', pulseStatus: 'running' },
};

const fallback: AgentStatusConfig = configs.idle;

export function getAgentStatusConfig(status: string): AgentStatusConfig {
  return configs[status] ?? fallback;
}
