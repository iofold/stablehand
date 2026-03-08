import { defineTool } from 'ctxmill';
import { z } from 'zod';

export default defineTool({
  name: 'get-conversion-funnel',
  description: 'Get the marketing conversion funnel from website visitors through to paying customers',
  input: z.object({
    period: z.enum(['this-week', 'this-month', 'last-month', 'this-quarter']).default('this-month').describe('Time period for funnel data'),
    channel: z.string().optional().describe('Filter by acquisition channel (e.g., "paid-search", "organic", "social")'),
  }),
  handler: async (input, _ctx) => {
    const funnelByPeriod: Record<string, Array<{ stage: string; count: number; conversionRate: number }>> = {
      'this-week': [
        { stage: 'Website Visitors', count: 28400, conversionRate: 100 },
        { stage: 'Leads (Form Fills)', count: 1704, conversionRate: 6.0 },
        { stage: 'Marketing Qualified (MQL)', count: 682, conversionRate: 40.0 },
        { stage: 'Sales Qualified (SQL)', count: 245, conversionRate: 35.9 },
        { stage: 'Opportunities', count: 98, conversionRate: 40.0 },
        { stage: 'Closed Won', count: 24, conversionRate: 24.5 },
      ],
      'this-month': [
        { stage: 'Website Visitors', count: 124500, conversionRate: 100 },
        { stage: 'Leads (Form Fills)', count: 7470, conversionRate: 6.0 },
        { stage: 'Marketing Qualified (MQL)', count: 3060, conversionRate: 41.0 },
        { stage: 'Sales Qualified (SQL)', count: 1100, conversionRate: 35.9 },
        { stage: 'Opportunities', count: 440, conversionRate: 40.0 },
        { stage: 'Closed Won', count: 110, conversionRate: 25.0 },
      ],
      'last-month': [
        { stage: 'Website Visitors', count: 118200, conversionRate: 100 },
        { stage: 'Leads (Form Fills)', count: 6856, conversionRate: 5.8 },
        { stage: 'Marketing Qualified (MQL)', count: 2742, conversionRate: 40.0 },
        { stage: 'Sales Qualified (SQL)', count: 960, conversionRate: 35.0 },
        { stage: 'Opportunities', count: 374, conversionRate: 39.0 },
        { stage: 'Closed Won', count: 90, conversionRate: 24.1 },
      ],
      'this-quarter': [
        { stage: 'Website Visitors', count: 362100, conversionRate: 100 },
        { stage: 'Leads (Form Fills)', count: 21726, conversionRate: 6.0 },
        { stage: 'Marketing Qualified (MQL)', count: 8690, conversionRate: 40.0 },
        { stage: 'Sales Qualified (SQL)', count: 3128, conversionRate: 36.0 },
        { stage: 'Opportunities', count: 1251, conversionRate: 40.0 },
        { stage: 'Closed Won', count: 313, conversionRate: 25.0 },
      ],
    };

    const channelMultipliers: Record<string, number> = {
      'paid-search': 0.35,
      'organic': 0.28,
      'social': 0.18,
      'email': 0.12,
      'referral': 0.07,
    };

    let stages = funnelByPeriod[input.period];

    if (input.channel && channelMultipliers[input.channel]) {
      const mult = channelMultipliers[input.channel];
      stages = stages.map((s) => ({
        ...s,
        count: Math.round(s.count * mult),
      }));
    }

    const visitors = stages[0].count;
    const customers = stages[stages.length - 1].count;

    return JSON.stringify({
      period: input.period,
      channel: input.channel ?? 'all',
      stages,
      overallConversionRate: parseFloat(((customers / visitors) * 100).toFixed(3)),
      totalLeads: stages[1].count,
      totalCustomers: customers,
      avgDealSize: 4250,
      projectedRevenue: customers * 4250,
    });
  },
});
