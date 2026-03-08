import { defineTool } from 'ctxmill';
import { z } from 'zod';

function generateOHLC(symbol: string, period: string) {
  const basePrices: Record<string, number> = {
    AAPL: 178.52, MSFT: 415.30, GOOGL: 141.80, AMZN: 185.60,
    NVDA: 875.40, META: 505.75, TSLA: 245.20, JPM: 198.40,
    V: 280.15, JNJ: 155.90, UNH: 525.60, WMT: 168.35,
  };

  const base = basePrices[symbol.toUpperCase()] ?? 100 + Math.random() * 200;

  const periodDays: Record<string, number> = {
    '1D': 1, '1W': 7, '1M': 30, '3M': 90, '1Y': 252,
  };
  const days = periodDays[period] ?? 30;

  const data = [];
  let price = base * (0.85 + Math.random() * 0.15);
  const now = new Date();

  for (let i = days; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);

    // Skip weekends
    if (date.getDay() === 0 || date.getDay() === 6) continue;

    const volatility = 0.02 + Math.random() * 0.03;
    const drift = (Math.random() - 0.48) * volatility;
    const open = price;
    const close = price * (1 + drift);
    const high = Math.max(open, close) * (1 + Math.random() * volatility * 0.5);
    const low = Math.min(open, close) * (1 - Math.random() * volatility * 0.5);
    const volume = Math.floor(5_000_000 + Math.random() * 30_000_000);

    data.push({
      date: date.toISOString().split('T')[0],
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume,
    });

    price = close;
  }

  return {
    symbol: symbol.toUpperCase(),
    period,
    currentPrice: parseFloat(price.toFixed(2)),
    previousClose: data.length > 1 ? data[data.length - 2].close : base,
    data,
  };
}

export default defineTool({
  name: 'get-stock-price',
  description: 'Get OHLC candlestick price data for a given stock symbol',
  input: z.object({
    symbol: z.string().describe('Stock ticker symbol (e.g., AAPL, MSFT)'),
    period: z.enum(['1D', '1W', '1M', '3M', '1Y']).default('1M').describe('Time period for price history'),
  }),
  handler: async (input, _ctx) => {
    const result = generateOHLC(input.symbol, input.period);
    return JSON.stringify(result);
  },
});
