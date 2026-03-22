import { useState } from 'react';
import {
  Clock,
  Activity,
  Wrench,
  Brain,
  Users,
  ChevronDown,
  ChevronRight,
  Sparkles,
  BookOpen,
} from 'lucide-react';
import { RunStatusBadge } from '@/components/dashboard/RunStatusBadge';
import { cn } from '@/lib/utils';
import type { AgentRun } from '@/stores/agents';
import type {
  KnowledgeItem,
  KnowledgeStats,
  TraceStats,
  FeedbackStats,
} from './types';
import { formatTime } from './types';

/* ------------------------------------------------------------------ */
/*  StatCard                                                           */
/* ------------------------------------------------------------------ */

function StatCard({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="flex flex-col px-6 py-4 min-w-0">
      <span className="text-label mb-1 truncate">{label}</span>
      <span className="tabular-nums text-2xl font-semibold text-surface-100 truncate">
        {value ?? 0}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AgentOverviewTab                                                   */
/* ------------------------------------------------------------------ */

export interface AgentOverviewTabProps {
  agent: {
    name?: string;
    systemPrompt?: string;
    harness: string;
    harnessConfig: Record<string, unknown>;
    description?: string;
    callbackUrl?: string | null;
    workspaceDir?: string | null;
    tools?: string[];
    metadata?: Record<string, unknown> | null;
  };
  totalRuns: number;
  activeRuns: number;
  toolsCount: number;
  knowledgeTotal: number;
  sseClients: number;
  recentSessions: AgentRun[];
  onNavigateSession: (runId: string) => void;
  knowledgeStats?: KnowledgeStats;
  recentKnowledgeItems?: KnowledgeItem[];
  traceStats?: TraceStats;
  feedbackStats?: FeedbackStats;
}

export function AgentOverviewTab({
  agent,
  totalRuns,
  activeRuns,
  toolsCount,
  knowledgeTotal,
  sseClients,
  recentSessions,
  onNavigateSession,
  knowledgeStats,
  recentKnowledgeItems,
  traceStats,
  feedbackStats,
}: AgentOverviewTabProps) {
  const [promptExpanded, setPromptExpanded] = useState(false);
  const parsedHarnessConfig = agent.harnessConfig;
  const exactConfig = {
    name: agent.name,
    harness: agent.harness,
    harnessConfig: parsedHarnessConfig,
    description: agent.description,
    tools: agent.tools ?? [],
    callbackUrl: agent.callbackUrl ?? undefined,
    workspaceDir: agent.workspaceDir ?? undefined,
    metadata: agent.metadata ?? {},
    systemPrompt: agent.systemPrompt ?? '',
  };
  const exactConfigText = JSON.stringify(exactConfig, null, 2);

  return (
    <div className="space-y-6">
      {/* Stats grid */}
      <div className="flex flex-col sm:flex-row divide-y sm:divide-y-0 sm:divide-x divide-surface-700">
        <div className="flex-1 min-w-0"><StatCard label="Total Sessions" value={totalRuns} /></div>
        <div className="flex-1 min-w-0"><StatCard label="Active" value={activeRuns} /></div>
        <div className="flex-1 min-w-0"><StatCard label="Tools Count" value={toolsCount} /></div>
        <div className="flex-1 min-w-0"><StatCard label="Knowledge Items" value={knowledgeTotal} /></div>
        <div className="flex-1 min-w-0"><StatCard label="SSE Clients" value={sseClients} /></div>
      </div>

      {/* Recent runs */}
      <div className="rounded-lg border border-surface-700 bg-surface-800 p-6">
        <h3 className="text-label mb-4">
          Recent Sessions
        </h3>
        {recentSessions.length === 0 ? (
          <p className="text-sm text-surface-400">No sessions yet.</p>
        ) : (
          <>
            <div className="overflow-y-auto max-h-48 flex flex-col">
              {recentSessions.map((run, idx) => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => onNavigateSession(run.id)}
                  className={cn(
                    'flex w-full items-center gap-3 py-3 text-sm transition-colors duration-150 hover:bg-surface-700/60 cursor-pointer text-left px-4 -mx-4 rounded-lg',
                    idx !== recentSessions.length - 1 && 'border-b border-surface-700/50'
                  )}
                >
                  <RunStatusBadge status={run.status} />
                  <span className="flex-shrink-0 font-mono text-surface-400 text-xs" title={run.id}>
                    {run.conversationId ? run.conversationId.slice(0, 8) : run.id.slice(0, 8)}&hellip;
                  </span>
                  <span className="flex-1 min-w-0 truncate text-surface-300">
                    {run.taskDescription || 'No description'}
                  </span>
                  <span className="flex-shrink-0 text-[11px] font-mono text-surface-400 tabular-nums">
                    {formatTime(run.startedAt)}
                  </span>
                  <ChevronRight className="h-4 w-4 text-surface-400" />
                </button>
              ))}
            </div>
            {recentSessions.length > 3 && (
              <div className="mt-3 pt-3 border-t border-surface-700/50 text-center">
                <button
                  type="button"
                  onClick={() => onNavigateSession('')}
                  className="text-xs font-medium text-accent-400 hover:text-accent-300 transition-colors"
                >
                  View All Sessions
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Learning Dashboard */}
      <div data-testid="learning-dashboard" className="rounded-lg border border-surface-700 bg-surface-800 p-6 space-y-6">
        <h3 className="text-label">
          Learning Dashboard
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Knowledge Growth */}
          <div data-testid="knowledge-growth" className="rounded-lg border border-surface-700 bg-surface-900 p-4">
            <p className="text-xs font-medium text-surface-300 mb-2">Knowledge Growth</p>
            <p className="text-2xl font-bold text-surface-100 tabular-nums">{knowledgeStats?.totalItems ?? 0}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {Object.entries(knowledgeStats?.categories ?? {}).map(([cat, count]) => (
                <span key={cat} className="inline-flex items-center rounded-full bg-surface-800 border border-surface-700 px-2 py-0.5 text-[10px] text-surface-300">
                  {cat}: {count as number}
                </span>
              ))}
            </div>
          </div>

          {/* Trace Stats */}
          <div data-testid="trace-stats" className="rounded-lg border border-surface-700 bg-surface-900 p-4">
            <p className="text-xs font-medium text-surface-300 mb-2">Trace Stats</p>
            <p className="text-2xl font-bold text-surface-100 tabular-nums">{traceStats?.total ?? 0}</p>
            <div className="mt-1 text-[11px] text-surface-400 space-y-0.5">
              <p>Avg steps: <span className="text-surface-300 tabular-nums">{traceStats?.avgSteps?.toFixed(1) ?? '0'}</span></p>
              <p>Last 24h: <span className="text-surface-300 tabular-nums">{traceStats?.recent24h ?? 0}</span></p>
              {Object.entries(traceStats?.outcomes ?? {}).map(([outcome, count]) => (
                <span key={outcome} className="inline-flex items-center gap-2 mr-2 text-surface-400">
                  {outcome}: {count as number}
                </span>
              ))}
            </div>
          </div>

          {/* Recent Insights */}
          <div data-testid="recent-insights" className="rounded-lg border border-surface-700 bg-surface-900 p-4">
            <p className="text-xs font-medium text-surface-300 mb-2">Recent Insights</p>
            {recentKnowledgeItems && recentKnowledgeItems.length > 0 ? (
              <div className="space-y-1.5">
                {recentKnowledgeItems.slice(0, 3).map((item) => (
                  <p key={item.id} className="text-[11px] text-surface-400 line-clamp-2">
                    {item.content}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-surface-400">No recent insights.</p>
            )}
          </div>

          {/* Feedback Summary */}
          <div data-testid="feedback-summary" className="rounded-lg border border-surface-700 bg-surface-900 p-4">
            <p className="text-xs font-medium text-surface-300 mb-2">Feedback Summary</p>
            <p className="text-2xl font-bold text-surface-100 tabular-nums">{feedbackStats?.total ?? 0}</p>
            <div className="mt-1 text-[11px] text-surface-400 space-y-0.5">
              <p>Last 24h: <span className="text-surface-300 tabular-nums">{feedbackStats?.recent24h ?? 0}</span></p>
              <div className="flex flex-wrap gap-2 mt-1">
                {Object.entries(feedbackStats?.types ?? {}).map(([type, count]) => (
                  <span key={type} className="inline-flex items-center gap-2 text-surface-400 capitalize">
                    {type}: {count as number}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Configuration */}
      <div className="rounded-lg border border-surface-700 bg-surface-800 overflow-hidden">
        <button
          type="button"
          onClick={() => setPromptExpanded((v) => !v)}
          className="flex w-full items-center justify-between p-6 transition-colors hover:bg-surface-700/50"
        >
          <h3 className="text-label">
            Configuration
          </h3>
          {promptExpanded ? (
            <ChevronDown className="h-4 w-4 text-surface-400" />
          ) : (
            <ChevronRight className="h-4 w-4 text-surface-400" />
          )}
        </button>
        {promptExpanded && (
          <div className="border-t border-surface-700 px-6 py-4 space-y-6">
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              <ConfigField label="Name" value={agent.name} />
              <div>
                <p className="text-label mb-1.5">Model</p>
                <p className="font-mono text-sm text-surface-300">{(agent.harnessConfig as Record<string, unknown>)?.model as string || 'Unknown'}</p>
              </div>
              <ConfigField label="Harness" value={agent.harness ?? undefined} mono />
              <ConfigField label="Workspace" value={agent.workspaceDir ?? undefined} mono />
              <ConfigField label="Callback URL" value={agent.callbackUrl ?? undefined} mono />
              <ConfigField
                label="Tools"
                value={agent.tools && agent.tools.length > 0 ? `${agent.tools.length} configured` : 'None'}
              />
              {agent.description && (
                <div className="sm:col-span-2 lg:col-span-2">
                  <p className="text-label mb-1.5">Description</p>
                  <p className="font-mono text-sm text-surface-300">{agent.description}</p>
                </div>
              )}
            </div>

            {parsedHarnessConfig != null && (
              <div>
                <p className="text-label mb-2">
                  Harness Config
                </p>
                <pre className="whitespace-pre-wrap break-words font-mono text-sm text-surface-300 bg-surface-900 rounded-lg p-4 border border-surface-700 overflow-x-auto">
                  {typeof parsedHarnessConfig === 'string'
                    ? parsedHarnessConfig
                    : JSON.stringify(parsedHarnessConfig, null, 2)}
                </pre>
              </div>
            )}

            {agent.metadata && Object.keys(agent.metadata).length > 0 && (
              <div>
                <p className="text-label mb-2">
                  Metadata
                </p>
                <pre className="whitespace-pre-wrap break-words font-mono text-sm text-surface-300 bg-surface-900 rounded-lg p-4 border border-surface-700 overflow-x-auto">
                  {JSON.stringify(agent.metadata, null, 2)}
                </pre>
              </div>
            )}

            <div>
              <p className="text-label mb-2">
                System Prompt
              </p>
              {agent.systemPrompt ? (
                <pre className="whitespace-pre-wrap font-mono text-sm text-surface-300 bg-surface-900 rounded-lg p-4 max-h-96 overflow-y-auto border border-surface-700">
                  {agent.systemPrompt}
                </pre>
              ) : (
                <p className="text-sm text-surface-400 italic">No system prompt configured.</p>
              )}
            </div>

            <div>
              <p className="text-label mb-2">
                Exact Config
              </p>
              <pre className="whitespace-pre-wrap break-words font-mono text-sm text-surface-300 bg-surface-900 rounded-lg p-4 border border-surface-700 overflow-x-auto">
                {exactConfigText}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ConfigField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-label mb-1.5">{label}</p>
      <p className={cn('text-sm text-surface-300', mono && 'font-mono break-all')}>
        {value || 'Not configured'}
      </p>
    </div>
  );
}

function normalizeJsonLike(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
