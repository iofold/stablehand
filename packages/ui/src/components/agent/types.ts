import type { AgentRun } from '@/stores/agents';

export type TabId = 'overview' | 'knowledge' | 'runs' | 'tools' | 'files' | 'subagents';

export interface KnowledgeItem {
  id: string;
  content: string;
  category?: string;
  source?: string;
  createdAt?: string;
}

export interface KnowledgeStats {
  totalItems: number;
  categories: Record<string, number>;
  recentItems?: number;
}

export interface TraceStats {
  total: number;
  outcomes: Record<string, number>;
  avgSteps: number;
  recent24h: number;
}

export interface FeedbackStats {
  total: number;
  types: Record<string, number>;
  recent24h: number;
}

export interface TraceStep {
  type: string;
  content: string;
  durationMs: number;
  ordinal: number;
  metadata?: Record<string, unknown>;
}

export interface Trace {
  id: string;
  agentId: string;
  runId: string;
  taskDescription?: string;
  steps: TraceStep[];
  startedAt: string;
  completedAt?: string;
  outcome?: string;
}

export const TABS: { id: TabId; label: string; icon: string; testId?: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'LayoutDashboard' },
  { id: 'knowledge', label: 'Knowledge', icon: 'Brain', testId: 'knowledge-tab' },
  { id: 'runs', label: 'Runs', icon: 'Clock', testId: 'runs-tab' },
  { id: 'tools', label: 'Tools', icon: 'Wrench', testId: 'tools-tab' },
  { id: 'files', label: 'Files', icon: 'FolderOpen', testId: 'files-tab' },
  { id: 'subagents', label: 'Subagents', icon: 'GitBranch', testId: 'subagents-tab' },
];

/** Format a timestamp for display */
export function formatTime(ts: number): string {
  if (!ts) return '--';
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Format duration between two timestamps */
export function formatDuration(start: number, end: number): string {
  const elapsed = Math.max(0, end - start);
  const secs = Math.floor(elapsed / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}
