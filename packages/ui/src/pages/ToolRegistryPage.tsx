import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  Search,
  Wrench,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchCatalogTools, type CatalogTool } from '@/lib/api';
import { ToolTester } from '@/components/tools/ToolTester';
import { AsyncContentState } from '@/components/ui/AsyncContentState';
import { ToolBadges, ToolDetailsPanel } from '@/components/tools/ToolPresentation';
import { PageShell } from '@/components/ui/PageShell';
import { StatsRow } from '@/components/ui/StatsRow';

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
        <div>
          <PageShell
            title="Tool Registry"
            description="Browse all available tools across agents and sources."
            icon={<Wrench className="h-6 w-6 text-accent-400" />}
            actions={(
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-surface-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search tools..."
                  className="w-64 rounded-lg border border-surface-700 bg-surface-800 py-2 pl-9 pr-4 text-sm text-surface-200 placeholder:text-surface-400 focus:outline-none focus:ring-1 focus:ring-accent-500/50"
                />
              </div>
            )}
          />

          {!loading && !error && (
            <StatsRow
              items={[
                { label: 'Total Tools', value: stats.total },
                { label: 'Builtin', value: stats.builtinCount },
                { label: 'Local', value: stats.bySource['local'] ?? 0 },
                { label: 'MCP', value: stats.bySource['mcp'] ?? 0 },
                { label: 'Composio', value: stats.bySource['composio'] ?? 0 },
              ]}
            />
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
                      <ToolBadges tool={tool} />
                    </div>
                  </div>

                  {isExpanded && (
                    <ToolDetailsPanel tool={tool} className="border-t border-surface-700 bg-surface-900/50 px-4 py-4" />
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
