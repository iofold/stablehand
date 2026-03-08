import { defineTool } from 'ctxmill';
import { z } from 'zod';

export default defineTool({
  name: 'get-portfolio',
  description: 'Get current portfolio summary including total value and daily change',
  input: z.object({}),
  handler: async (_input, _ctx) => {
    // Simulated portfolio data
    return JSON.stringify({
      totalValue: 125430.50,
      dailyChange: 2847.30,
      dailyChangePercent: 2.32,
      positions: 12,
      cashBalance: 15200.00,
      buyingPower: 30400.00,
      realizedPL: 8340.12,
      unrealizedPL: 14290.75,
      marginUsed: 0,
      updatedAt: new Date().toISOString(),
    });
  },
});
