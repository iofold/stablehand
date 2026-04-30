import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  Search,
  Shield,
  Wrench,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchCatalogTools, type CatalogTool } from '@/lib/api';
import { ToolTester } from '@/components/tools/ToolTester';
import { AsyncContentState } from '@/components/ui/AsyncContentState';

function sourceBadgeClass(source: string): string {
  switch (source) {
    case 'local':
      return 'bg-blue-500/10 border-blue-500/20 text-blue-400';
    case 'mcp':
      return 'bg-purple-500/10 border-purple-500/20 text-purple-400';
    case 'composio':
      return 'bg-amber-500/10 border-amber-500/20 text-amber-400';
    default:
      return 'bg-surface-700/30 border-surface-600/30 text-surface-400';
  }
}

function locationBadgeClass(location?: string): string {
  switch (location) {
    case 'orchestrator':
      return 'bg-blue-500/10 border-blue-500/20 text-blue-400';
    case 'daemon':
      return 'bg-purple-500/10 border-purple-500/20 text-purple-400';
    case 'sandbox':
    default:
      return 'bg-surface-700/30 border-surface-600/30 text-surface-400';
  }
}

export function ToolRegistryPage() {
  const [tools, setTools] = useState<CatalogTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  const [testingTool, setTestingTool] = useState<string | null>(null);

  const loadTools = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchCatalogTools();
      setTools(Array.isArray(data) ? data : []);
    } catch (err) {
      console.debug('[ToolRegistry] Load failed:', err);
      setError('Failed to load tools');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTools();
  }, [loadTools]);

  const filtered = useMemo(() => {
    if (!search.trim()) return tools;
    const q = search.toLowerCase();
    return tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.description?.toLowerCase().includes(q) ?? false),
    );
  }, [tools, search]);

  const stats = useMemo(() => {
    const bySource: Record<string, number> = {};
    let builtinCount = 0;
    for (const t of tools) {
      bySource[t.source] = (bySource[t.source] ?? 0) + 1;
      if (t.builtin) builtinCount++;
    }
    return { total: tools.length, bySource, builtinCount };
  }, [tools]);

  return (
    <div className="flex min-h-screen flex-col bg-surface-950">
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-5 space-y-6">
        {/* Header */}
        <div>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-surface-200 flex items-center gap-3">
                <Wrench className="h-6 w-6 text-accent-400" />
                Tool Registry
              </h2>
              <p className="mt-1.5 text-sm text-surface-400 max-w-lg">
                Browse all available tools across agents and sources.
              </p>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-surface-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tools..."
                className="rounded-lg border border-surface-700 bg-surface-800 pl-9 pr-4 py-2 text-sm text-surface-200 placeholder:text-surface-400 focus:outline-none focus:ring-1 focus:ring-accent-500/50 w-64"
              />
            </div>
          </div>

          {/* Stats row */}
          {!loading && !error && (
            <div className="mt-6 flex flex-col sm:flex-row items-stretch divide-y sm:divide-y-0 sm:divide-x divide-surface-700">
              <div className="flex-1 p-4 first:pl-0">
                <p className="text-label">Total Tools</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-surface-100">
                  {stats.total}
                </p>
              </div>
              <div className="flex-1 p-4">
                <p className="text-label">Builtin</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-surface-100">
                  {stats.builtinCount}
                </p>
              </div>
              <div className="flex-1 p-4">
                <p className="text-label">Local</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-surface-100">
                  {stats.bySource['local'] ?? 0}
                </p>
              </div>
              <div className="flex-1 p-4">
                <p className="text-label">MCP</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-surface-100">
                  {stats.bySource['mcp'] ?? 0}
                </p>
              </div>
              <div className="flex-1 p-4">
                <p className="text-label">Composio</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-surface-100">
                  {stats.bySource['composio'] ?? 0}
                </p>
              </div>
            </div>
          )}
        </div>

        <AsyncContentState
          loading={loading}
          error={error && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <Wrench className="h-8 w-8 text-surface-400 mb-3" />
              <p className="text-sm text-surface-400">{error}</p>
            </div>
          )}
          empty={filtered.length === 0}
          loadingFallback={
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-6 w-6 text-accent-400 animate-spin" />
            </div>
          }
          emptyFallback={
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <Wrench className="h-8 w-8 text-surface-400 mb-3" />
              <p className="text-sm text-surface-400">
                {search ? 'No tools match your search.' : 'No tools registered yet.'}
              </p>
              <p className="text-xs text-surface-400 mt-1">
                Tools will appear here when agents register them.
              </p>
            </div>
          }
        >
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map((tool) => {
              const isExpanded = expandedTool === tool.name;
              return (
                <div
                  key={tool.name}
                  className="border border-surface-700 rounded-lg bg-surface-800/30 overflow-hidden"
                >
                  <div
                    onClick={() => setExpandedTool(isExpanded ? null : tool.name)}
                    className="w-full text-left px-4 py-4 hover:bg-surface-800/50 transition-colors cursor-pointer"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-surface-100 font-mono truncate">
                            {tool.name}
                          </span>
                          {isExpanded ? (
                            <ChevronDown className="h-3.5 w-3.5 text-surface-400 flex-shrink-0" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-surface-400 flex-shrink-0" />
                          )}
                        </div>
                        {tool.description && (
                          <p className="mt-1.5 text-xs text-surface-400">
                            {tool.description}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setTestingTool(testingTool === tool.name ? null : tool.name);
                          if (testingTool !== tool.name && !isExpanded) {
                            setExpandedTool(tool.name);
                          }
                        }}
                        className={cn(
                          "flex-shrink-0 inline-flex items-center justify-center rounded-md p-1.5 transition-colors",
                          testingTool === tool.name
                            ? "bg-accent-500/20 text-accent-400"
                            : "bg-surface-800 text-surface-400 hover:bg-surface-700 hover:text-surface-200"
                        )}
                        title="Test Tool"
                      >
                        <Play className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {tool.builtin && (
                        <span className="inline-flex rounded-md border px-2 py-0.5 text-[11px] font-medium bg-sky-500/10 border-sky-500/20 text-sky-400">
                          builtin
                        </span>
                      )}
                      {tool.location && (
                        <span className={cn('inline-flex rounded-md border px-2 py-0.5 text-[11px] font-medium', locationBadgeClass(tool.location))}>
                          {tool.location}
                        </span>
                      )}
                      <span
                        className={cn(
                          'inline-flex rounded-md border px-2 py-0.5 text-[11px] font-medium',
                          sourceBadgeClass(tool.source),
                        )}
                      >
                        {tool.source}
                      </span>
                      {tool.requiresApproval && (
                        <span className="inline-flex items-center gap-1 rounded-md border border-orange-500/20 bg-orange-500/10 px-2 py-0.5 text-[11px] font-medium text-orange-400">
                          <Shield className="h-3 w-3" />
                          requires approval
                        </span>
                      )}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-surface-700 bg-surface-900/50 px-4 py-4 space-y-3">
                      {tool.inputSchema && (
                        <div>
                          <p className="text-[11px] font-medium text-surface-400 uppercase tracking-wider mb-2">
                            Input Schema
                          </p>
                          <pre className="overflow-x-auto rounded-lg bg-surface-950 border border-surface-700 p-3 text-xs text-surface-300 font-mono leading-relaxed max-h-60">
                            {JSON.stringify(tool.inputSchema, null, 2)}
                          </pre>
                        </div>
                      )}
                      {tool.secrets && tool.secrets.length > 0 && (
                        <div>
                          <p className="text-[11px] font-medium text-surface-400 uppercase tracking-wider mb-2">
                            Secrets
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {tool.secrets.map((s) => (
                              <span
                                key={s}
                                className="inline-flex rounded-md border border-surface-600 bg-surface-800 px-2 py-0.5 text-[11px] font-mono text-surface-300"
                              >
                                {s}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {!tool.inputSchema && (!tool.secrets || tool.secrets.length === 0) && (
                        <p className="text-xs text-surface-400">No additional details available.</p>
                      )}
                    </div>
                  )}

                  {testingTool === tool.name && (
                    <ToolTester
                      toolName={tool.name}
                      inputSchema={tool.inputSchema}
                      onClose={() => setTestingTool(null)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </AsyncContentState>
      </main>
    </div>
  );
}
