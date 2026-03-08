import { defineConfig } from 'ctxmill';

export default defineConfig({
  name: 'supply-chain',
  version: '0.1.0',
  agents: ['agents/assistant'],
  tools: ['tools/*.ts'],
  knowledge: {
    sources: ['agents/assistant/knowledge.yaml'],
  },
  ui: {
    components: [
      'SankeyDiagram',
      'FunnelChart',
      'TableView',
      'MetricCard',
      'EditableDocument',
      'ApprovalCard',
    ],
  },
});
