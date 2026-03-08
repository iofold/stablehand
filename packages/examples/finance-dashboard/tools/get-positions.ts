import { defineTool } from 'ctxmill';
import { z } from 'zod';

const positions = [
  { symbol: 'AAPL', name: 'Apple Inc.', shares: 85, avgCost: 162.30, currentPrice: 178.52, sector: 'Technology' },
  { symbol: 'MSFT', name: 'Microsoft Corp.', shares: 40, avgCost: 380.15, currentPrice: 415.30, sector: 'Technology' },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', shares: 60, avgCost: 128.40, currentPrice: 141.80, sector: 'Technology' },
  { symbol: 'AMZN', name: 'Amazon.com Inc.', shares: 35, avgCost: 168.90, currentPrice: 185.60, sector: 'Consumer Discretionary' },
  { symbol: 'NVDA', name: 'NVIDIA Corp.', shares: 12, avgCost: 720.50, currentPrice: 875.40, sector: 'Technology' },
  { symbol: 'JPM', name: 'JPMorgan Chase & Co.', shares: 50, avgCost: 178.20, currentPrice: 198.40, sector: 'Financials' },
  { symbol: 'V', name: 'Visa Inc.', shares: 25, avgCost: 258.75, currentPrice: 280.15, sector: 'Financials' },
  { symbol: 'JNJ', name: 'Johnson & Johnson', shares: 30, avgCost: 148.60, currentPrice: 155.90, sector: 'Healthcare' },
  { symbol: 'UNH', name: 'UnitedHealth Group', shares: 8, avgCost: 490.30, currentPrice: 525.60, sector: 'Healthcare' },
  { symbol: 'WMT', name: 'Walmart Inc.', shares: 45, avgCost: 152.80, currentPrice: 168.35, sector: 'Consumer Staples' },
  { symbol: 'VNQ', name: 'Vanguard Real Estate ETF', shares: 70, avgCost: 82.40, currentPrice: 89.57, sector: 'Real Estate' },
  { symbol: 'BND', name: 'Vanguard Total Bond ETF', shares: 150, avgCost: 72.10, currentPrice: 73.60, sector: 'Fixed Income' },
];

export default defineTool({
  name: 'get-positions',
  description: 'Get detailed list of all portfolio positions',
  input: z.object({
    sortBy: z.enum(['value', 'name', 'change']).default('value').describe('Sort positions by field'),
  }),
  handler: async (input, _ctx) => {
    const enriched = positions.map((p) => {
      const totalValue = parseFloat((p.shares * p.currentPrice).toFixed(2));
      const totalCost = parseFloat((p.shares * p.avgCost).toFixed(2));
      const change = parseFloat((((p.currentPrice - p.avgCost) / p.avgCost) * 100).toFixed(2));
      const unrealizedPL = parseFloat((totalValue - totalCost).toFixed(2));
      return { ...p, totalValue, totalCost, change, unrealizedPL };
    });

    const sortFns: Record<string, (a: typeof enriched[0], b: typeof enriched[0]) => number> = {
      value: (a, b) => b.totalValue - a.totalValue,
      name: (a, b) => a.name.localeCompare(b.name),
      change: (a, b) => b.change - a.change,
    };

    enriched.sort(sortFns[input.sortBy] ?? sortFns.value);

    return JSON.stringify({
      positions: enriched,
      count: enriched.length,
      totalMarketValue: parseFloat(enriched.reduce((sum, p) => sum + p.totalValue, 0).toFixed(2)),
    });
  },
});
