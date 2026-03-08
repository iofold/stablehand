import { defineTool } from 'ctxmill';
import { z } from 'zod';

export default defineTool({
  name: 'get-supply-chain-flow',
  description: 'Get the current supply chain flow showing material movement from suppliers through warehouses to end customers',
  input: z.object({
    region: z.enum(['all', 'north-america', 'europe', 'asia-pacific']).default('all').describe('Filter by geographic region'),
  }),
  handler: async (input, _ctx) => {
    const nodes = [
      // Suppliers
      { id: 'sup-shenzhen', name: 'Shenzhen Components', type: 'supplier', region: 'asia-pacific' },
      { id: 'sup-taipei', name: 'Taipei Electronics', type: 'supplier', region: 'asia-pacific' },
      { id: 'sup-munich', name: 'Munich Precision', type: 'supplier', region: 'europe' },
      { id: 'sup-detroit', name: 'Detroit Materials', type: 'supplier', region: 'north-america' },
      // Warehouses
      { id: 'wh-la', name: 'Los Angeles DC', type: 'warehouse', region: 'north-america' },
      { id: 'wh-chicago', name: 'Chicago DC', type: 'warehouse', region: 'north-america' },
      { id: 'wh-rotterdam', name: 'Rotterdam DC', type: 'warehouse', region: 'europe' },
      { id: 'wh-singapore', name: 'Singapore DC', type: 'warehouse', region: 'asia-pacific' },
      // Distributors
      { id: 'dist-west', name: 'West Coast Dist.', type: 'distributor', region: 'north-america' },
      { id: 'dist-east', name: 'East Coast Dist.', type: 'distributor', region: 'north-america' },
      { id: 'dist-eu', name: 'EU Distribution', type: 'distributor', region: 'europe' },
      { id: 'dist-apac', name: 'APAC Distribution', type: 'distributor', region: 'asia-pacific' },
      // Retailers
      { id: 'ret-amazon', name: 'Amazon', type: 'retailer', region: 'all' },
      { id: 'ret-walmart', name: 'Walmart', type: 'retailer', region: 'north-america' },
      { id: 'ret-direct', name: 'Direct-to-Consumer', type: 'retailer', region: 'all' },
    ];

    const links = [
      { source: 'sup-shenzhen', target: 'wh-la', value: 4200, unit: 'pallets/month' },
      { source: 'sup-shenzhen', target: 'wh-singapore', value: 3100, unit: 'pallets/month' },
      { source: 'sup-taipei', target: 'wh-la', value: 2800, unit: 'pallets/month' },
      { source: 'sup-taipei', target: 'wh-singapore', value: 1500, unit: 'pallets/month' },
      { source: 'sup-munich', target: 'wh-rotterdam', value: 3400, unit: 'pallets/month' },
      { source: 'sup-munich', target: 'wh-chicago', value: 1200, unit: 'pallets/month' },
      { source: 'sup-detroit', target: 'wh-chicago', value: 5100, unit: 'pallets/month' },
      { source: 'sup-detroit', target: 'wh-la', value: 1800, unit: 'pallets/month' },
      { source: 'wh-la', target: 'dist-west', value: 7200, unit: 'pallets/month' },
      { source: 'wh-chicago', target: 'dist-east', value: 5800, unit: 'pallets/month' },
      { source: 'wh-rotterdam', target: 'dist-eu', value: 3400, unit: 'pallets/month' },
      { source: 'wh-singapore', target: 'dist-apac', value: 4100, unit: 'pallets/month' },
      { source: 'dist-west', target: 'ret-amazon', value: 3600, unit: 'pallets/month' },
      { source: 'dist-west', target: 'ret-walmart', value: 2100, unit: 'pallets/month' },
      { source: 'dist-west', target: 'ret-direct', value: 1500, unit: 'pallets/month' },
      { source: 'dist-east', target: 'ret-amazon', value: 2900, unit: 'pallets/month' },
      { source: 'dist-east', target: 'ret-walmart', value: 1800, unit: 'pallets/month' },
      { source: 'dist-east', target: 'ret-direct', value: 1100, unit: 'pallets/month' },
      { source: 'dist-eu', target: 'ret-amazon', value: 1700, unit: 'pallets/month' },
      { source: 'dist-eu', target: 'ret-direct', value: 1700, unit: 'pallets/month' },
      { source: 'dist-apac', target: 'ret-amazon', value: 2400, unit: 'pallets/month' },
      { source: 'dist-apac', target: 'ret-direct', value: 1700, unit: 'pallets/month' },
    ];

    const filteredNodes = input.region === 'all'
      ? nodes
      : nodes.filter((n) => n.region === input.region || n.region === 'all');
    const nodeIds = new Set(filteredNodes.map((n) => n.id));
    const filteredLinks = input.region === 'all'
      ? links
      : links.filter((l) => nodeIds.has(l.source) && nodeIds.has(l.target));

    return JSON.stringify({
      nodes: filteredNodes,
      links: filteredLinks,
      totalThroughput: filteredLinks.reduce((sum, l) => sum + l.value, 0),
      region: input.region,
      updatedAt: new Date().toISOString(),
    });
  },
});
