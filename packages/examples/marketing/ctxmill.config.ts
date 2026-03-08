import { defineConfig } from 'ctxmill';

export default defineConfig({
  name: 'marketing',
  version: '0.1.0',
  agents: ['agents/assistant'],
  tools: ['tools/*.ts'],
  knowledge: {
    sources: ['agents/assistant/knowledge.yaml'],
  },
  ui: {
    components: [
      'FunnelChart',
      'PieChart',
      'TimeSeriesChart',
      'MetricCard',
      'TableView',
      'EditableDocument',
      'FieldRequestForm',
    ],
  },
});
