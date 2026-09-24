import { defineTool } from 'stablehand';
import { z } from 'zod';

export default defineTool({
  name: 'execute-trade',
  description: 'Execute a stock trade (buy or sell). Requires user approval before execution.',
  requiresApproval: true,
  input: z.object({
    action: z.enum(['buy', 'sell']).describe('Whether to buy or sell'),
    symbol: z.string().describe('Stock ticker symbol'),
    quantity: z.number().positive().describe('Number of shares to trade'),
    order_type: z.enum(['market', 'limit']).default('market').describe('Order type'),
    price: z.number().optional().describe('Limit price (required for limit orders)'),
  }),
  handler: async (rawInput, _ctx) => {
    const input = rawInput as {
      action: 'buy' | 'sell';
      symbol: string;
      quantity: number;
      order_type: 'market' | 'limit';
      price?: number;
    };
    // Simulated execution prices with slight spread
    const basePrices: Record<string, number> = {
      AAPL: 178.52, MSFT: 415.30, GOOGL: 141.80, AMZN: 185.60,
      NVDA: 875.40, META: 505.75, TSLA: 245.20, JPM: 198.40,
    };

    const basePrice = basePrices[input.symbol.toUpperCase()] ?? 100 + Math.random() * 200;
    const spread = basePrice * 0.001;
    const executedPrice = input.order_type === 'limit' && input.price
      ? input.price
      : input.action === 'buy'
        ? parseFloat((basePrice + spread).toFixed(2))
        : parseFloat((basePrice - spread).toFixed(2));

    const totalCost = parseFloat((input.quantity * executedPrice).toFixed(2));
    const commission = parseFloat((Math.max(0.99, totalCost * 0.0001)).toFixed(2));

    return JSON.stringify({
      orderId: 'ORD-' + Date.now(),
      status: 'executed',
      action: input.action,
      symbol: input.symbol.toUpperCase(),
      shares: input.quantity,
      orderType: input.order_type,
      executedPrice,
      totalCost,
      commission,
      netAmount: parseFloat((totalCost + (input.action === 'buy' ? commission : -commission)).toFixed(2)),
      timestamp: new Date().toISOString(),
    });
  },
});
