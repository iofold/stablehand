import {
  ResponsiveContainer,
  RadarChart as RechartsRadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  Tooltip,
} from 'recharts';

const COLORS = ['#2dd4bf', '#14b8a6', '#a1a1aa', '#22c55e', '#eab308', '#ef4444'];

interface RadarChartProps {
  title?: string;
  data: Record<string, unknown>[];
  dataKey: string | string[];
  width?: number;
  height?: number;
}

export function RadarChart({
  title,
  data,
  dataKey,
}: RadarChartProps) {
  const dataKeys = Array.isArray(dataKey) ? dataKey : [dataKey];
  // Assume first non-dataKey string field is the angle axis label
  const angleKey = data.length > 0
    ? Object.keys(data[0]).find((k) => !dataKeys.includes(k) && typeof data[0][k] === 'string') ?? 'subject'
    : 'subject';

  return (
    <div data-testid="a2ui-radar-chart" className="w-full h-full bg-transparent">
      {title && (
        <h3 className="text-sm font-semibold text-surface-200 mb-4">{title}</h3>
      )}
      <ResponsiveContainer width="100%" height={300}>
        <RechartsRadarChart data={data} cx="50%" cy="50%" outerRadius="70%">
          <PolarGrid stroke="#3f3f46" strokeOpacity={0.4} />
          <PolarAngleAxis dataKey={angleKey} tick={{ fill: '#71717a', fontSize: 12 }} />
          <PolarRadiusAxis tick={{ fill: '#71717a', fontSize: 10 }} stroke="#3f3f46" />
          <Tooltip
            contentStyle={{
              backgroundColor: '#27272a',
              border: '1px solid #3f3f46',
              borderRadius: '6px',
              color: '#d4d4d8',
              fontSize: '13px',
            }}
          />
          {dataKeys.map((key, i) => (
            <Radar
              key={key}
              dataKey={key}
              stroke={COLORS[i % COLORS.length]}
              fill={COLORS[i % COLORS.length]}
              fillOpacity={0.15}
              strokeWidth={2}
            />
          ))}
        </RechartsRadarChart>
      </ResponsiveContainer>
    </div>
  );
}
