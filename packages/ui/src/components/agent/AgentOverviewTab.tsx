import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { RunStatusBadge } from '@/components/dashboard/RunStatusBadge';
import { cn } from '@/lib/utils';
import type { AgentSession } from '@/stores/agents';
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
    workspaceDir?: string | null;
    tools?: string[];
    metadata?: Record<string, unknown> | null;
  };
  totalSessions: number;
  activeSessions: number;
  toolsCount: number;
  recentSessions: AgentSession[];
  onContinueSession: (conversationId: string) => void;
}

export function AgentOverviewTab({
  agent,
  totalSessions,
  activeSessions,
  toolsCount,
  recentSessions,
  onContinueSession,
}: AgentOverviewTabProps) {
  const [promptExpanded, setPromptExpanded] = useState(false);
  const parsedHarnessConfig = agent.harnessConfig;
  const exactConfig = {
    name: agent.name,
    harness: agent.harness,
    harnessConfig: parsedHarnessConfig,
    description: agent.description,
    tools: agent.tools ?? [],
    workspaceDir: agent.workspaceDir ?? undefined,
    metadata: agent.metadata ?? {},
    systemPrompt: agent.systemPrompt ?? '',
  };
  const exactConfigText = JSON.stringify(exactConfig, null, 2);

  return (
    <div className="space-y-6">
      {/* Stats grid */}
      <div className="flex flex-col sm:flex-row divide-y sm:divide-y-0 sm:divide-x divide-surface-700">
        <div className="flex-1 min-w-0"><StatCard label="Total Sessions" value={totalSessions} /></div>
        <div className="flex-1 min-w-0"><StatCard label="Active" value={activeSessions} /></div>
        <div className="flex-1 min-w-0"><StatCard label="Tools Count" value={toolsCount} /></div>
      </div>

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
                   onClick={() => onContinueSession(run.conversationId ?? run.id)}
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
                   onClick={() => onContinueSession('')}
                  className="text-xs font-medium text-accent-400 hover:text-accent-300 transition-colors"
                >
                  View All Sessions
                </button>
              </div>
            )}
          </>
        )}
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
