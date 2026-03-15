import type { FastifyInstance } from 'fastify';

interface CatalogToolResponse {
  name: string;
  description?: string;
  source: 'local' | 'mcp' | 'composio';
  inputSchema?: Record<string, unknown>;
  requiresApproval?: boolean;
  secrets?: string[];
}

/**
 * A2UI component catalog endpoint.
 * Returns the merged set of declarative UI component catalogs
 * that the frontend renderer can use to render agent-generated UI.
 */
export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/catalogs/tools - Return flat list of all tool definitions across agents
  app.get('/tools', async (request): Promise<CatalogToolResponse[]> => {
    const db = app.db;
    const agents = await db.listAgents();
    const seen = new Map<string, CatalogToolResponse>();

    for (const agent of agents) {
      // agent.tools is JSON-parsed by drizzle (string[]), but guard defensively
      const toolNames: string[] = Array.isArray(agent.tools) ? agent.tools : [];

      for (const name of toolNames) {
        if (!seen.has(name)) {
          seen.set(name, {
            name,
            description: `Tool registered by agent ${agent.name ?? agent.id}`,
            source: name.includes(':') ? 'mcp' : 'local',
            requiresApproval: false,
          });
        }
      }
    }

    return Array.from(seen.values());
  });

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
            LineChart: {
              props: {
                title: 'string?',
                data: 'array',
                xKey: 'string',
                yKey: 'string',
              },
            },
            AreaChart: {
              props: {
                title: 'string?',
                data: 'array',
                xKey: 'string',
                yKey: 'string',
              },
            },
            ScatterChart: {
              props: {
                title: 'string?',
                data: 'array',
                xKey: 'string',
                yKey: 'string',
                color: 'string?',
              },
            },
            RadarChart: {
              props: {
                title: 'string?',
                data: 'array',
                dataKey: 'string',
              },
            },
            Treemap: {
              props: {
                title: 'string?',
                data: 'array',
                dataKey: 'string',
                nameKey: 'string?',
                colors: 'array?',
              },
            },
            NetworkGraph: {
              props: {
                title: 'string?',
                data: 'object',
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
