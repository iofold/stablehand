import { defineTool } from 'ctxmill';
import { z } from 'zod';

export default defineTool({
  name: 'get-channel-spend',
  description: 'Get marketing spend breakdown by acquisition channel for a given period',
  input: z.object({
    period: z.enum(['this-month', 'last-month', 'this-quarter', 'last-quarter']).default('this-month').describe('Time period for spend data'),
  }),
  handler: async (input, _ctx) => {
    const spendByPeriod: Record<string, Array<{ channel: string; spend: number; leads: number; customers: number; cac: number; roas: number }>> = {
      'this-month': [
        { channel: 'Paid Search', spend: 45000, leads: 2620, customers: 39, cac: 1154, roas: 3.68 },
        { channel: 'Social Media', spend: 32000, leads: 1344, customers: 20, cac: 1600, roas: 2.66 },
        { channel: 'Email Marketing', spend: 12000, leads: 896, customers: 13, cac: 923, roas: 4.60 },
        { channel: 'Content / SEO', spend: 8000, leads: 2094, customers: 31, cac: 258, roas: 16.47 },
        { channel: 'Display Ads', spend: 15000, leads: 516, customers: 7, cac: 2143, roas: 1.98 },
      ],
      'last-month': [
        { channel: 'Paid Search', spend: 42000, leads: 2400, customers: 34, cac: 1235, roas: 3.44 },
        { channel: 'Social Media', spend: 28000, leads: 1100, customers: 16, cac: 1750, roas: 2.43 },
        { channel: 'Email Marketing', spend: 11000, leads: 780, customers: 11, cac: 1000, roas: 4.25 },
        { channel: 'Content / SEO', spend: 7500, leads: 1900, customers: 28, cac: 268, roas: 15.87 },
        { channel: 'Display Ads', spend: 14000, leads: 476, customers: 6, cac: 2333, roas: 1.82 },
      ],
      'this-quarter': [
        { channel: 'Paid Search', spend: 132000, leads: 7600, customers: 108, cac: 1222, roas: 3.48 },
        { channel: 'Social Media', spend: 92000, leads: 3800, customers: 56, cac: 1643, roas: 2.59 },
        { channel: 'Email Marketing', spend: 35000, leads: 2500, customers: 37, cac: 946, roas: 4.49 },
        { channel: 'Content / SEO', spend: 23000, leads: 5900, customers: 88, cac: 261, roas: 16.26 },
        { channel: 'Display Ads', spend: 43000, leads: 1480, customers: 20, cac: 2150, roas: 1.98 },
      ],
      'last-quarter': [
        { channel: 'Paid Search', spend: 120000, leads: 6800, customers: 92, cac: 1304, roas: 3.26 },
        { channel: 'Social Media', spend: 80000, leads: 3200, customers: 44, cac: 1818, roas: 2.34 },
        { channel: 'Email Marketing', spend: 30000, leads: 2100, customers: 30, cac: 1000, roas: 4.25 },
        { channel: 'Content / SEO', spend: 20000, leads: 5200, customers: 76, cac: 263, roas: 16.15 },
        { channel: 'Display Ads', spend: 38000, leads: 1300, customers: 16, cac: 2375, roas: 1.79 },
      ],
    };

    const channels = spendByPeriod[input.period];
    const totalSpend = channels.reduce((sum, c) => sum + c.spend, 0);
    const totalCustomers = channels.reduce((sum, c) => sum + c.customers, 0);
    const totalLeads = channels.reduce((sum, c) => sum + c.leads, 0);

    return JSON.stringify({
      period: input.period,
      channels: channels.map((c) => ({
        ...c,
        spendShare: parseFloat(((c.spend / totalSpend) * 100).toFixed(1)),
      })),
      totalSpend,
      totalLeads,
      totalCustomers,
      blendedCAC: parseFloat((totalSpend / totalCustomers).toFixed(2)),
      blendedROAS: parseFloat(((totalCustomers * 4250) / totalSpend).toFixed(2)),
    });
  },
});
