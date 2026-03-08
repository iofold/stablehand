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
import { ApprovalCard } from '@/components/hitl/ApprovalCard';
import { EditableDocument } from '@/components/hitl/EditableDocument';
import { FieldRequestForm } from '@/components/hitl/FieldRequestForm';

type AnyProps = Record<string, unknown>;

const registry = new Map<string, ComponentType<AnyProps>>();

export function registerCatalog(name: string, components: Record<string, ComponentType<AnyProps>>) {
  for (const [key, component] of Object.entries(components)) {
    registry.set(`${name}:${key}`, component);
    // Also register without prefix for convenience
    if (!registry.has(key)) {
      registry.set(key, component);
    }
  }
}

export function registerComponent(name: string, component: ComponentType<AnyProps>) {
  registry.set(name, component);
}

export function resolve(componentName: string): ComponentType<AnyProps> | undefined {
  return registry.get(componentName);
}

export function listRegistered(): string[] {
  return Array.from(registry.keys());
}

// Register all built-in components
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const c = (comp: ComponentType<any>) => comp as unknown as ComponentType<AnyProps>;

registerCatalog('charts', {
  TimeSeriesChart: c(TimeSeriesChart),
  BarChart: c(BarChart),
  PieChart: c(PieChart),
  MetricCard: c(MetricCard),
  TableView: c(TableView),
  CandlestickChart: c(CandlestickChart),
  FunnelChart: c(FunnelChart),
  SankeyDiagram: c(SankeyDiagram),
  KnowledgeGraphView: c(KnowledgeGraphView),
});

registerCatalog('hitl', {
  ApprovalCard: c(ApprovalCard),
  EditableDocument: c(EditableDocument),
  FieldRequestForm: c(FieldRequestForm),
});
