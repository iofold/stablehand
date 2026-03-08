import type { FastifyInstance } from 'fastify';

/**
 * A2UI component catalog endpoint.
 * Returns the merged set of declarative UI component catalogs
 * that the frontend renderer can use to render agent-generated UI.
 */
export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/catalogs - Return merged A2UI component catalogs
  app.get('/', async () => {
    return {
      catalogs: [
        {
          name: 'ctxmill.charts',
          components: {
            TimeSeriesChart: {
              props: {
                title: 'string',
                data: 'array',
                xKey: 'string',
                yKey: 'string',
                chartType: 'string?',
              },
            },
            BarChart: {
              props: {
                title: 'string',
                data: 'array',
                xKey: 'string',
                yKey: 'string',
                orientation: 'string?',
              },
            },
            PieChart: {
              props: {
                title: 'string',
                data: 'array',
                nameKey: 'string',
                valueKey: 'string',
                donut: 'boolean?',
              },
            },
            MetricCard: {
              props: {
                title: 'string',
                value: 'string|number',
                change: 'number?',
                changeLabel: 'string?',
                sparkline: 'array?',
              },
            },
            TableView: {
              props: {
                title: 'string',
                columns: 'array',
                data: 'array',
                pageSize: 'number?',
              },
            },
            CandlestickChart: {
              props: {
                title: 'string',
                data: 'array',
              },
            },
            FunnelChart: {
              props: {
                title: 'string',
                stages: 'array',
              },
            },
            SankeyDiagram: {
              props: {
                title: 'string',
                nodes: 'array',
                links: 'array',
              },
            },
            KnowledgeGraphView: {
              props: {
                nodes: 'array',
                edges: 'array',
              },
            },
          },
        },
        {
          name: 'ctxmill.hitl',
          components: {
            ApprovalCard: {
              props: {
                title: 'string',
                description: 'string',
                action: 'string',
                details: 'object?',
              },
            },
            EditableDocument: {
              props: {
                title: 'string',
                content: 'string',
                format: 'string?',
              },
            },
            FieldRequestForm: {
              props: {
                title: 'string',
                fields: 'array',
                submitLabel: 'string?',
              },
            },
          },
        },
      ],
    };
  });
}
