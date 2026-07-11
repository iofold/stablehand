import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { fetchCatalogTools, type CatalogTool } from '@/lib/api';
import { ToolBadges, ToolDetailsPanel } from '@/components/tools/ToolPresentation';

export interface AgentToolsTabProps {
  tools: string[];
  agentId: string;
  nativeTools?: { allowlist?: string[]; blocklist?: string[] } | null;
}

export function AgentToolsTab({ tools = [], agentId: _agentId, nativeTools }: AgentToolsTabProps) {
  const [catalogTools, setCatalogTools] = useState<Map<string, CatalogTool>>(new Map());
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [expandedTool, setExpandedTool] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const loadCatalog = async () => {
      try {
        setCatalogLoading(true);
        const tools = await fetchCatalogTools();
        if (mounted) {
          const map = new Map<string, CatalogTool>();
          tools.forEach((tool) => {
            map.set(tool.name, tool);
          });
          setCatalogTools(map);
        }
      } catch {
        if (mounted) {
          setCatalogTools(new Map());
        }
      } finally {
        if (mounted) {
          setCatalogLoading(false);
        }
      }
    };

    loadCatalog();
    return () => {
      mounted = false;
    };
  }, []);

  const allToolEntries = useMemo(() => {
    const seen = new Set<string>();
    const entries: { name: string; catalog?: CatalogTool; declared: boolean }[] = [];

    for (const name of tools) {
      if (!seen.has(name)) {
        seen.add(name);
        entries.push({ name, catalog: catalogTools.get(name), declared: true });
      }
    }

    for (const [name, catalog] of catalogTools) {
      if (catalog.builtin && !seen.has(name)) {
        seen.add(name);
        entries.push({ name, catalog, declared: false });
      }
    }

    return entries;
  }, [tools, catalogTools]);

  const hasNoTools = allToolEntries.length === 0;

  return (
    <div data-testid="tools-explorer" className="space-y-8">
      {nativeTools && (nativeTools.allowlist?.length || nativeTools.blocklist?.length) ? (
        <div className="rounded-lg border border-surface-700 bg-surface-800/50 p-3">
          <h3 className="mb-2 text-sm font-semibold text-surface-200">
            SDK Native Tools &mdash; {nativeTools.allowlist ? 'Allowlist' : 'Blocklist'}
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {(nativeTools.allowlist ?? nativeTools.blocklist ?? []).map((tool) => (
              <span
                key={tool}
                className={`rounded-full px-2 py-0.5 text-xs font-mono ${
                  nativeTools.allowlist ? 'bg-accent/10 text-accent' : 'bg-red-500/10 text-red-400'
                }`}
              >
                {tool}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-4">
        {hasNoTools ? (
          <div className="py-16 text-center">
            <p className="font-medium text-surface-400">No tools configured</p>
            <p className="mt-1 text-sm text-surface-400">Configure tools in the agent definition to grant it capabilities.</p>
          </div>
        ) : catalogLoading ? (
          <div className="py-16 text-center">
            <p className="animate-pulse text-sm text-surface-400">Loading tool details...</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {allToolEntries.map(({ name, catalog }) => (
              <div
                key={name}
                data-testid="tool-detail-card"
                className="flex flex-col gap-2 rounded-lg border border-surface-700 bg-surface-800 px-4 py-3 transition-colors hover:border-surface-600"
              >
                <div className="flex items-start justify-between gap-2">
                  <h4 className="break-all font-mono text-sm font-bold text-surface-200">{name}</h4>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1">
                    <ToolBadges tool={catalog ?? { source: undefined }} compact />
                  </div>
                </div>

                {catalog?.description ? (
                  <div className="flex flex-col gap-1">
                    <p className={`text-xs text-surface-400 ${expandedTool === name ? '' : 'line-clamp-2'}`}>
                      {catalog.description}
                    </p>
                    <button
                      type="button"
                      onClick={() => setExpandedTool(expandedTool === name ? null : name)}
                      className="mt-1 flex items-center gap-1 self-start text-[11px] text-surface-400 transition-colors hover:text-surface-300"
                    >
                      {expandedTool === name ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      {expandedTool === name ? 'Show less' : 'Show more'}
                    </button>
                  </div>
                ) : null}

                {expandedTool === name && catalog ? (
                  <ToolDetailsPanel tool={catalog} compact showEmpty={false} className="mt-2" />
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
