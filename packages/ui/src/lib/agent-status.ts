import type { AgentStatus as PulseStatus } from '@/components/dashboard/illustrations/StatusPulse';

export interface AgentStatusConfig {
  label: string;
  dotColor: string;
  borderColor: string;
  pulseStatus: PulseStatus;
}

const configs: Record<string, AgentStatusConfig> = {
  created:   { label: 'Created',   dotColor: 'bg-surface-500',    borderColor: 'border-l-surface-600/50', pulseStatus: 'idle' },
  idle:      { label: 'Idle',      dotColor: 'bg-surface-500',    borderColor: 'border-l-surface-600/50', pulseStatus: 'idle' },
  booting:   { label: 'Booting',   dotColor: 'bg-status-warning', borderColor: 'border-l-yellow-500/50',  pulseStatus: 'idle' },
  running:   { label: 'Running',   dotColor: 'bg-status-success', borderColor: 'border-l-emerald-500/50', pulseStatus: 'running' },
  suspended: { label: 'Suspended', dotColor: 'bg-surface-500',    borderColor: 'border-l-surface-600/50', pulseStatus: 'stopped' },
  error:     { label: 'Error',     dotColor: 'bg-status-error',   borderColor: 'border-l-red-500/50',     pulseStatus: 'error' },
};

const fallback: AgentStatusConfig = configs.created;

export function getAgentStatusConfig(status: string): AgentStatusConfig {
  return configs[status] ?? fallback;
}
