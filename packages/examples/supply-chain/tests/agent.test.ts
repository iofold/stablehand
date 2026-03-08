import { describe, it, expect } from 'vitest';

describe('supply-chain-optimizer agent', () => {
  it('should export a valid agent definition', async () => {
    const { default: agent } = await import('../agents/assistant/agent');
    expect(agent).toBeDefined();
    expect(agent.name).toBe('supply-chain-optimizer');
    expect(agent.tools).toContain('get-supply-chain-flow');
    expect(agent.tools).toContain('optimize-route');
    expect(agent.tools).toHaveLength(5);
    expect(agent.systemPrompt).toContain('{{knowledge}}');
  });

  it('should have requiresApproval on optimize-route tool', async () => {
    const { default: tool } = await import('../tools/optimize-route');
    expect(tool).toBeDefined();
    expect(tool.name).toBe('optimize-route');
    expect(tool.requiresApproval).toBe(true);
  });

  it('get-supply-chain-flow should return nodes and links', async () => {
    const { default: tool } = await import('../tools/get-supply-chain-flow');
    const result = JSON.parse(await tool.handler({ region: 'all' }, {} as any));
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.links.length).toBeGreaterThan(0);
    expect(result.totalThroughput).toBeGreaterThan(0);
    // Verify node types exist
    const types = new Set(result.nodes.map((n: any) => n.type));
    expect(types).toContain('supplier');
    expect(types).toContain('warehouse');
    expect(types).toContain('distributor');
    expect(types).toContain('retailer');
  });

  it('get-supply-chain-flow should filter by region', async () => {
    const { default: tool } = await import('../tools/get-supply-chain-flow');
    const all = JSON.parse(await tool.handler({ region: 'all' }, {} as any));
    const na = JSON.parse(await tool.handler({ region: 'north-america' }, {} as any));
    expect(na.nodes.length).toBeLessThan(all.nodes.length);
  });

  it('get-order-funnel should return descending funnel stages', async () => {
    const { default: tool } = await import('../tools/get-order-funnel');
    const result = JSON.parse(await tool.handler({ period: 'this-month' }, {} as any));
    expect(result.stages.length).toBe(6);
    expect(result.fulfillmentRate).toBeGreaterThan(0);
    // Funnel should be descending
    for (let i = 1; i < result.stages.length; i++) {
      expect(result.stages[i - 1].count).toBeGreaterThanOrEqual(result.stages[i].count);
    }
  });

  it('get-inventory should return items with stock status', async () => {
    const { default: tool } = await import('../tools/get-inventory');
    const result = JSON.parse(await tool.handler({ lowStockOnly: false }, {} as any));
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.summary.totalItems).toBe(result.items.length);
    // Every item should have a status
    result.items.forEach((item: any) => {
      expect(['OK', 'WATCH', 'LOW']).toContain(item.status);
      expect(item.daysOfStock).toBeGreaterThanOrEqual(0);
    });
  });

  it('get-inventory lowStockOnly should filter correctly', async () => {
    const { default: tool } = await import('../tools/get-inventory');
    const result = JSON.parse(await tool.handler({ lowStockOnly: true }, {} as any));
    expect(result.alertCount).toBeGreaterThan(0);
    result.items.forEach((item: any) => {
      expect(item.status).toBe('LOW');
    });
  });

  it('draft-report should return editable markdown', async () => {
    const { default: tool } = await import('../tools/draft-report');
    const result = JSON.parse(await tool.handler({ reportType: 'weekly' }, {} as any));
    expect(result.format).toBe('markdown');
    expect(result.editable).toBe(true);
    expect(result.content).toContain('# Supply Chain Weekly Report');
    expect(result.content).toContain('Executive Summary');
  });

  it('optimize-route should return current and optimized routes', async () => {
    const { default: tool } = await import('../tools/optimize-route');
    const result = JSON.parse(
      await tool.handler(
        { origin: 'wh-la', destination: 'dist-east', priority: 'balanced', shipmentSize: 100 },
        {} as any,
      ),
    );
    expect(result.optimizationId).toMatch(/^OPT-/);
    expect(result.status).toBe('proposed');
    expect(result.savings.costSavings).toBeGreaterThan(0);
    expect(result.optimizedRoute.totalCost).toBeLessThan(result.currentRoute.totalCost);
  });
});
