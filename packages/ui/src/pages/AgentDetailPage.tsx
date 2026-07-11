import { useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Play,
  Pencil,
} from 'lucide-react';
import { useAgentsStore } from '@/stores/agents';
import { cn } from '@/lib/utils';
import { countActiveSessions } from '@/lib/session-status';
import { AgentStatusBadge } from '@/components/dashboard/AgentStatusBadge';
import { AgentFormModal } from '@/components/agents/AgentFormModal';

import { useAgentDetail } from '@/hooks/useAgentDetail';
import { useAgentSessions } from '@/hooks/useAgentSessions';

import {
  AgentOverviewTab,
  AgentSessionsTab,
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
  { id: 'sessions', label: 'Sessions', testId: 'sessions-tab' },
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

  const [activeTab, setActiveTab] = useState<TabId>('overview');

  // Run form state
  const [showRunForm, setShowRunForm] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [runTask, setRunTask] = useState('');
  const [submittingRun, setSubmittingRun] = useState(false);

  const [sessionsFilter, setSessionsFilter] = useState<string>('all');

  // Session-scoped file viewing: when set, Files tab shows session workspace
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  // Custom hooks
  const {
    agent,
    loading,
    agents,
    allSessions,
    sessionsLoading,
    error: agentDetailError,
    loadSessions,
  } = useAgentDetail(id, activeTab);

  const { filteredSessions } = useAgentSessions(allSessions, sessionsFilter);
  const conversationCount = agent?.conversationCount ?? 0;
  const activeSandboxSessionCount = countActiveSessions(agent?.sessionsByStatus);

  const recentSessions = useMemo(() => {
    return [...allSessions]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 10);
  }, [allSessions]);

  const toolsCount = agent?.tools?.length ?? 0;

  const handleStartRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !runTask.trim()) return;
    setSubmittingRun(true);
    try {
      await startBackgroundRun(id, runTask.trim());
      setRunTask('');
      setShowRunForm(false);
      loadSessions();
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
                data-testid="start-session-button"
                onClick={() => setShowRunForm((v) => !v)}
                className="btn-primary"
              >
                <Play className="h-4 w-4" />
                Start Session
              </button>
            </div>
          </div>

          {/* Inline run form */}
          {showRunForm && (
            <form
              onSubmit={handleStartRun}
              className="flex flex-col gap-2 pb-3 pt-1 sm:flex-row sm:items-center"
            >
              <input
                type="text"
                data-testid="run-task-input"
                value={runTask}
                onChange={(e) => setRunTask(e.target.value)}
                placeholder="Describe the task..."
                className="flex-1 rounded-lg border border-surface-600/40 bg-surface-800/60 px-3 py-2 text-sm text-surface-200 placeholder-surface-400 focus:outline-none focus:border-accent-500/50 focus:ring-1 focus:ring-accent-500/30"
              />
              <button
                type="submit"
                disabled={submittingRun || !runTask.trim()}
                className="btn-primary"
              >
                {submittingRun ? 'Starting...' : 'Run'}
              </button>
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
            recentSessions={recentSessions}
            onContinueSession={(conversationId) => {
              if (conversationId) {
                navigate(`/agents/${id}/conversations/${conversationId}`);
              } else {
                setActiveTab('sessions');
              }
            }}
          />
        )}

        {activeTab === 'sessions' && (
          <AgentSessionsTab
            sessions={filteredSessions}
            loading={sessionsLoading}
            error={agentDetailError}
            filter={sessionsFilter}
            onFilterChange={setSessionsFilter}
            agentId={id!}
            onViewSessionFiles={(sessionId) => {
              setSelectedSessionId(sessionId);
              setActiveTab('files');
            }}
            onContinueSession={(conversationId) => navigate(`/agents/${id}/conversations/${conversationId}`)}
            onRetry={() => { void loadSessions(); }}
          />
        )}

        {activeTab === 'tools' && id && (
          <AgentToolsTab tools={agent.tools} agentId={id} nativeTools={agent.nativeTools} />
        )}

        {activeTab === 'files' && id && (
          <div className="space-y-3">
            {selectedSessionId && (
              <div className="flex items-center gap-3 rounded-lg border border-accent-700/30 bg-accent-900/20 px-4 py-2.5">
                <span className="text-sm text-accent-300">
                  Viewing session workspace ({selectedSessionId.slice(0, 8)})
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedSessionId(null)}
                  className="text-xs text-accent-400 hover:text-accent-200 underline underline-offset-2 transition-colors"
                >
                  Switch to base workspace
                </button>
              </div>
            )}
            <AgentFilesTab agentId={id} sessionId={selectedSessionId ?? undefined} />
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
    </div>
  );
}
