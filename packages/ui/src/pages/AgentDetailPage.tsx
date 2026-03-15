import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  MessageSquare,
  Play,
  LayoutDashboard,
  Brain,
  Wrench,
  Clock,
  FolderOpen,
  GitBranch,
  Bot,
  Cpu,
  Pencil,
} from 'lucide-react';
import { AgentStatusBadge } from '@/components/dashboard/AgentStatusBadge';
import { useAgentsStore } from '@/stores/agents';
import { cn } from '@/lib/utils';
import { AgentFormModal } from '@/components/agents/AgentFormModal';

import { useAgentDetail } from '@/hooks/useAgentDetail';
import { useAgentRuns } from '@/hooks/useAgentRuns';
import { useAgentKnowledge } from '@/hooks/useAgentKnowledge';

import {
  AgentOverviewTab,
  AgentKnowledgeTab,
  AgentRunsTab,
  AgentToolsTab,
  AgentFilesTab,
  AgentSubagentsTab,
} from '@/components/agent';
import type { TabId } from '@/components/agent';

/* ------------------------------------------------------------------ */
/*  Tabs config                                                        */
/* ------------------------------------------------------------------ */

const TABS: { id: TabId; label: string; testId?: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'knowledge', label: 'Knowledge', testId: 'knowledge-tab' },
  { id: 'runs', label: 'Runs', testId: 'runs-tab' },
  { id: 'tools', label: 'Tools', testId: 'tools-tab' },
  { id: 'files', label: 'Files', testId: 'files-tab' },
  { id: 'subagents', label: 'Subagents', testId: 'subagents-tab' },
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

  // Runs filter state
  const [runsFilter, setRunsFilter] = useState<string>('all');

  // Session-scoped file viewing: when set, Files tab shows session workspace
  const [sessionRunId, setSessionRunId] = useState<string | null>(null);

  // Custom hooks
  const {
    agent,
    loading,
    agents,
    allRuns,
    runsLoading,
    loadRuns,
    traces,
    overviewKnowledgeItems,
    overviewKnowledgeStats,
    traceStats,
    feedbackStats,
  } = useAgentDetail(id, activeTab);

  const { filteredRuns, totalRuns, activeRunsCount } = useAgentRuns(allRuns, runsFilter);

  const {
    knowledgeItems,
    knowledgeStats,
    knowledgeLoading,
    knowledgeSearch,
    setKnowledgeSearch,
    knowledgeCategoryFilter,
    setKnowledgeCategoryFilter,
  } = useAgentKnowledge(id, activeTab);

  const toolsCount = agent?.tools?.length ?? 0;
  const sseClients = agent?.sseClients ?? 0;

  const handleStartRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !runTask.trim()) return;
    setSubmittingRun(true);
    try {
      await startBackgroundRun(id, runTask.trim());
      setRunTask('');
      setShowRunForm(false);
      loadRuns();
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

  if (!agent) {
    return (
      <div className="flex items-center justify-center h-screen bg-surface-950">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-surface-300 mb-2">Agent not found</h2>
          <p className="text-surface-500 mb-4">The agent you are looking for does not exist.</p>
          <button
            onClick={() => navigate('/')}
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
    <div className="flex min-h-screen flex-col bg-surface-950">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-surface-700 bg-surface-850">
        <div className="mx-auto max-w-7xl px-6">
          <div className="flex h-16 items-center gap-4">
            {/* Back button */}
            <button
              type="button"
              data-testid="back-button"
              onClick={() => navigate('/')}
              className="text-surface-400 hover:text-surface-200 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>

            {/* Agent identity */}
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <h1
                    data-testid="agent-name"
                    className="text-xl font-semibold text-surface-100 truncate"
                  >
                    {agent.name}
                  </h1>
                  <div className="flex items-center gap-1.5 text-xs text-surface-400">
                    <div
                      className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        agent.status === 'active' ? 'bg-green-500' : 'bg-surface-500',
                      )}
                    />
                    <span className="capitalize">{agent.status}</span>
                  </div>
                </div>
                <div className="font-mono text-sm text-surface-500">
                  {agent.model}
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                onClick={() => setShowEditModal(true)}
                className="rounded-lg p-2 text-surface-400 hover:bg-surface-800 hover:text-surface-200 transition-colors"
                aria-label="Edit agent"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => navigate(`/agents/${id}/chat`)}
                className="btn-secondary"
              >
                <MessageSquare className="h-4 w-4" />
                Open Chat
              </button>
              <button
                type="button"
                data-testid="start-run-button"
                onClick={() => setShowRunForm((v) => !v)}
                className="btn-primary"
              >
                <Play className="h-4 w-4" />
                Start Run
              </button>
            </div>
          </div>

          {/* Inline run form */}
          {showRunForm && (
            <form
              onSubmit={handleStartRun}
              className="flex items-center gap-2 pb-3 pt-1"
            >
              <input
                type="text"
                data-testid="run-task-input"
                value={runTask}
                onChange={(e) => setRunTask(e.target.value)}
                placeholder="Describe the task..."
                autoFocus
                className="flex-1 rounded-lg border border-surface-600/40 bg-surface-800/60 px-3 py-2 text-sm text-surface-200 placeholder-surface-600 focus:outline-none focus:border-accent-500/50 focus:ring-1 focus:ring-accent-500/30"
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
        <div className="mx-auto max-w-7xl px-6">
          <div className="flex overflow-x-auto">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  data-testid={tab.testId}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'px-4 py-2.5 text-sm transition-colors border-b-2 -mb-px',
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
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-5 space-y-6">
        {activeTab === 'overview' && (
          <AgentOverviewTab
            agent={agent}
            totalRuns={totalRuns}
            activeRuns={activeRunsCount}
            toolsCount={toolsCount}
            knowledgeTotal={overviewKnowledgeStats.totalItems ?? 0}
            sseClients={sseClients}
            recentRuns={allRuns.slice(0, 10)}
            onNavigateRun={(runId) => navigate(`/agents/${id}/runs/${runId}`)}
            knowledgeStats={overviewKnowledgeStats}
            recentKnowledgeItems={overviewKnowledgeItems}
            traceStats={traceStats}
            feedbackStats={feedbackStats}
          />
        )}

        {activeTab === 'knowledge' && (
          <AgentKnowledgeTab
            items={knowledgeItems}
            stats={knowledgeStats}
            loading={knowledgeLoading}
            search={knowledgeSearch}
            onSearchChange={setKnowledgeSearch}
            categoryFilter={knowledgeCategoryFilter}
            onCategoryFilterChange={setKnowledgeCategoryFilter}
          />
        )}

        {activeTab === 'runs' && (
          <AgentRunsTab
            runs={filteredRuns}
            loading={runsLoading}
            filter={runsFilter}
            onFilterChange={setRunsFilter}
            agentId={id!}
            traces={traces}
            onViewSessionFiles={(runId) => {
              setSessionRunId(runId);
              setActiveTab('files');
            }}
          />
        )}

        {activeTab === 'tools' && id && (
          <AgentToolsTab tools={agent.tools} skills={(agent.skills ?? agent.metadata?.skills as string[] | undefined) ?? []} agentId={id} />
        )}

        {activeTab === 'files' && id && (
          <div className="space-y-3">
            {sessionRunId && (
              <div className="flex items-center gap-3 rounded-lg border border-accent-700/30 bg-accent-900/20 px-4 py-2.5">
                <span className="text-sm text-accent-300">
                  Viewing session workspace (run {sessionRunId.slice(0, 8)})
                </span>
                <button
                  type="button"
                  onClick={() => setSessionRunId(null)}
                  className="text-xs text-accent-400 hover:text-accent-200 underline underline-offset-2 transition-colors"
                >
                  Switch to base workspace
                </button>
              </div>
            )}
            <AgentFilesTab agentId={id} runId={sessionRunId ?? undefined} />
          </div>
        )}

        {activeTab === 'subagents' && (
          <AgentSubagentsTab agent={agent} agents={agents} />
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
