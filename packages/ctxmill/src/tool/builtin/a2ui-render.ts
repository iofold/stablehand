import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { isAllowedComponent, sanitizeProps } from '../../a2ui/extract.js';

export const a2uiRenderTool: ToolDefinition = {
  name: 'a2ui-render',
  description: `Render structured visual components in the UI. Displays charts, tables, metric cards, and interactive elements.

Supported components and their props:

CHARTS:
- BarChart: { data: [{x,y},...], xKey: string, yKey: string, title?, color?, width?, height? }
- LineChart: { data: [{x,y},...], xKey: string, yKey: string, title?, color?, width?, height? }
- AreaChart: { data: [{x,y},...], xKey: string, yKey: string, title?, color?, width?, height? }
- PieChart: { data: [{name,value},...], nameKey: string, valueKey: string, title?, colors?: string[], width?, height? }
- ScatterChart: { data: [{x,y},...], xKey: string, yKey: string, title?, color?, width?, height? }
- RadarChart: { data: [...], dataKey: string, title?, width?, height? }
- TimeSeriesChart: { data: [{x,y},...], xKey: string, yKey: string, title?, color?, width?, height? }
- Treemap: { data: [...], dataKey: string, nameKey: string, title?, colors?, width?, height? }
- CandlestickChart: { data: [...], title?, width?, height? }
- FunnelChart: { data: [...], stages?: [...], title?, width?, height?, colors? }
- SankeyDiagram: { nodes: [...], links: [...], title?, width?, height? }
- NetworkGraph: { data: {...}, title?, width?, height? }
- KnowledgeGraphView: { nodes: [...], edges: [...], title?, width?, height? }

DATA DISPLAY:
- MetricCard: { title: string, value: string|number, change?: number, changeLabel?: string, trend?: "up"|"down"|"flat", prefix?, suffix?, description? }
- TableView: { data: [...], columns?: [...], title?, pageSize?: number }

Example: a2ui-render({ component: "BarChart", props: { data: [{"month":"Jan","revenue":100}], xKey: "month", yKey: "revenue", title: "Monthly Revenue" } })`,
  location: 'orchestrator',
  input: z.object({
    component: z.string().describe('Component name from the supported list above'),
    props: z.record(z.string(), z.unknown()).describe('Component-specific props as described above'),
  }),
  handler: async (rawInput: unknown, _ctx) => {
    const input = rawInput as { component: string; props: Record<string, unknown> };

    if (!isAllowedComponent(input.component)) {
      return JSON.stringify({ error: `Unknown component "${input.component}". See tool description for supported components.` });
    }

    const sanitized = sanitizeProps(input.component, input.props);

    return JSON.stringify({ component: input.component, props: sanitized });
  },
};
