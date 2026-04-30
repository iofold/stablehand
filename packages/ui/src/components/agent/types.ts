import type { AgentSession } from '@/stores/agents';

export type TabId = 'overview' | 'knowledge' | 'sessions' | 'tools' | 'files' | 'artifacts' | 'secrets';

export interface Session {
  conversationId: string;
  startedAt: number;
  messageCount: number;
  lastMessageAt: number;
  sessions: AgentSession[];
}

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

export const TABS: { id: TabId; label: string; icon: string; testId?: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'LayoutDashboard' },
  { id: 'knowledge', label: 'Knowledge', icon: 'Brain', testId: 'knowledge-tab' },
  { id: 'sessions', label: 'Sessions', icon: 'Clock', testId: 'sessions-tab' },
  { id: 'tools', label: 'Tools', icon: 'Wrench', testId: 'tools-tab' },
  { id: 'files', label: 'Files', icon: 'FolderOpen', testId: 'files-tab' },
  { id: 'artifacts', label: 'Artifacts', icon: 'Archive', testId: 'artifacts-tab' },
  { id: 'secrets', label: 'Secrets', icon: 'KeyRound', testId: 'secrets-tab' },
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
