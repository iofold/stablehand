import { describe, it, expect } from 'vitest';

describe('marketing-analyst agent', () => {
  it('should export a valid agent definition', async () => {
    const { default: agent } = await import('../agents/assistant/agent');
    expect(agent).toBeDefined();
    expect(agent.name).toBe('marketing-analyst');
    expect(agent.tools).toContain('get-conversion-funnel');
    expect(agent.tools).toContain('get-channel-spend');
    expect(agent.tools).toContain('get-campaign-metrics');
    expect(agent.tools).toContain('generate-report');
    expect(agent.tools).toHaveLength(4);
    expect(agent.systemPrompt).toContain('{{knowledge}}');
  });

  it('should have requiresApproval on generate-report tool', async () => {
    const { default: tool } = await import('../tools/generate-report');
    expect(tool).toBeDefined();
    expect(tool.name).toBe('generate-report');
    expect(tool.requiresApproval).toBe(true);
  });

  it('get-conversion-funnel should return descending funnel stages', async () => {
    const { default: tool } = await import('../tools/get-conversion-funnel');
    const result = JSON.parse(await tool.handler({ period: 'this-month' }, {} as any));
    expect(result.stages.length).toBe(6);
    expect(result.overallConversionRate).toBeGreaterThan(0);
    expect(result.totalCustomers).toBeGreaterThan(0);
    // Funnel should be descending
    for (let i = 1; i < result.stages.length; i++) {
      expect(result.stages[i - 1].count).toBeGreaterThanOrEqual(result.stages[i].count);
    }
  });

  it('get-conversion-funnel should filter by channel', async () => {
    const { default: tool } = await import('../tools/get-conversion-funnel');
    const all = JSON.parse(await tool.handler({ period: 'this-month' }, {} as any));
    const paidSearch = JSON.parse(
      await tool.handler({ period: 'this-month', channel: 'paid-search' }, {} as any),
    );
    expect(paidSearch.stages[0].count).toBeLessThan(all.stages[0].count);
    expect(paidSearch.channel).toBe('paid-search');
  });

  it('get-channel-spend should return spend data with totals', async () => {
    const { default: tool } = await import('../tools/get-channel-spend');
    const result = JSON.parse(await tool.handler({ period: 'this-month' }, {} as any));
    expect(result.channels.length).toBe(5);
    expect(result.totalSpend).toBeGreaterThan(0);
    expect(result.totalCustomers).toBeGreaterThan(0);
    expect(result.blendedCAC).toBeGreaterThan(0);
    expect(result.blendedROAS).toBeGreaterThan(0);
    // Each channel should have a spend share
    const totalShare = result.channels.reduce((sum: number, c: any) => sum + c.spendShare, 0);
    expect(totalShare).toBeCloseTo(100, 0);
  });

  it('get-campaign-metrics should return time series data', async () => {
    const { default: tool } = await import('../tools/get-campaign-metrics');
    const result = JSON.parse(await tool.handler({ period: '7d' }, {} as any));
    expect(result.data.length).toBe(7);
    expect(result.summary.totalImpressions).toBeGreaterThan(0);
    expect(result.summary.totalClicks).toBeGreaterThan(0);
    expect(result.summary.avgCTR).toBeGreaterThan(0);
    expect(result.summary.roas).toBeGreaterThan(0);
    // Each data point should have required fields
    const point = result.data[0];
    expect(point).toHaveProperty('date');
    expect(point).toHaveProperty('impressions');
    expect(point).toHaveProperty('clicks');
    expect(point).toHaveProperty('conversions');
    expect(point).toHaveProperty('spend');
    expect(point).toHaveProperty('revenue');
  });

  it('get-campaign-metrics 30d should return 30 data points', async () => {
    const { default: tool } = await import('../tools/get-campaign-metrics');
    const result = JSON.parse(await tool.handler({ period: '30d' }, {} as any));
    expect(result.data.length).toBe(30);
  });

  it('generate-report should return editable markdown report', async () => {
    const { default: tool } = await import('../tools/generate-report');
    const result = JSON.parse(await tool.handler({ reportType: 'monthly' }, {} as any));
    expect(result.reportId).toMatch(/^RPT-/);
    expect(result.format).toBe('markdown');
    expect(result.editable).toBe(true);
    expect(result.content).toContain('# Marketing Monthly Report');
    expect(result.content).toContain('Executive Summary');
    expect(result.content).toContain('Channel Performance');
  });
});
