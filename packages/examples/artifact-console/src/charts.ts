import type { CtxmillA2UIComponents } from '@ctxmill/react';
import type { ComponentType } from 'react';

import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { BarChart } from '@/components/charts/BarChart';
import { PieChart } from '@/components/charts/PieChart';
import { MetricCard } from '@/components/charts/MetricCard';
import { TableView } from '@/components/charts/TableView';
import { CandlestickChart } from '@/components/charts/CandlestickChart';
import { FunnelChart } from '@/components/charts/FunnelChart';
import { SankeyDiagram } from '@/components/charts/SankeyDiagram';
import { KnowledgeGraphView } from '@/components/charts/KnowledgeGraphView';
import { LineChart } from '@/components/charts/LineChart';
import { AreaChart } from '@/components/charts/AreaChart';
import { ScatterChart } from '@/components/charts/ScatterChart';
import { RadarChart } from '@/components/charts/RadarChart';
import { Treemap } from '@/components/charts/Treemap';
import { NetworkGraph } from '@/components/charts/NetworkGraph';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const c = (comp: ComponentType<any>) => comp as ComponentType<Record<string, unknown>>;

const CATALOG: Record<string, ComponentType<Record<string, unknown>>> = {
  TimeSeriesChart: c(TimeSeriesChart),
  BarChart: c(BarChart),
  PieChart: c(PieChart),
  MetricCard: c(MetricCard),
  TableView: c(TableView),
  CandlestickChart: c(CandlestickChart),
  FunnelChart: c(FunnelChart),
  SankeyDiagram: c(SankeyDiagram),
  KnowledgeGraphView: c(KnowledgeGraphView),
  LineChart: c(LineChart),
  AreaChart: c(AreaChart),
  ScatterChart: c(ScatterChart),
  RadarChart: c(RadarChart),
  Treemap: c(Treemap),
  NetworkGraph: c(NetworkGraph),
};

/**
 * The full ctxmill chart catalog, registered under every name variant the
 * AG-UI stream may carry (bare, charts:, ctxmill.charts:).
 */
export function chartComponents(): CtxmillA2UIComponents {
  const components: CtxmillA2UIComponents = {};
  for (const [name, component] of Object.entries(CATALOG)) {
    components[name] = component;
    components[`charts:${name}`] = component;
    components[`ctxmill.charts:${name}`] = component;
  }
  return components;
}
