import { useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Play,
  Pencil,
} from 'lucide-react';
import { useAgentsStore } from '@/stores/agents';
import { cn } from '@/lib/utils';
import { countActiveSandboxSessions } from '@/lib/lifecycle-status';
import { AgentStatusBadge } from '@/components/dashboard/AgentStatusBadge';
import { AgentFormModal } from '@/components/agents/AgentFormModal';

import { useAgentDetail } from '@/hooks/useAgentDetail';
import { useAgentTurns } from '@/hooks/useAgentTurns';
import { parseTagsInput } from '@/lib/tags';
import { TurnInspectorPanel } from '@/components/agent/TurnInspectorPanel';

import {
  AgentOverviewTab,
  AgentTurnsTab,
  AgentToolsTab,
  AgentFilesTab,
  AgentArtifactsTab,
  AgentSecretsTab,
} from '@/components/agent';
import type { TabId } from '@/components/agent';

/* ------------------------------------------------------------------ */
/*  Tabs config                                                        */
/* ------------------------------------------------------------------ */

const TABS: { id: TabId; label: string; testId?: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'turns', label: 'Conversations', testId: 'turns-tab' },
  { id: 'tools', label: 'Tools', testId: 'tools-tab' },
  { id: 'files', label: 'Files', testId: 'files-tab' },
  { id: 'artifacts', label: 'Artifacts', testId: 'artifacts-tab' },
  { id: 'secrets', label: 'Secrets', testId: 'secrets-tab' },
];

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const startBackgroundRun = useAgentsStore((s) => s.startBackgroundRun);

  // Tab and turn-filter state live in the URL so places like the Analytics
  // "costs incomplete" badge can deep-link straight to a filtered view.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab: TabId = TABS.some((tab) => tab.id === tabParam)
    ? (tabParam as TabId)
    : 'overview';
  const setActiveTab = (tab: TabId) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (tab === 'overview') {
        next.delete('tab');
      } else {
        next.set('tab', tab);
      }
      if (tab !== 'turns') next.delete('filter');
      return next;
    }, { replace: true });
  };

  // Run form state
  const [showRunForm, setShowRunForm] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [runTask, setRunTask] = useState('');
  const [runTags, setRunTags] = useState('');
  const [submittingRun, setSubmittingRun] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const turnFilter = searchParams.get('filter') ?? 'all';
  const setTurnFilter = (filter: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (filter === 'all') {
        next.delete('filter');
      } else {
        next.set('filter', filter);
      }
      return next;
    }, { replace: true });
  };

  // Conversation-scoped file viewing: when set, Files shows the durable workspace.
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  // Turn inspector state lives in the URL so a specific turn can be deep-linked.
  const inspectedTurnId = searchParams.get('inspect');
  const setInspectedTurnId = (turnId: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (turnId) {
        next.set('inspect', turnId);
      } else {
        next.delete('inspect');
      }
      return next;
    }, { replace: true });
  };

  // Custom hooks
  const {
    agent,
    loading,
    agents,
    allTurns,
    turnsLoading,
    error: agentDetailError,
    loadTurns,
    recentConversations,
    conversationsLoading,
    conversationsError,
    loadConversations,
  } = useAgentDetail(id, activeTab);

  const { filteredTurns } = useAgentTurns(allTurns, turnFilter);
  const conversationCount = agent?.conversationCount ?? 0;
  const activeSandboxSessionCount = countActiveSandboxSessions(agent?.sandboxSessionsByStatus);

  const toolsCount = (agent?.tools?.length ?? 0) + (agent?.httpTools?.length ?? 0) + (agent?.mcpServers?.length ?? 0);

  const handleStartRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !runTask.trim()) return;
    const parsedTags = parseTagsInput(runTags);
    if ('error' in parsedTags) {
      setRunError(parsedTags.error);
      return;
    }
    setSubmittingRun(true);
    setRunError(null);
    try {
      await startBackgroundRun(id, runTask.trim(), parsedTags.tags);
      setRunTask('');
      setRunTags('');
      setShowRunForm(false);
      if (activeTab === 'overview') {
        void loadConversations();
      } else if (activeTab === 'turns') {
        void loadTurns();
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingRun(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Not found state                                                  */
  /* ---------------------------------------------------------------- */

  if (!agent && (loading || agents.length === 0)) {
    return (
      <div className="flex items-center justify-center h-screen bg-surface-950">
        <div className="text-center">
          <div className="h-8 w-8 border-2 border-accent-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-surface-400 text-sm">Loading agent…</p>
        </div>
      </div>
    );
  }

  if (!agent && agentDetailError) {
    return (
      <div className="flex items-center justify-center h-screen bg-surface-950">
        <div role="alert" className="text-center">
          <h2 className="text-xl font-semibold text-red-200 mb-2">Failed to load agent</h2>
          <p className="text-surface-400 mb-4">{agentDetailError}</p>
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="px-4 py-2 bg-accent-600 text-white rounded-lg hover:bg-accent-500 transition-colors"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="flex items-center justify-center h-screen bg-surface-950">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-surface-300 mb-2">Agent not found</h2>
          <p className="text-surface-400 mb-4">The agent you are looking for does not exist.</p>
           <button
             type="button"
             onClick={() => navigate(-1)}
             className="px-4 py-2 bg-accent-600 text-white rounded-lg hover:bg-accent-500 transition-colors"
           >
             Back to Dashboard
           </button>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="flex min-h-screen min-w-0 flex-col bg-surface-950">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-surface-700 bg-surface-850">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="flex min-h-16 flex-wrap items-center gap-3 py-3 sm:h-16 sm:flex-nowrap sm:gap-4 sm:py-0">
             {/* Back button */}
             <button
               type="button"
               data-testid="back-button"
               onClick={() => navigate(-1)}
               className="text-surface-400 hover:text-surface-200 transition-colors"
             >
               <ArrowLeft className="h-4 w-4" />
             </button>

            {/* Agent identity */}
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2.5 min-w-0">
                  <h1
                    data-testid="agent-name"
                    className="text-xl font-semibold text-surface-100 truncate"
                  >
                    {agent.name}
                  </h1>
                  <AgentStatusBadge status={agent.status} />
                </div>
                <div className="flex min-w-0 items-center gap-2 font-mono text-sm text-surface-400">
                  {agent.harness && (
                    <span className="shrink-0 rounded bg-surface-700/60 px-1.5 py-0.5 text-[11px] font-medium text-surface-200 uppercase tracking-wider">
                      {agent.harness}
                    </span>
                  )}
                  <span className="truncate">
                    {(agent.harnessConfig as Record<string, unknown>)?.model as string}
                  </span>
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex basis-full items-center gap-2 pl-7 sm:basis-auto sm:pl-0">
              <button
                type="button"
                onClick={() => setShowEditModal(true)}
                className="flex items-center gap-1.5 rounded-lg bg-surface-700 px-3 py-2 text-sm font-medium text-surface-200 hover:bg-surface-600 transition-colors"
                aria-label="Edit agent"
              >
                <Pencil className="h-4 w-4" />
                Edit
              </button>
              <button
                type="button"
                data-testid="start-turn-button"
                onClick={() => setShowRunForm((v) => !v)}
                className="btn-primary"
              >
                <Play className="h-4 w-4" />
                Start Turn
              </button>
            </div>
          </div>

          {/* Inline run form */}
          {showRunForm && (
            <form
              onSubmit={handleStartRun}
              className="flex flex-col gap-2 pb-3 pt-1 sm:flex-row sm:flex-wrap sm:items-center"
            >
              <input
                type="text"
                data-testid="run-task-input"
                value={runTask}
                onChange={(e) => setRunTask(e.target.value)}
                placeholder="Describe the task..."
                className="flex-1 rounded-lg border border-surface-600/40 bg-surface-800/60 px-3 py-2 text-sm text-surface-200 placeholder-surface-400 focus:outline-none focus:border-accent-500/50 focus:ring-1 focus:ring-accent-500/30"
              />
              <input
                type="text"
                data-testid="run-tags-input"
                value={runTags}
                onChange={(e) => setRunTags(e.target.value)}
                placeholder="Tags (optional): team=growth, env=prod"
                title="Budget-attribution tags for this run, as key=value pairs"
                className="w-full rounded-lg border border-surface-600/40 bg-surface-800/60 px-3 py-2 text-sm text-surface-200 placeholder-surface-500 focus:outline-none focus:border-accent-500/50 focus:ring-1 focus:ring-accent-500/30 sm:w-72"
              />
              <button
                type="submit"
                disabled={submittingRun || !runTask.trim()}
                className="btn-primary"
              >
                {submittingRun ? 'Starting...' : 'Run'}
              </button>
              {runError && (
                <p role="alert" className="basis-full text-sm text-red-300">
                  Failed to start turn: {runError}
                </p>
              )}
            </form>
          )}
        </div>
      </header>

      {/* Tab navigation */}
      <nav className="border-b border-surface-700 bg-surface-850">
        <div className="mx-auto min-w-0 max-w-7xl px-6">
          <div className="flex overflow-x-auto overflow-y-hidden">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  data-testid={tab.testId}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'shrink-0 px-4 py-2.5 text-sm transition-colors border-b-2 -mb-px',
                    isActive
                      ? 'text-surface-100 border-accent-400'
                      : 'text-surface-400 hover:text-surface-200 border-transparent',
                  )}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Tab content */}
      <main className="mx-auto w-full max-w-7xl flex-1 min-w-0 px-6 py-5 space-y-6">
        {activeTab === 'overview' && (
          <AgentOverviewTab
            agent={agent}
            conversationCount={conversationCount}
            activeSandboxSessions={activeSandboxSessionCount}
            toolsCount={toolsCount}
            tokensLast24h={agent?.tokensLast24h}
            tokensTotal={agent?.tokensTotal}
            recentConversations={recentConversations}
            conversationsLoading={conversationsLoading}
            conversationsError={conversationsError}
            onOpenConversation={(conversationId) => navigate(`/agents/${id}/conversations/${conversationId}`)}
            onViewAllConversations={() => setActiveTab('turns')}
            onRetryConversations={() => { void loadConversations(); }}
          />
        )}

        {activeTab === 'turns' && (
          <AgentTurnsTab
            turns={filteredTurns}
            loading={turnsLoading}
            error={agentDetailError}
            filter={turnFilter}
            onFilterChange={setTurnFilter}
            agentId={id!}
            onViewConversationFiles={(conversationId) => {
              setSelectedConversationId(conversationId);
              setActiveTab('files');
            }}
            onContinueConversation={(conversationId) => navigate(`/agents/${id}/conversations/${conversationId}`)}
            onRetry={() => { void loadTurns(); }}
            onInspectTurn={setInspectedTurnId}
          />
        )}

        {activeTab === 'tools' && id && (
          <AgentToolsTab
            tools={agent.tools}
            httpTools={agent.httpTools}
            mcpServerCount={agent.mcpServers?.length ?? 0}
            agentId={id}
            nativeToolPolicy={agent.nativeToolPolicy}
            builtinToolPolicy={agent.builtinToolPolicy}
          />
        )}

        {activeTab === 'files' && id && (
          <div className="space-y-3">
            {selectedConversationId && (
              <div className="flex items-center gap-3 rounded-lg border border-accent-700/30 bg-accent-900/20 px-4 py-2.5">
                <span className="text-sm text-accent-300">
                  Viewing conversation workspace ({selectedConversationId.slice(0, 8)})
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedConversationId(null)}
                  className="text-xs text-accent-400 hover:text-accent-200 underline underline-offset-2 transition-colors"
                >
                  Switch to base workspace
                </button>
              </div>
            )}
            <AgentFilesTab agentId={id} conversationId={selectedConversationId ?? undefined} />
          </div>
        )}

        {activeTab === 'artifacts' && id && (
          <AgentArtifactsTab agentId={id} />
        )}

        {activeTab === 'secrets' && id && (
          <AgentSecretsTab agentId={id} />
        )}
      </main>

      {/* Edit agent modal */}
      <AgentFormModal
        open={showEditModal}
        onClose={() => setShowEditModal(false)}
        agent={agent}
      />

      {/* Per-turn inspector */}
      {inspectedTurnId && id && (
        <TurnInspectorPanel
          agentId={id}
          turnId={inspectedTurnId}
          onClose={() => setInspectedTurnId(null)}
        />
      )}
    </div>
  );
}
