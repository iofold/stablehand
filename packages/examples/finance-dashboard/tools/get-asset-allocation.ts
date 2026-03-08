import { defineTool } from 'ctxmill';
import { z } from 'zod';

export default defineTool({
  name: 'get-asset-allocation',
  description: 'Get current portfolio asset allocation breakdown by category',
  input: z.object({}),
  handler: async (_input, _ctx) => {
    const allocation = [
      { asset: 'US Large Cap Equities', value: 52340.20, percentage: 41.7, color: '#2563eb' },
      { asset: 'US Mid Cap Equities', value: 15060.80, percentage: 12.0, color: '#7c3aed' },
      { asset: 'International Equities', value: 18890.50, percentage: 15.1, color: '#059669' },
      { asset: 'Fixed Income', value: 12540.30, percentage: 10.0, color: '#d97706' },
      { asset: 'Real Estate (REITs)', value: 6270.15, percentage: 5.0, color: '#dc2626' },
      { asset: 'Commodities', value: 3762.10, percentage: 3.0, color: '#0891b2' },
      { asset: 'Cryptocurrency', value: 1366.45, percentage: 1.1, color: '#f59e0b' },
      { asset: 'Cash & Equivalents', value: 15200.00, percentage: 12.1, color: '#6b7280' },
    ];

    return JSON.stringify({
      allocation,
      totalValue: 125430.50,
      lastRebalanced: '2026-02-15',
      nextRebalanceDate: '2026-05-15',
      riskScore: 6.4,
      riskLabel: 'Moderate Growth',
    });
  },
});
