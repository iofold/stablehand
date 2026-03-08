import {
  ResponsiveContainer,
  BarChart as RechartsBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';

interface BarChartProps {
  title?: string;
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string | string[];
  orientation?: 'vertical' | 'horizontal';
}

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export function BarChart({
  title,
  data,
  xKey,
  yKey,
  orientation = 'vertical',
}: BarChartProps) {
  const yKeys = Array.isArray(yKey) ? yKey : [yKey];
  const isHorizontal = orientation === 'horizontal';

  return (
    <div data-testid="a2ui-bar-chart" className="card p-4">
      {title && (
        <h3 className="text-sm font-semibold text-surface-200 mb-4">{title}</h3>
      )}
      <ResponsiveContainer width="100%" height={300}>
        <RechartsBarChart
          data={data}
          layout={isHorizontal ? 'vertical' : 'horizontal'}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          {isHorizontal ? (
            <>
              <XAxis type="number" stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 11 }} />
              <YAxis
                type="category"
                dataKey={xKey}
                stroke="#64748b"
                tick={{ fill: '#94a3b8', fontSize: 11 }}
                width={80}
              />
            </>
          ) : (
            <>
              <XAxis dataKey={xKey} stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 11 }} />
              <YAxis stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 11 }} />
            </>
          )}
          <Tooltip
            contentStyle={{
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '8px',
              color: '#e2e8f0',
              fontSize: 12,
            }}
          />
          {yKeys.map((key, i) => (
            <Bar
              key={key}
              dataKey={key}
              fill={COLORS[i % COLORS.length]}
              radius={[4, 4, 0, 0]}
            />
          ))}
        </RechartsBarChart>
      </ResponsiveContainer>
    </div>
  );
}
