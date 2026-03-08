import { useEffect, useState, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  MessageSquare,
  Play,
  LayoutDashboard,
  Brain,
  Wrench,
  Clock,
  Activity,
  Users,
  ChevronDown,
  ChevronRight,
  Search,
  ShieldCheck,
  Bot,
  Cpu,
  BookOpen,
  Hash,
  Tag,
} from 'lucide-react';
import { AgentStatusBadge } from '@/components/dashboard/AgentStatusBadge';
import { RunStatusBadge } from '@/components/dashboard/RunStatusBadge';
import { useAgentsStore } from '@/stores/agents';
import type { AgentRun } from '@/stores/agents';
import { fetchKnowledge, fetchKnowledgeStats } from '@/lib/api';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type TabId = 'overview' | 'knowledge' | 'runs' | 'tools';

interface KnowledgeItem {
  id: string;
  content: string;
  category?: string;
  source?: string;
  createdAt?: string;
}

interface KnowledgeStats {
  total: number;
  categories: Record<string, number>;
}

/* ------------------------------------------------------------------ */
/*  Tabs config                                                       */
/* ------------------------------------------------------------------ */

const TABS: { id: TabId; label: string; icon: React.ElementType; testId?: string }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'knowledge', label: 'Knowledge', icon: Brain, testId: 'knowledge-tab' },
  { id: 'runs', label: 'Runs', icon: Clock, testId: 'runs-tab' },
  { id: 'tools', label: 'Tools', icon: Wrench, testId: 'tools-tab' },
];

/* ------------------------------------------------------------------ */
/*  Main component                                                    */
/* ------------------------------------------------------------------ */

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const storeFetchRuns = useAgentsStore((s) => s.fetchRuns);
  const startBackgroundRun = useAgentsStore((s) => s.startBackgroundRun);

  const [activeTab, setActiveTab] = useState<TabId>('overview');

  // Run form state
  const [showRunForm, setShowRunForm] = useState(false);
  const [runTask, setRunTask] = useState('');
  const [submittingRun, setSubmittingRun] = useState(false);

  // Runs tab state
  const [allRuns, setAllRuns] = useState<AgentRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsFilter, setRunsFilter] = useState<string>('all');

  // Knowledge tab state
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([]);
  const [knowledgeStats, setKnowledgeStats] = useState<KnowledgeStats>({ total: 0, categories: {} });
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeSearch, setKnowledgeSearch] = useState('');
  const [knowledgeCategoryFilter, setKnowledgeCategoryFilter] = useState<string>('');

  // System prompt collapse
  const [promptExpanded, setPromptExpanded] = useState(false);

  useEffect(() => {
    if (agents.length === 0) fetchAgents();
  }, [agents.length, fetchAgents]);

  const agent = agents.find((a) => a.id === id);

  // Fetch runs when Runs or Overview tab is active
  const loadRuns = useCallback(async () => {
    if (!id) return;
    setRunsLoading(true);
    try {
      const runs = await storeFetchRuns(id);
      setAllRuns(Array.isArray(runs) ? runs : []);
    } catch (err) {
      console.debug('[AgentDetail] Failed to load runs:', err);
    } finally {
      setRunsLoading(false);
    }
  }, [id, storeFetchRuns]);

  useEffect(() => {
    if (activeTab === 'runs' || activeTab === 'overview') loadRuns();
  }, [activeTab, loadRuns]);

  // Fetch knowledge when Knowledge tab is active
  useEffect(() => {
    if (activeTab !== 'knowledge' || !id) return;
    let mounted = true;
    setKnowledgeLoading(true);

    const params: { search?: string; category?: string } = {};
    if (knowledgeSearch.trim()) params.search = knowledgeSearch.trim();
    if (knowledgeCategoryFilter) params.category = knowledgeCategoryFilter;

    Promise.all([
      fetchKnowledge(id, params),
      fetchKnowledgeStats(id),
    ])
      .then(([items, stats]) => {
        if (!mounted) return;
        setKnowledgeItems(Array.isArray(items) ? items : []);
        setKnowledgeStats(stats && typeof stats === 'object' ? stats as KnowledgeStats : { total: 0, categories: {} });
      })
      .catch((err) => {
        console.debug('[AgentDetail] Failed to load knowledge:', err);
      })
      .finally(() => {
        if (mounted) setKnowledgeLoading(false);
      });

    return () => { mounted = false; };
  }, [activeTab, id, knowledgeSearch, knowledgeCategoryFilter]);

  // Filtered runs
  const filteredRuns = useMemo(() => {
    if (runsFilter === 'all') return allRuns;
    return allRuns.filter((r) => r.status === runsFilter);
  }, [allRuns, runsFilter]);

  // Stats for overview
  const totalRuns = allRuns.length;
  const activeRunsCount = allRuns.filter((r) => r.status === 'running' || r.status === 'queued').length;
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
  /*  Not found state                                                 */
  /* ---------------------------------------------------------------- */

  if (!agent) {
    return (
      <div className="flex items-center justify-center h-screen bg-surface-950">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-surface-300 mb-2">Agent not found</h2>
          <p className="text-surface-500 mb-4">The agent you are looking for does not exist.</p>
          <button
            onClick={() => navigate('/')}
            className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-500 transition-colors"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                          */
  /* ---------------------------------------------------------------- */

  return (
    <div className="flex min-h-screen flex-col bg-surface-950">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-surface-700/50 bg-surface-900/80 backdrop-blur-sm">
        <div className="mx-auto max-w-7xl px-6">
          <div className="flex h-16 items-center gap-4">
            {/* Back button */}
            <button
              type="button"
              data-testid="back-button"
              onClick={() => navigate('/')}
              className="rounded-lg p-1.5 text-surface-400 hover:bg-surface-800 hover:text-surface-200 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>

            {/* Agent identity */}
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600/20 ring-1 ring-brand-500/30 flex-shrink-0">
                <Bot className="h-5 w-5 text-brand-400" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <h1
                    data-testid="agent-name"
                    className="text-lg font-bold text-surface-100 truncate"
                  >
                    {agent.name}
                  </h1>
                  <AgentStatusBadge status={agent.status} />
                </div>
                <div className="flex items-center gap-2 text-xs text-surface-500">
                  <Cpu className="h-3 w-3 flex-shrink-0" />
                  <span className="font-mono truncate">{agent.model}</span>
                  {agent.description && (
                    <>
                      <span className="text-surface-700">|</span>
                      <span className="truncate text-surface-400">{agent.description}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                onClick={() => navigate(`/agents/${id}/chat`)}
                className="flex items-center gap-1.5 rounded-lg bg-surface-800 border border-surface-700/50 px-3.5 py-2 text-sm font-medium text-surface-200 hover:bg-surface-700 hover:border-surface-600/50 transition-colors"
              >
                <MessageSquare className="h-4 w-4 text-brand-400" />
                Open Chat
              </button>
              <button
                type="button"
                onClick={() => setShowRunForm((v) => !v)}
                className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-500 transition-colors"
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
                value={runTask}
                onChange={(e) => setRunTask(e.target.value)}
                placeholder="Describe the task..."
                autoFocus
                className="flex-1 rounded-lg border border-surface-600/40 bg-surface-800/60 px-3 py-2 text-sm text-surface-200 placeholder-surface-600 focus:outline-none focus:border-brand-500/50 focus:ring-1 focus:ring-brand-500/30"
              />
              <button
                type="submit"
                disabled={submittingRun || !runTask.trim()}
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submittingRun ? 'Starting...' : 'Run'}
              </button>
            </form>
          )}
        </div>
      </header>

      {/* Tab navigation */}
      <nav className="border-b border-surface-700/40 bg-surface-900/40">
        <div className="mx-auto max-w-7xl px-6">
          <div className="flex gap-1">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  data-testid={tab.testId}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'flex items-center gap-1.5 px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px',
                    isActive
                      ? 'border-brand-500 text-brand-400'
                      : 'border-transparent text-surface-500 hover:text-surface-300 hover:border-surface-600',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Tab content */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        {activeTab === 'overview' && (
          <OverviewTab
            agent={agent}
            totalRuns={totalRuns}
            activeRuns={activeRunsCount}
            toolsCount={toolsCount}
            knowledgeTotal={knowledgeStats.total}
            sseClients={sseClients}
            recentRuns={allRuns.slice(0, 10)}
            promptExpanded={promptExpanded}
            onTogglePrompt={() => setPromptExpanded((v) => !v)}
            onNavigateRun={(runId) => navigate(`/agents/${id}/runs/${runId}`)}
          />
        )}

        {activeTab === 'knowledge' && (
          <KnowledgeTab
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
          <RunsTab
            runs={filteredRuns}
            loading={runsLoading}
            filter={runsFilter}
            onFilterChange={setRunsFilter}
            agentId={id!}
            onNavigateRun={(runId) => navigate(`/agents/${id}/runs/${runId}`)}
          />
        )}

        {activeTab === 'tools' && (
          <ToolsTab tools={agent.tools} />
        )}
      </main>
    </div>
  );
}

/* ================================================================== */
/*  Overview Tab                                                      */
/* ================================================================== */

function OverviewTab({
  agent,
  totalRuns,
  activeRuns,
  toolsCount,
  knowledgeTotal,
  sseClients,
  recentRuns,
  promptExpanded,
  onTogglePrompt,
  onNavigateRun,
}: {
  agent: { systemPrompt?: string };
  totalRuns: number;
  activeRuns: number;
  toolsCount: number;
  knowledgeTotal: number;
  sseClients: number;
  recentRuns: AgentRun[];
  promptExpanded: boolean;
  onTogglePrompt: () => void;
  onNavigateRun: (runId: string) => void;
}) {
  return (
    <div className="space-y-6">
      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard icon={<Clock className="h-4 w-4" />} label="Total Runs" value={totalRuns} accent="text-brand-400" />
        <StatCard icon={<Activity className="h-4 w-4" />} label="Active Runs" value={activeRuns} accent="text-green-400" />
        <StatCard icon={<Wrench className="h-4 w-4" />} label="Tools Count" value={toolsCount} accent="text-amber-400" />
        <StatCard icon={<Brain className="h-4 w-4" />} label="Knowledge Items" value={knowledgeTotal} accent="text-purple-400" />
        <StatCard icon={<Users className="h-4 w-4" />} label="SSE Clients" value={sseClients} accent="text-cyan-400" />
      </div>

      {/* Recent runs */}
      <div className="rounded-xl border border-surface-700/40 bg-surface-900/60 p-5">
        <h3 className="text-sm font-semibold text-surface-200 mb-4 flex items-center gap-2">
          <Clock className="h-4 w-4 text-surface-400" />
          Recent Runs
        </h3>
        {recentRuns.length === 0 ? (
          <p className="text-sm text-surface-500">No runs yet.</p>
        ) : (
          <div className="space-y-2">
            {recentRuns.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => onNavigateRun(run.id)}
                className="flex w-full items-center gap-3 rounded-lg border border-surface-700/30 bg-surface-800/40 px-4 py-3 text-sm transition-colors hover:border-brand-500/40 hover:bg-surface-800 cursor-pointer text-left"
              >
                <RunStatusBadge status={run.status} />
                <span className="flex-1 min-w-0 truncate text-surface-300">
                  {run.taskDescription || run.id}
                </span>
                <span className="flex-shrink-0 text-[11px] text-surface-500 tabular-nums">
                  {formatTime(run.startedAt)}
                </span>
                <ChevronRight className="h-4 w-4 text-surface-600" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* System prompt */}
      <div className="rounded-xl border border-surface-700/40 bg-surface-900/60">
        <button
          type="button"
          onClick={onTogglePrompt}
          className="flex w-full items-center justify-between p-5"
        >
          <h3 className="text-sm font-semibold text-surface-200 flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-surface-400" />
            System Prompt
          </h3>
          {promptExpanded ? (
            <ChevronDown className="h-4 w-4 text-surface-500" />
          ) : (
            <ChevronRight className="h-4 w-4 text-surface-500" />
          )}
        </button>
        {promptExpanded && (
          <div className="border-t border-surface-700/30 px-5 pb-5 pt-3">
            {agent.systemPrompt ? (
              <pre className="whitespace-pre-wrap font-mono text-sm text-surface-300 bg-surface-800/60 rounded-lg p-4 max-h-96 overflow-y-auto border border-surface-700/30">
                {agent.systemPrompt}
              </pre>
            ) : (
              <p className="text-sm text-surface-500 italic">No system prompt configured.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ================================================================== */
/*  Knowledge Tab                                                     */
/* ================================================================== */

function KnowledgeTab({
  items,
  stats,
  loading,
  search,
  onSearchChange,
  categoryFilter,
  onCategoryFilterChange,
}: {
  items: KnowledgeItem[];
  stats: KnowledgeStats;
  loading: boolean;
  search: string;
  onSearchChange: (v: string) => void;
  categoryFilter: string;
  onCategoryFilterChange: (v: string) => void;
}) {
  const categories = Object.entries(stats.categories || {});

  return (
    <div data-testid="knowledge-explorer" className="space-y-6">
      {/* Stats card */}
      <div className="rounded-xl border border-surface-700/40 bg-surface-900/60 p-5">
        <div className="flex items-center gap-6 flex-wrap">
          <div>
            <p className="text-2xl font-bold text-surface-100 tabular-nums">{stats.total}</p>
            <p className="text-xs text-surface-500 mt-0.5">Total Items</p>
          </div>
          {categories.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {categories.map(([cat, count]) => (
                <span
                  key={cat}
                  className="inline-flex items-center gap-1 rounded-full bg-brand-600/10 border border-brand-500/20 px-2.5 py-0.5 text-[11px] font-medium text-brand-300"
                >
                  <Hash className="h-3 w-3" />
                  {cat}: {count as number}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Search & filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-surface-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search knowledge..."
            className="w-full rounded-lg border border-surface-600/40 bg-surface-800/60 py-2 pl-9 pr-3 text-sm text-surface-200 placeholder-surface-600 focus:outline-none focus:border-brand-500/50 focus:ring-1 focus:ring-brand-500/30"
          />
        </div>
        {/* Category filter pills */}
        <div className="flex gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => onCategoryFilterChange('')}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors border',
              !categoryFilter
                ? 'bg-brand-600/20 border-brand-500/30 text-brand-300'
                : 'bg-surface-800/60 border-surface-700/40 text-surface-400 hover:text-surface-300',
            )}
          >
            All
          </button>
          {categories.map(([cat]) => (
            <button
              key={cat}
              type="button"
              onClick={() => onCategoryFilterChange(categoryFilter === cat ? '' : cat)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors border',
                categoryFilter === cat
                  ? 'bg-brand-600/20 border-brand-500/30 text-brand-300'
                  : 'bg-surface-800/60 border-surface-700/40 text-surface-400 hover:text-surface-300',
              )}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Knowledge items list */}
      {loading ? (
        <div className="text-center py-12 text-surface-500 text-sm">Loading knowledge...</div>
      ) : items.length === 0 ? (
        <div className="text-center py-16">
          <Brain className="mx-auto h-10 w-10 text-surface-700 mb-3" />
          <p className="text-surface-400 font-medium">No knowledge items yet</p>
          <p className="text-surface-600 text-sm mt-1">This agent has not learned anything yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div
              key={item.id}
              className="rounded-lg border border-surface-700/30 bg-surface-800/40 p-4"
            >
              <p className="text-sm text-surface-300 line-clamp-3">{item.content}</p>
              <div className="flex items-center gap-3 mt-2.5 text-[11px] text-surface-500">
                {item.category && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-brand-600/10 border border-brand-500/20 px-2 py-0.5 text-brand-300">
                    <Tag className="h-2.5 w-2.5" />
                    {item.category}
                  </span>
                )}
                {item.source && <span>Source: {item.source}</span>}
                {item.createdAt && (
                  <span>{new Date(item.createdAt).toLocaleDateString()}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
/*  Runs Tab                                                          */
/* ================================================================== */

const RUN_FILTERS = ['all', 'running', 'completed', 'error', 'cancelled'] as const;

function RunsTab({
  runs,
  loading,
  filter,
  onFilterChange,
  agentId,
  onNavigateRun,
}: {
  runs: AgentRun[];
  loading: boolean;
  filter: string;
  onFilterChange: (v: string) => void;
  agentId: string;
  onNavigateRun: (runId: string) => void;
}) {
  return (
    <div data-testid="runs-history" className="space-y-4">
      {/* Status filter */}
      <div className="flex gap-1.5 flex-wrap">
        {RUN_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => onFilterChange(f)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors border capitalize',
              filter === f
                ? 'bg-brand-600/20 border-brand-500/30 text-brand-300'
                : 'bg-surface-800/60 border-surface-700/40 text-surface-400 hover:text-surface-300',
            )}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Runs list */}
      {loading ? (
        <div className="text-center py-12 text-surface-500 text-sm">Loading runs...</div>
      ) : runs.length === 0 ? (
        <div className="text-center py-16">
          <Clock className="mx-auto h-10 w-10 text-surface-700 mb-3" />
          <p className="text-surface-400 font-medium">No runs found</p>
          <p className="text-surface-600 text-sm mt-1">
            {filter === 'all' ? 'Start a run to see it here.' : `No ${filter} runs.`}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => onNavigateRun(run.id)}
              className="flex w-full items-center gap-3 rounded-lg border border-surface-700/30 bg-surface-800/40 px-4 py-3 text-sm transition-colors hover:border-brand-500/40 hover:bg-surface-800 cursor-pointer text-left"
            >
              <RunStatusBadge status={run.status} />
              <span className="flex-1 min-w-0 truncate text-surface-300">
                {run.taskDescription || run.id}
              </span>
              <div className="flex items-center gap-4 flex-shrink-0 text-[11px] text-surface-500 tabular-nums">
                <span>{formatTime(run.startedAt)}</span>
                {run.completedAt && (
                  <span>{formatDuration(run.startedAt, run.completedAt)}</span>
                )}
              </div>
              <ChevronRight className="h-4 w-4 text-surface-600 flex-shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
/*  Tools Tab                                                         */
/* ================================================================== */

function ToolsTab({ tools }: { tools: string[] }) {
  // Tool names may encode metadata — for now treat them as plain strings.
  // Tools requiring HITL approval often have an "approval" or "hitl" suffix.
  const isHITL = (tool: string) =>
    /approve|hitl|human/i.test(tool);

  return (
    <div data-testid="tools-explorer" className="space-y-4">
      {tools.length === 0 ? (
        <div className="text-center py-16">
          <Wrench className="mx-auto h-10 w-10 text-surface-700 mb-3" />
          <p className="text-surface-400 font-medium">No tools configured</p>
          <p className="text-surface-600 text-sm mt-1">This agent has no tools available.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {tools.map((tool) => (
            <div
              key={tool}
              data-testid="tool-detail-card"
              className="rounded-xl border border-surface-700/30 bg-surface-800/40 p-4 transition-colors hover:border-surface-600/50"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10 border border-amber-500/20 flex-shrink-0">
                  <Wrench className="h-4 w-4 text-amber-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-semibold text-surface-200 truncate">{tool}</h4>
                  <p className="text-xs text-surface-500 mt-0.5">Agent tool</p>
                </div>
              </div>
              {isHITL(tool) && (
                <div className="mt-3 flex items-center gap-1.5 text-[11px] text-amber-300">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  <span>Requires approval (HITL)</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
/*  Shared small components                                           */
/* ================================================================== */

function StatCard({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  accent: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-surface-700/30 bg-surface-900/60 px-4 py-3">
      <div className={cn('flex-shrink-0', accent)}>{icon}</div>
      <div className="min-w-0">
        <p className="text-lg font-semibold tabular-nums text-surface-100 leading-tight">
          {value}
        </p>
        <p className="text-[11px] text-surface-500 leading-tight mt-0.5">{label}</p>
      </div>
    </div>
  );
}

/* ================================================================== */
/*  Helpers                                                           */
/* ================================================================== */

function formatTime(ts: number): string {
  if (!ts) return '--';
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(start: number, end: number): string {
  const elapsed = Math.max(0, end - start);
  const secs = Math.floor(elapsed / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}
