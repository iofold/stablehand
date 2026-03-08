import { describe, it, expect } from 'vitest';

describe('finance-analyst agent', () => {
  it('should export a valid agent definition', async () => {
    const { default: agent } = await import('../agents/assistant/agent');
    expect(agent).toBeDefined();
    expect(agent.name).toBe('finance-analyst');
    expect(agent.tools).toContain('get-portfolio');
    expect(agent.tools).toContain('execute-trade');
    expect(agent.tools).toHaveLength(9);
    expect(agent.systemPrompt).toContain('{{knowledge}}');
  });

  it('should have requiresApproval on execute-trade tool', async () => {
    const { default: tool } = await import('../tools/execute-trade');
    expect(tool).toBeDefined();
    expect(tool.name).toBe('execute-trade');
    expect(tool.requiresApproval).toBe(true);
  });

  it('get-portfolio should return valid portfolio data', async () => {
    const { default: tool } = await import('../tools/get-portfolio');
    const result = JSON.parse(await tool.handler({}, {} as any));
    expect(result.totalValue).toBeGreaterThan(0);
    expect(result.positions).toBeGreaterThan(0);
    expect(result.cashBalance).toBeGreaterThan(0);
    expect(result.updatedAt).toBeDefined();
  });

  it('get-stock-price should return OHLC data', async () => {
    const { default: tool } = await import('../tools/get-stock-price');
    const result = JSON.parse(await tool.handler({ symbol: 'AAPL', period: '1M' }, {} as any));
    expect(result.symbol).toBe('AAPL');
    expect(result.data.length).toBeGreaterThan(0);
    const candle = result.data[0];
    expect(candle).toHaveProperty('open');
    expect(candle).toHaveProperty('high');
    expect(candle).toHaveProperty('low');
    expect(candle).toHaveProperty('close');
    expect(candle).toHaveProperty('volume');
  });

  it('get-asset-allocation should return allocation data', async () => {
    const { default: tool } = await import('../tools/get-asset-allocation');
    const result = JSON.parse(await tool.handler({}, {} as any));
    expect(result.allocation.length).toBeGreaterThan(0);
    const totalPct = result.allocation.reduce((sum: number, a: any) => sum + a.percentage, 0);
    expect(totalPct).toBeCloseTo(100, 0);
  });

  it('get-positions should return sorted positions', async () => {
    const { default: tool } = await import('../tools/get-positions');
    const result = JSON.parse(await tool.handler({ sortBy: 'value' }, {} as any));
    expect(result.positions.length).toBe(12);
    expect(result.totalMarketValue).toBeGreaterThan(0);
    // Verify sorted by value descending
    for (let i = 1; i < result.positions.length; i++) {
      expect(result.positions[i - 1].totalValue).toBeGreaterThanOrEqual(result.positions[i].totalValue);
    }
  });

  it('read-file should read file contents', async () => {
    const { default: tool } = await import('../tools/read-file');
    expect(tool.name).toBe('read-file');
    const result = await tool.handler({ path: 'package.json' }, {} as any);
    expect(result).toContain('name');
  });

  it('read-file should block path traversal', async () => {
    const { default: tool } = await import('../tools/read-file');
    const result = await tool.handler({ path: '../../../../../../etc/passwd' }, {} as any);
    expect(result).toContain('Error');
  });

  it('list-directory should list entries', async () => {
    const { default: tool } = await import('../tools/list-directory');
    expect(tool.name).toBe('list-directory');
    const result = await tool.handler({ path: '.' }, {} as any);
    expect(result).toContain('tools');
  });

  it('list-directory should block path traversal', async () => {
    const { default: tool } = await import('../tools/list-directory');
    const result = await tool.handler({ path: '../../../../../../' }, {} as any);
    expect(result).toContain('Error');
  });

  it('search-files should find matches', async () => {
    const { default: tool } = await import('../tools/search-files');
    expect(tool.name).toBe('search-files');
    const result = await tool.handler({ pattern: 'defineTool', directory: 'tools', fileExtensions: ['.ts'] }, {} as any);
    expect(result).toContain('Found');
    expect(result).toContain('defineTool');
  });

  it('write-note should require approval', async () => {
    const { default: tool } = await import('../tools/write-note');
    expect(tool.name).toBe('write-note');
    expect(tool.requiresApproval).toBe(true);
  });

  it('execute-trade should return order confirmation', async () => {
    const { default: tool } = await import('../tools/execute-trade');
    const result = JSON.parse(
      await tool.handler(
        { action: 'buy', symbol: 'AAPL', shares: 10, orderType: 'market' },
        {} as any,
      ),
    );
    expect(result.orderId).toMatch(/^ORD-/);
    expect(result.status).toBe('executed');
    expect(result.shares).toBe(10);
    expect(result.totalCost).toBeGreaterThan(0);
  });
});
