import { defineConfig } from 'ctxmill';

export default defineConfig({
  name: 'finance-dashboard',
  version: '0.1.0',
  agents: ['agents/assistant'],
  tools: ['tools/*.ts'],
  knowledge: {
    sources: ['agents/assistant/knowledge.yaml'],
  },
  ui: {
    components: [
      'MetricCard',
      'CandlestickChart',
      'PieChart',
      'TableView',
      'TimeSeriesChart',
      'ApprovalCard',
    ],
  },
});
