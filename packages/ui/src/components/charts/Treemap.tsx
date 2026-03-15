import {
  ResponsiveContainer,
  Treemap as RechartsTreemap,
  Tooltip,
} from 'recharts';

const COLORS = ['#2dd4bf', '#14b8a6', '#a1a1aa', '#22c55e', '#eab308', '#ef4444'];

interface TreemapProps {
  title?: string;
  data: Record<string, unknown>[];
  dataKey: string;
  nameKey?: string;
  colors?: string[];
  width?: number;
  height?: number;
}

interface TreemapContentProps {
  x: number;
  y: number;
  width: number;
  height: number;
  name?: string;
  index: number;
  colors: string[];
}

function CustomContent({ x, y, width, height, name, index, colors }: TreemapContentProps) {
  const fill = colors[index % colors.length];
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={fill}
        fillOpacity={0.8}
        stroke="#18181b"
        strokeWidth={2}
        rx={2}
      />
      {width > 40 && height > 20 && name && (
        <text
          x={x + width / 2}
          y={y + height / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fill="#fafafa"
          fontSize={Math.min(12, width / 8)}
          fontWeight={500}
        >
          {name}
        </text>
      )}
    </g>
  );
}

export function Treemap({
  title,
  data,
  dataKey,
  nameKey = 'name',
  colors = COLORS,
}: TreemapProps) {
  return (
    <div data-testid="a2ui-treemap" className="w-full h-full bg-transparent">
      {title && (
        <h3 className="text-sm font-semibold text-surface-200 mb-4">{title}</h3>
      )}
      <ResponsiveContainer width="100%" height={300}>
        <RechartsTreemap
          data={data}
          dataKey={dataKey}
          nameKey={nameKey}
          aspectRatio={4 / 3}
          stroke="#18181b"
          content={<CustomContent x={0} y={0} width={0} height={0} index={0} colors={colors} />}
        >
          <Tooltip
            contentStyle={{
              backgroundColor: '#27272a',
              border: '1px solid #3f3f46',
              borderRadius: '6px',
              color: '#d4d4d8',
              fontSize: '13px',
            }}
          />
        </RechartsTreemap>
      </ResponsiveContainer>
    </div>
  );
}
