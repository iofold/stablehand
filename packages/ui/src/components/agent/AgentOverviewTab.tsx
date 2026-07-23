import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { Agent, ConversationSummary } from '@ctxmill/contracts';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import { cn } from '@/lib/utils';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { formatCompactNumber } from '@/lib/format';

/* ------------------------------------------------------------------ */
/*  StatCard                                                           */
/* ------------------------------------------------------------------ */

function StatCard({
  label,
  value,
  title,
}: {
  label: string;
  value: number | string;
  title?: string;
}) {
  return (
    <div className="flex flex-col px-6 py-4 min-w-0">
      <span className="text-label mb-1 truncate">{label}</span>
      <span className="tabular-nums text-2xl font-semibold text-surface-100 truncate" title={title}>
        {value ?? 0}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AgentOverviewTab                                                   */
/* ------------------------------------------------------------------ */

export interface AgentOverviewTabProps {
  agent: Agent;
  conversationCount: number;
  activeSandboxSessions: number;
  toolsCount: number;
  tokensLast24h?: number;
  tokensTotal?: number;
  recentConversations: ConversationSummary[];
  conversationsLoading: boolean;
  conversationsError: string | null;
  onOpenConversation: (conversationId: string) => void;
  onViewAllConversations: () => void;
  onRetryConversations?: () => void;
}

export function AgentOverviewTab({
  agent,
  conversationCount,
  activeSandboxSessions,
  toolsCount,
  tokensLast24h,
  tokensTotal,
  recentConversations,
  conversationsLoading,
  conversationsError,
  onOpenConversation,
  onViewAllConversations,
  onRetryConversations,
}: AgentOverviewTabProps) {
  const [promptExpanded, setPromptExpanded] = useState(false);
  const parsedHarnessConfig = agent.harnessConfig;
  const canonicalResponseText = JSON.stringify(agent, null, 2);

  return (
    <div className="space-y-6">
      {/* Stats grid */}
      <div className="flex flex-col sm:flex-row divide-y sm:divide-y-0 sm:divide-x divide-surface-700">
        <div className="flex-1 min-w-0"><StatCard label="Conversations" value={conversationCount} /></div>
        <div className="flex-1 min-w-0"><StatCard label="Active Sandboxes" value={activeSandboxSessions} /></div>
        <div className="flex-1 min-w-0"><StatCard label="Tools Count" value={toolsCount} /></div>
        <div className="flex-1 min-w-0">
          <StatCard
            label="Tokens (24h)"
            value={formatCompactNumber(tokensLast24h ?? 0)}
            title={`${(tokensTotal ?? 0).toLocaleString()} tokens total`}
          />
        </div>
      </div>

      <div className="rounded-lg border border-surface-700 bg-surface-800 p-6">
        <h3 className="text-label mb-4">
          Recent Conversations
        </h3>
        {conversationsLoading ? (
          <p className="py-5 text-sm text-surface-400">Loading conversations…</p>
        ) : conversationsError ? (
          <div
            role="alert"
            className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-4"
          >
            <p className="text-sm font-medium text-red-200">Failed to load conversations</p>
            <p className="mt-1 text-sm text-red-200/70">{conversationsError}</p>
            {onRetryConversations && (
              <button
                type="button"
                onClick={onRetryConversations}
                className="btn-secondary mt-3"
              >
                Retry
              </button>
            )}
          </div>
        ) : recentConversations.length === 0 ? (
          <p className="text-sm text-surface-400">No conversations yet.</p>
        ) : (
          <>
            <div className="flex flex-col">
              {recentConversations.map((conversation, index) => (
                <button
                  key={conversation.id}
                  type="button"
                  data-testid="recent-conversation-row"
                  onClick={() => onOpenConversation(conversation.id)}
                  className={cn(
                    'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 rounded-lg px-4 py-3 text-left text-sm transition-colors duration-150 hover:bg-surface-700/60 sm:grid-cols-[8.5rem_minmax(0,1fr)_auto_auto] sm:items-center',
                    index !== recentConversations.length - 1 && 'border-b border-surface-700/50',
                  )}
                >
                  <StatusBadge status={conversation.status} subject="Conversation" />
                  <span className="min-w-0 truncate text-surface-300">
                    {conversation.taskDescription || 'No description'}
                  </span>
                  <span className="col-span-2 flex items-center gap-3 text-xs text-surface-400 sm:col-span-1">
                    <span>{conversation.turnCount} {conversation.turnCount === 1 ? 'turn' : 'turns'}</span>
                    <span>{conversation.messageCount} {conversation.messageCount === 1 ? 'message' : 'messages'}</span>
                  </span>
                  <RelativeTime
                    timestamp={conversation.updatedAt}
                    className="text-right text-[11px] font-mono text-surface-400 tabular-nums"
                  />
                </button>
              ))}
            </div>
            {conversationCount > recentConversations.length && (
              <div className="mt-3 pt-3 border-t border-surface-700/50 text-center">
                <button
                  type="button"
                  onClick={onViewAllConversations}
                  className="text-xs font-medium text-accent-400 hover:text-accent-300 transition-colors"
                >
                  View All Conversations
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
                Canonical API Response
              </p>
              <pre className="whitespace-pre-wrap break-words font-mono text-sm text-surface-300 bg-surface-900 rounded-lg p-4 border border-surface-700 overflow-x-auto">
                {canonicalResponseText}
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
