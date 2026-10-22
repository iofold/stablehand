import { TimeSeriesChart } from './TimeSeriesChart';

interface AreaChartProps {
  title?: string;
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string | string[];
  color?: string;
  colors?: string[];
  height?: number;
}

export function AreaChart(props: AreaChartProps) {
  return <TimeSeriesChart {...props} chartType="area" />;
}
