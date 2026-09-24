import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { fetchCatalogTools, type CatalogTool } from '@/lib/api';
import { ToolBadges, ToolDetailsPanel } from '@/components/tools/ToolPresentation';
import type { Agent, BuiltinToolPolicy, NativeToolPolicy } from '@stablehand/contracts';

type HttpToolDefinition = Agent['httpTools'][number];

export interface AgentToolsTabProps {
  tools: string[];
  httpTools?: HttpToolDefinition[];
  agentId: string;
  nativeToolPolicy?: NativeToolPolicy | null;
  builtinToolPolicy?: BuiltinToolPolicy | null;
}

export function AgentToolsTab({
  tools = [],
  httpTools = [],
  agentId: _agentId,
  nativeToolPolicy,
  builtinToolPolicy,
}: AgentToolsTabProps) {
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

    const effectiveBuiltinPolicy = builtinToolPolicy ?? { policy: 'all' };
    for (const [name, catalog] of catalogTools) {
      if (
        catalog.builtin
        && isToolEnabledByPolicy(name, effectiveBuiltinPolicy)
        && !seen.has(name)
      ) {
        seen.add(name);
        entries.push({ name, catalog, declared: false });
      }
    }

    return entries;
  }, [tools, catalogTools, builtinToolPolicy]);

  const hasNoTools = allToolEntries.length === 0 && httpTools.length === 0;

  return (
    <div data-testid="tools-explorer" className="space-y-8">
      {nativeToolPolicy ? (
        <div className="rounded-lg border border-surface-700 bg-surface-800/50 p-3">
          <h3 className="mb-2 text-sm font-semibold text-surface-200">
            Native SDK tools &mdash; {formatPolicyLabel(nativeToolPolicy)}
          </h3>
          {(nativeToolPolicy.policy === 'allow' || nativeToolPolicy.policy === 'deny') && (
            <div className="flex flex-wrap gap-1.5">
              {nativeToolPolicy.names.map((tool) => (
              <span
                key={tool}
                className={`rounded-full px-2 py-0.5 text-xs font-mono ${
                  nativeToolPolicy.policy === 'allow'
                    ? 'bg-accent/10 text-accent'
                    : 'bg-red-500/10 text-red-400'
                }`}
              >
                {tool}
              </span>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {builtinToolPolicy ? (
        <div className="rounded-lg border border-surface-700 bg-surface-800/50 p-3">
          <h3 className="text-sm font-semibold text-surface-200">
            Built-in tools &mdash; {formatPolicyLabel(builtinToolPolicy)}
          </h3>
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

      {httpTools.length > 0 && (
        <section data-testid="http-tools-section" className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-surface-200">HTTP tools</h3>
            <p className="mt-1 text-xs text-surface-400">
              Agent-scoped capabilities backed by external HTTP endpoints.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {httpTools.map((tool) => (
              <div
                key={tool.name}
                data-testid="http-tool-card"
                className="flex flex-col gap-2 rounded-lg border border-surface-700 bg-surface-800 px-4 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <h4 className="break-all font-mono text-sm font-bold text-surface-200">
                    {tool.name}
                  </h4>
                  <span className="shrink-0 rounded bg-accent-500/10 px-2 py-0.5 font-mono text-[11px] font-medium text-accent-300">
                    {tool.method ?? 'POST'}
                  </span>
                </div>
                <p className="text-xs text-surface-400">{tool.description}</p>
                <p className="break-all font-mono text-[11px] text-surface-400">
                  {tool.endpoint}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function formatPolicyLabel(policy: NativeToolPolicy | BuiltinToolPolicy): string {
  switch (policy.policy) {
    case 'all': return 'All';
    case 'none': return 'None';
    case 'allow': return 'Allow only';
    case 'deny': return 'Deny listed';
  }
}

function isToolEnabledByPolicy(
  name: string,
  policy: BuiltinToolPolicy,
): boolean {
  switch (policy.policy) {
    case 'all': return true;
    case 'none': return false;
    case 'allow': return policy.names.includes(name);
    case 'deny': return !policy.names.includes(name);
  }
}
