import { useMemo } from 'react';

interface FunnelStage {
  name: string;
  value: number;
}

interface FunnelChartProps {
  title: string;
  stages: FunnelStage[];
}

const COLORS = ['#2dd4bf', '#14b8a6', '#a1a1aa', '#22c55e', '#eab308', '#ef4444'];

export function FunnelChart({ title, stages }: FunnelChartProps) {
  const layout = useMemo(() => {
    if (stages.length === 0) return null;

    const width = 600;
    const stageHeight = 52;
    const gapHeight = 24;
    const totalHeight = stages.length * stageHeight + (stages.length - 1) * gapHeight + 20;
    const maxValue = stages[0].value || 1;
    const minWidthRatio = 0.2;

    return { width, stageHeight, gapHeight, totalHeight, maxValue, minWidthRatio };
  }, [stages]);

  if (!layout || stages.length === 0) {
    return (
      <div data-testid="a2ui-funnel-chart" className="w-full h-full bg-transparent p-4">
        <h3 className="text-sm font-semibold text-surface-200 mb-4">{title}</h3>
        <p className="text-surface-400 text-sm">No data available</p>
      </div>
    );
  }

  const { width, stageHeight, gapHeight, totalHeight, maxValue, minWidthRatio } = layout;
  const centerX = width / 2;

  const getWidth = (value: number) => {
    const ratio = value / maxValue;
    return (minWidthRatio + ratio * (1 - minWidthRatio)) * (width - 80);
  };

  return (
    <div data-testid="a2ui-funnel-chart" className="w-full h-full bg-transparent p-4">
      <h3 className="text-sm font-semibold text-surface-200 mb-4">{title}</h3>
      <svg viewBox={`0 0 ${width} ${totalHeight}`} className="w-full" style={{ maxHeight: totalHeight }}>
        {stages.map((stage, i) => {
          const y = i * (stageHeight + gapHeight);
          const currentWidth = getWidth(stage.value);
          const nextWidth = i < stages.length - 1 ? getWidth(stages[i + 1].value) : currentWidth * 0.8;
          const color = COLORS[i % COLORS.length];

          const topLeft = centerX - currentWidth / 2;
          const topRight = centerX + currentWidth / 2;
          const bottomLeft = centerX - nextWidth / 2;
          const bottomRight = centerX + nextWidth / 2;

          const points = `${topLeft},${y} ${topRight},${y} ${bottomRight},${y + stageHeight} ${bottomLeft},${y + stageHeight}`;

          const conversionPercent =
            i < stages.length - 1
              ? ((stages[i + 1].value / stage.value) * 100).toFixed(1)
              : null;

          return (
            <g key={i}>
              <polygon points={points} fill={color} opacity={0.85} />
              <text x={centerX} y={y + stageHeight / 2 - 6} textAnchor="middle" fill="#fff" fontSize={13} fontWeight={600}>
                {stage.name}
              </text>
              <text x={centerX} y={y + stageHeight / 2 + 10} textAnchor="middle" fill="#ffffffcc" fontSize={11}>
                {stage.value.toLocaleString()}
              </text>
              {conversionPercent && (
                <text x={centerX} y={y + stageHeight + gapHeight / 2 + 4} textAnchor="middle" fill="#71717a" fontSize={12}>
                  {conversionPercent}% conversion
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
