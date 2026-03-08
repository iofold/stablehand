import {
  ResponsiveContainer,
  PieChart as RechartsPieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
} from 'recharts';

const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#f43f5e', '#8b5cf6', '#06b6d4'];

interface PieChartProps {
  title?: string;
  data: Record<string, unknown>[];
  nameKey: string;
  valueKey: string;
  donut?: boolean;
}

export function PieChart({
  title,
  data,
  nameKey,
  valueKey,
  donut = false,
}: PieChartProps) {
  return (
    <div data-testid="a2ui-pie-chart" className="card p-4">
      {title && (
        <h3 className="text-sm font-semibold text-surface-200 mb-4">{title}</h3>
      )}
      <ResponsiveContainer width="100%" height={300}>
        <RechartsPieChart>
          <Pie
            data={data}
            dataKey={valueKey}
            nameKey={nameKey}
            cx="50%"
            cy="50%"
            innerRadius={donut ? 60 : 0}
            outerRadius={100}
            strokeWidth={2}
            stroke="#0f172a"
            label={({ name, percent }) =>
              `${name} ${(percent * 100).toFixed(0)}%`
            }
            labelLine={{ stroke: '#64748b' }}
          >
            {data.map((_, index) => (
              <Cell key={index} fill={COLORS[index % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '8px',
              color: '#e2e8f0',
              fontSize: 12,
            }}
          />
          <Legend />
        </RechartsPieChart>
      </ResponsiveContainer>
    </div>
  );
}
