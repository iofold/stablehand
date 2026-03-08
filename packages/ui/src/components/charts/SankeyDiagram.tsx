import { useMemo } from 'react';

interface SankeyNode {
  id: string;
  label: string;
}

interface SankeyLink {
  source: string;
  target: string;
  value: number;
}

interface SankeyDiagramProps {
  title: string;
  nodes: SankeyNode[];
  links: SankeyLink[];
}

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];

export function SankeyDiagram({ title, nodes, links }: SankeyDiagramProps) {
  const layout = useMemo(() => {
    if (nodes.length === 0) return null;

    const width = 700;
    const height = 400;
    const nodeWidth = 20;
    const nodePadding = 16;
    const paddingX = 40;
    const paddingY = 20;

    // Assign columns via topological depth
    const incoming = new Map<string, string[]>();
    for (const n of nodes) {
      incoming.set(n.id, []);
    }
    for (const l of links) {
      incoming.get(l.target)?.push(l.source);
    }

    const depth = new Map<string, number>();
    const visited = new Set<string>();

    function calcDepth(id: string): number {
      if (depth.has(id)) return depth.get(id)!;
      if (visited.has(id)) return 0;
      visited.add(id);
      const parents = incoming.get(id) ?? [];
      const d = parents.length === 0 ? 0 : Math.max(...parents.map(calcDepth)) + 1;
      depth.set(id, d);
      return d;
    }

    for (const n of nodes) calcDepth(n.id);

    const maxDepth = Math.max(...Array.from(depth.values()), 0);
    const columns: string[][] = Array.from({ length: maxDepth + 1 }, () => []);
    for (const n of nodes) {
      columns[depth.get(n.id) ?? 0].push(n.id);
    }

    // Node values
    const nodeValue = new Map<string, number>();
    for (const n of nodes) {
      const outVal = links.filter((l) => l.source === n.id).reduce((s, l) => s + l.value, 0);
      const inVal = links.filter((l) => l.target === n.id).reduce((s, l) => s + l.value, 0);
      nodeValue.set(n.id, Math.max(outVal, inVal, 1));
    }

    const colWidth = maxDepth > 0 ? (width - paddingX * 2 - nodeWidth) / maxDepth : 0;
    const nodePositions = new Map<string, { x: number; y: number; h: number }>();

    for (let col = 0; col <= maxDepth; col++) {
      const colNodes = columns[col];
      const totalValue = colNodes.reduce((s, id) => s + (nodeValue.get(id) ?? 1), 0);
      const availableHeight = height - paddingY * 2 - (colNodes.length - 1) * nodePadding;
      const scale = availableHeight / Math.max(totalValue, 1);

      let y = paddingY;
      for (const id of colNodes) {
        const h = Math.max(8, (nodeValue.get(id) ?? 1) * scale);
        nodePositions.set(id, { x: paddingX + col * colWidth, y, h });
        y += h + nodePadding;
      }
    }

    // Build link paths
    const sourceOffsets = new Map<string, number>();
    const targetOffsets = new Map<string, number>();
    for (const n of nodes) {
      const pos = nodePositions.get(n.id)!;
      sourceOffsets.set(n.id, pos.y);
      targetOffsets.set(n.id, pos.y);
    }

    const linkPaths = links.map((link, i) => {
      const sPos = nodePositions.get(link.source);
      const tPos = nodePositions.get(link.target);
      if (!sPos || !tPos) return null;

      const sValue = nodeValue.get(link.source) ?? 1;
      const tValue = nodeValue.get(link.target) ?? 1;
      const sThickness = (link.value / sValue) * sPos.h;
      const tThickness = (link.value / tValue) * tPos.h;

      const sy = sourceOffsets.get(link.source)!;
      sourceOffsets.set(link.source, sy + sThickness);

      const ty = targetOffsets.get(link.target)!;
      targetOffsets.set(link.target, ty + tThickness);

      const x0 = sPos.x + nodeWidth;
      const x1 = tPos.x;
      const mx = (x0 + x1) / 2;

      const d = `M${x0},${sy} C${mx},${sy} ${mx},${ty} ${x1},${ty} L${x1},${ty + tThickness} C${mx},${ty + tThickness} ${mx},${sy + sThickness} ${x0},${sy + sThickness} Z`;

      return { d, color: COLORS[i % COLORS.length], value: link.value };
    });

    return { width, height, nodePositions, linkPaths, nodeWidth };
  }, [nodes, links]);

  if (!layout) {
    return (
      <div data-testid="a2ui-sankey-diagram" className="card p-4">
        <h3 className="text-sm font-semibold text-surface-200 mb-4">{title}</h3>
        <p className="text-surface-400 text-sm">No data available</p>
      </div>
    );
  }

  const { width, height, nodePositions, linkPaths, nodeWidth } = layout;

  return (
    <div data-testid="a2ui-sankey-diagram" className="card p-4">
      <h3 className="text-sm font-semibold text-surface-200 mb-4">{title}</h3>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: height }}>
        {linkPaths.map((lp, i) =>
          lp ? <path key={`link-${i}`} d={lp.d} fill={lp.color} opacity={0.35} /> : null,
        )}
        {nodes.map((n, i) => {
          const pos = nodePositions.get(n.id);
          if (!pos) return null;
          const color = COLORS[i % COLORS.length];
          return (
            <g key={n.id}>
              <rect className="sankey-node" x={pos.x} y={pos.y} width={nodeWidth} height={pos.h} fill={color} rx={3} />
              <text x={pos.x + nodeWidth + 6} y={pos.y + pos.h / 2 + 4} fill="#e2e8f0" fontSize={11}>
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
