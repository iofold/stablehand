import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  GitBranch,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/stores/agents';
import { fetchTriggers } from '@/lib/api';
import { SankeyDiagram } from '@/components/charts/SankeyDiagram';
import { NetworkGraph } from '@/components/charts/NetworkGraph';

interface Trigger {
  id: string;
  agentId: string;
  eventType: string;
  taskTemplate?: string;
  enabled?: boolean;
}

type ViewMode = 'sankey' | 'network';

export function AgentFlowPage() {
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const navigate = useNavigate();

  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('network');
  const [sidePanel, setSidePanel] = useState(true);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [, triggerData] = await Promise.all([
        agents.length === 0 ? fetchAgents() : Promise.resolve(),
        fetchTriggers(),
      ]);
      setTriggers(Array.isArray(triggerData) ? triggerData : []);
    } catch (err) {
      console.debug('[AgentFlow] Load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [agents.length, fetchAgents]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const agentMap = useMemo(() => {
    const map: Record<string, { id: string; name: string }> = {};
    for (const a of agents) map[a.id] = { id: a.id, name: a.name };
    return map;
  }, [agents]);

  // Build graph data: each trigger connects the event-emitting agents to the triggered agent.
  // Since we don't have explicit source agent on triggers, we model:
  //   - Every trigger's agentId is the *target* agent (the one that reacts)
  //   - We create an "event source" node per unique eventType for the Sankey view
  //   - For network view, we connect agents that share event types
  const graphData = useMemo(() => {
    if (triggers.length === 0) return null;

    // For network view: agent nodes + event type edges
    const nodeIds = new Set<string>();
    const networkNodes: { id: string; label: string; group?: string }[] = [];
    const networkEdges: { source: string; target: string; label?: string }[] = [];

    // Collect all agent IDs involved
    for (const t of triggers) {
      if (!nodeIds.has(t.agentId)) {
        nodeIds.add(t.agentId);
        networkNodes.push({
          id: t.agentId,
          label: agentMap[t.agentId]?.name ?? t.agentId.slice(0, 8),
          group: 'agent',
        });
      }
    }

    // Add event type nodes as intermediary connectors
    const eventTypes = new Set(triggers.map((t) => t.eventType));
    for (const et of eventTypes) {
      const etId = `event:${et}`;
      networkNodes.push({ id: etId, label: et, group: 'event' });
      // Connect each trigger's agent to the event type
      const agentsForEvent = triggers.filter((t) => t.eventType === et);
      for (const t of agentsForEvent) {
        networkEdges.push({ source: etId, target: t.agentId, label: et });
      }
    }

    // Sankey: event sources -> agent targets
    const sankeyNodes = [
      ...Array.from(eventTypes).map((et) => ({ id: `event:${et}`, label: et })),
      ...Array.from(nodeIds).map((id) => ({
        id,
        label: agentMap[id]?.name ?? id.slice(0, 8),
      })),
    ];

    const linkCounts = new Map<string, number>();
    for (const t of triggers) {
      const key = `event:${t.eventType}|${t.agentId}`;
      linkCounts.set(key, (linkCounts.get(key) ?? 0) + 1);
    }

    const sankeyLinks = Array.from(linkCounts.entries()).map(([key, count]) => {
      const [source, target] = key.split('|');
      return { source, target, value: count };
    });

    return { networkNodes, networkEdges, sankeyNodes, sankeyLinks };
  }, [triggers, agentMap]);

  const selectedAgent = useMemo(() => {
    if (!selectedNode) return null;
    return agentMap[selectedNode] ?? null;
  }, [selectedNode, agentMap]);

  const selectedTriggers = useMemo(() => {
    if (!selectedNode) return [];
    return triggers.filter((t) => t.agentId === selectedNode);
  }, [selectedNode, triggers]);

  return (
    <div className="flex min-h-screen flex-col bg-surface-950">
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-5 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-surface-200 flex items-center gap-3">
              <GitBranch className="h-6 w-6 text-accent-400" />
              Agent Flow
            </h2>
            <p className="mt-1.5 text-sm text-surface-400 max-w-lg">
              Visualize agent-to-agent event flows and trigger connections.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* View toggle */}
            <div className="flex rounded-lg border border-surface-700 overflow-hidden">
              <button
                type="button"
                onClick={() => setViewMode('network')}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium transition-colors',
                  viewMode === 'network'
                    ? 'bg-surface-700 text-surface-100'
                    : 'bg-surface-800 text-surface-400 hover:text-surface-200',
                )}
              >
                Network
              </button>
              <button
                type="button"
                onClick={() => setViewMode('sankey')}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium transition-colors',
                  viewMode === 'sankey'
                    ? 'bg-surface-700 text-surface-100'
                    : 'bg-surface-800 text-surface-400 hover:text-surface-200',
                )}
              >
                Sankey
              </button>
            </div>

            {/* Side panel toggle */}
            <button
              type="button"
              onClick={() => setSidePanel(!sidePanel)}
              className="flex items-center gap-1.5 rounded-lg border border-surface-700 bg-surface-800 px-3 py-1.5 text-xs font-medium text-surface-400 hover:text-surface-200 transition-colors"
            >
              {sidePanel ? (
                <PanelRightClose className="h-3.5 w-3.5" />
              ) : (
                <PanelRightOpen className="h-3.5 w-3.5" />
              )}
              Details
            </button>
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 text-accent-400 animate-spin" />
          </div>
        ) : !graphData ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <GitBranch className="h-8 w-8 text-surface-400 mb-3" />
            <p className="text-sm text-surface-400">
              No agent flows configured.
            </p>
            <p className="text-xs text-surface-400 mt-1">
              Create event triggers to connect agents.
            </p>
          </div>
        ) : (
          <div className="flex gap-6">
            {/* Graph area */}
            <div
              className={cn(
                'border border-surface-700 rounded-lg bg-surface-800/30 overflow-hidden min-h-[500px]',
                sidePanel ? 'flex-1' : 'w-full',
              )}
            >
              {viewMode === 'sankey' ? (
                <SankeyDiagram
                  title="Event Flow"
                  nodes={graphData.sankeyNodes}
                  links={graphData.sankeyLinks}
                />
              ) : (
                <NetworkGraph
                  title="Agent Topology"
                  data={{
                    nodes: graphData.networkNodes,
                    edges: graphData.networkEdges,
                  }}
                />
              )}
            </div>

            {/* Side panel */}
            {sidePanel && (
              <div className="w-80 flex-shrink-0 border border-surface-700 rounded-lg bg-surface-800/30 overflow-hidden">
                <div className="border-b border-surface-700 px-4 py-3 bg-surface-800/50 flex items-center justify-between">
                  <span className="text-sm font-medium text-surface-200">Details</span>
                  {selectedNode && (
                    <button
                      type="button"
                      onClick={() => setSelectedNode(null)}
                      className="text-surface-400 hover:text-surface-300 transition-colors"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div className="p-4">
                  {selectedAgent ? (
                    <div className="space-y-4">
                      <div>
                        <p className="text-[11px] font-medium text-surface-400 uppercase tracking-wider mb-1">
                          Agent
                        </p>
                        <button
                          type="button"
                          onClick={() => navigate(`/agents/${selectedAgent.id}`)}
                          className="text-sm font-medium text-accent-400 hover:text-accent-300 transition-colors"
                        >
                          {selectedAgent.name}
                        </button>
                      </div>
                      {selectedTriggers.length > 0 && (
                        <div>
                          <p className="text-[11px] font-medium text-surface-400 uppercase tracking-wider mb-2">
                            Triggers ({selectedTriggers.length})
                          </p>
                          <div className="space-y-2">
                            {selectedTriggers.map((t) => (
                              <div
                                key={t.id}
                                className="rounded-lg border border-surface-700 bg-surface-900/50 px-3 py-2"
                              >
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-mono text-surface-200">
                                    {t.eventType}
                                  </span>
                                  <span
                                    className={cn(
                                      'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                                      t.enabled !== false
                                        ? 'bg-green-500/10 text-green-400'
                                        : 'bg-surface-700/50 text-surface-400',
                                    )}
                                  >
                                    {t.enabled !== false ? 'active' : 'disabled'}
                                  </span>
                                </div>
                                {t.taskTemplate && (
                                  <p className="mt-1 text-[11px] text-surface-400 truncate">
                                    {t.taskTemplate}
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-center py-8">
                      <p className="text-xs text-surface-400">
                        Select an agent node to view details.
                      </p>
                    </div>
                  )}

                  {/* Summary */}
                  <div className="mt-6 pt-4 border-t border-surface-700">
                    <p className="text-[11px] font-medium text-surface-400 uppercase tracking-wider mb-2">
                      Summary
                    </p>
                    <div className="space-y-1.5 text-xs text-surface-400">
                      <div className="flex justify-between">
                        <span>Agents</span>
                        <span className="text-surface-200 tabular-nums">
                          {new Set(triggers.map((t) => t.agentId)).size}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>Event Types</span>
                        <span className="text-surface-200 tabular-nums">
                          {new Set(triggers.map((t) => t.eventType)).size}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>Total Triggers</span>
                        <span className="text-surface-200 tabular-nums">
                          {triggers.length}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
