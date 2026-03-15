import { KnowledgeGraphView } from './KnowledgeGraphView';

interface NetworkGraphProps {
  data?: {
    nodes: { id: string; label: string; group?: string }[];
    edges: { source: string; target: string; label?: string }[];
  };
  title?: string;
  width?: number;
  height?: number;
}

export function NetworkGraph({ data, title }: NetworkGraphProps) {
  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];

  return (
    <div data-testid="a2ui-network-graph">
      {title && (
        <h3 className="text-sm font-semibold text-surface-200 mb-4">{title}</h3>
      )}
      <KnowledgeGraphView nodes={nodes} edges={edges} />
    </div>
  );
}
