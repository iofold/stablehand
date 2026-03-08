import { useState, useRef, useCallback, useEffect } from 'react';

interface GraphNode {
  id: string;
  label: string;
  group?: string;
}

interface GraphEdge {
  source: string;
  target: string;
  label?: string;
}

interface KnowledgeGraphViewProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];
const groupColorMap: Record<string, string> = {};

function getGroupColor(group: string | undefined): string {
  if (!group) return '#3b82f6';
  if (!groupColorMap[group]) {
    groupColorMap[group] = PALETTE[Object.keys(groupColorMap).length % PALETTE.length];
  }
  return groupColorMap[group];
}

interface NodePosition {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function KnowledgeGraphView({ nodes, edges }: KnowledgeGraphViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [positions, setPositions] = useState<Map<string, NodePosition>>(() => {
    const map = new Map<string, NodePosition>();
    const cx = 400;
    const cy = 300;
    nodes.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / Math.max(nodes.length, 1);
      const r = 120 + Math.random() * 80;
      map.set(n.id, { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r, vx: 0, vy: 0 });
    });
    return map;
  });

  const [dragging, setDragging] = useState<string | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const dragOffset = useRef({ x: 0, y: 0 });
  const animRef = useRef<number | null>(null);

  useEffect(() => {
    let running = true;
    let iterCount = 0;
    const maxIter = 200;

    function tick() {
      if (!running || iterCount > maxIter) return;
      iterCount++;

      setPositions((prev) => {
        const next = new Map<string, NodePosition>();
        const alpha = Math.max(0.01, 0.3 * (1 - iterCount / maxIter));

        for (const [id, pos] of prev) {
          next.set(id, { ...pos });
        }

        const nodeIds = Array.from(next.keys());
        for (let i = 0; i < nodeIds.length; i++) {
          for (let j = i + 1; j < nodeIds.length; j++) {
            const a = next.get(nodeIds[i])!;
            const b = next.get(nodeIds[j])!;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
            const force = (800 / (dist * dist)) * alpha;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx -= fx;
            a.vy -= fy;
            b.vx += fx;
            b.vy += fy;
          }
        }

        for (const edge of edges) {
          const a = next.get(edge.source);
          const b = next.get(edge.target);
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
          const force = (dist - 150) * 0.01 * alpha;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }

        for (const [, pos] of next) {
          pos.vx += (400 - pos.x) * 0.001 * alpha;
          pos.vy += (300 - pos.y) * 0.001 * alpha;
        }

        for (const [id, pos] of next) {
          if (id === dragging) continue;
          pos.vx *= 0.6;
          pos.vy *= 0.6;
          pos.x += pos.vx;
          pos.y += pos.vy;
        }

        return next;
      });

      animRef.current = requestAnimationFrame(tick);
    }

    animRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [nodes, edges, dragging]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, nodeId: string) => {
      e.stopPropagation();
      setDragging(nodeId);
      const pos = positions.get(nodeId);
      if (pos) {
        dragOffset.current = {
          x: e.clientX / zoom - pan.x / zoom - pos.x,
          y: e.clientY / zoom - pan.y / zoom - pos.y,
        };
      }
    },
    [positions, zoom, pan],
  );

  const handleBackgroundMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === svgRef.current || (e.target as Element).tagName === 'svg') {
        setPanning(true);
        panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
      }
    },
    [pan],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (dragging) {
        setPositions((prev) => {
          const next = new Map(prev);
          const pos = next.get(dragging);
          if (pos) {
            next.set(dragging, {
              ...pos,
              x: e.clientX / zoom - pan.x / zoom - dragOffset.current.x,
              y: e.clientY / zoom - pan.y / zoom - dragOffset.current.y,
              vx: 0,
              vy: 0,
            });
          }
          return next;
        });
      } else if (panning) {
        setPan({
          x: panStart.current.panX + (e.clientX - panStart.current.x),
          y: panStart.current.panY + (e.clientY - panStart.current.y),
        });
      }
    },
    [dragging, panning, zoom, pan],
  );

  const handleMouseUp = useCallback(() => {
    setDragging(null);
    setPanning(false);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.min(3, Math.max(0.2, z - e.deltaY * 0.001)));
  }, []);

  return (
    <div data-testid="a2ui-knowledge-graph" className="card p-4 overflow-hidden">
      <svg
        ref={svgRef}
        viewBox="0 0 800 600"
        className="w-full cursor-grab active:cursor-grabbing"
        style={{ maxHeight: 600 }}
        onMouseDown={handleBackgroundMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      >
        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          {edges.map((edge, i) => {
            const source = positions.get(edge.source);
            const target = positions.get(edge.target);
            if (!source || !target) return null;
            const mx = (source.x + target.x) / 2;
            const my = (source.y + target.y) / 2;
            return (
              <g key={`edge-${i}`}>
                <line x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke="#475569" strokeWidth={1.5} opacity={0.6} />
                {edge.label && (
                  <text x={mx} y={my - 6} textAnchor="middle" fill="#94a3b8" fontSize={9}>
                    {edge.label}
                  </text>
                )}
              </g>
            );
          })}
          {nodes.map((n) => {
            const pos = positions.get(n.id);
            if (!pos) return null;
            const color = getGroupColor(n.group);
            return (
              <g key={n.id} onMouseDown={(e) => handleMouseDown(e, n.id)} style={{ cursor: 'pointer' }}>
                <circle cx={pos.x} cy={pos.y} r={18} fill={color} opacity={0.85} />
                <circle cx={pos.x} cy={pos.y} r={18} fill="none" stroke={color} strokeWidth={2} />
                <text x={pos.x} y={pos.y + 30} textAnchor="middle" fill="#e2e8f0" fontSize={10} fontWeight={500}>
                  {n.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
