import { defineTool } from 'ctxmill';
import { z } from 'zod';

export default defineTool({
  name: 'get-campaign-metrics',
  description: 'Get time-series campaign performance metrics for a given period',
  input: z.object({
    period: z.enum(['7d', '30d', '90d']).default('30d').describe('Lookback period for metrics'),
    channel: z.string().optional().describe('Filter by channel (e.g., "paid-search", "social", "email")'),
  }),
  handler: async (input, _ctx) => {
    const days = input.period === '7d' ? 7 : input.period === '30d' ? 30 : 90;
    const now = new Date();
    const data: Array<{
      date: string;
      impressions: number;
      clicks: number;
      conversions: number;
      spend: number;
      revenue: number;
    }> = [];

    const channelMultiplier: Record<string, number> = {
      'paid-search': 0.40,
      'social': 0.25,
      'email': 0.15,
      'content': 0.12,
      'display': 0.08,
    };

    const mult = input.channel && channelMultiplier[input.channel]
      ? channelMultiplier[input.channel]
      : 1;

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);

      const dayOfWeek = date.getDay();
      const weekendFactor = dayOfWeek === 0 || dayOfWeek === 6 ? 0.65 : 1.0;
      const trendFactor = 1 + (days - i) * 0.002;
      const noise = 0.85 + Math.sin(i * 0.7) * 0.15;

      const baseImpressions = 42000 * weekendFactor * trendFactor * noise * mult;
      const baseCTR = 0.032 + Math.sin(i * 0.3) * 0.005;
      const baseConvRate = 0.028 + Math.sin(i * 0.5) * 0.004;
      const baseCPC = 2.45 + Math.sin(i * 0.4) * 0.30;

      const impressions = Math.round(baseImpressions);
      const clicks = Math.round(impressions * baseCTR);
      const conversions = Math.round(clicks * baseConvRate);
      const spend = parseFloat((clicks * baseCPC).toFixed(2));
      const revenue = parseFloat((conversions * 4250 * 0.08).toFixed(2));

      data.push({
        date: date.toISOString().split('T')[0],
        impressions,
        clicks,
        conversions,
        spend,
        revenue,
      });
    }

    const totalImpressions = data.reduce((s, d) => s + d.impressions, 0);
    const totalClicks = data.reduce((s, d) => s + d.clicks, 0);
    const totalConversions = data.reduce((s, d) => s + d.conversions, 0);
    const totalSpend = data.reduce((s, d) => s + d.spend, 0);
    const totalRevenue = data.reduce((s, d) => s + d.revenue, 0);

    return JSON.stringify({
      period: input.period,
      channel: input.channel ?? 'all',
      data,
      summary: {
        totalImpressions,
        totalClicks,
        totalConversions,
        totalSpend: parseFloat(totalSpend.toFixed(2)),
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        avgCTR: parseFloat(((totalClicks / totalImpressions) * 100).toFixed(2)),
        avgConversionRate: parseFloat(((totalConversions / totalClicks) * 100).toFixed(2)),
        avgCPC: parseFloat((totalSpend / totalClicks).toFixed(2)),
        roas: parseFloat((totalRevenue / totalSpend).toFixed(2)),
      },
    });
  },
});
