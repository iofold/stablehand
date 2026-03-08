import { defineTool } from 'ctxmill';
import { z } from 'zod';

export default defineTool({
  name: 'generate-report',
  description: 'Generate a marketing performance report. Requires approval to confirm date range and report parameters.',
  requiresApproval: true,
  input: z.object({
    reportType: z.enum(['weekly', 'monthly', 'quarterly']).describe('Type of report to generate'),
    startDate: z.string().optional().describe('Report start date (ISO 8601)'),
    endDate: z.string().optional().describe('Report end date (ISO 8601)'),
  }),
  handler: async (input, _ctx) => {
    const periodLabel =
      input.reportType === 'weekly'
        ? 'Weekly'
        : input.reportType === 'monthly'
          ? 'Monthly'
          : 'Quarterly';

    const now = new Date();
    const start = input.startDate ?? new Date(now.getTime() - 30 * 86400000).toISOString().split('T')[0];
    const end = input.endDate ?? now.toISOString().split('T')[0];

    const content = `# Marketing ${periodLabel} Report

**Period:** ${start} to ${end}
**Generated:** ${now.toISOString().split('T')[0]}

## Executive Summary

Overall marketing performance showed positive trends across key metrics this period. Website traffic increased 5.3% period-over-period, with conversion rates improving from 5.8% to 6.0%.

## Key Metrics

| Metric | Current | Previous | Change |
|--------|---------|----------|--------|
| Website Visitors | 124,500 | 118,200 | +5.3% |
| Total Leads | 7,470 | 6,856 | +9.0% |
| MQLs | 3,060 | 2,742 | +11.6% |
| SQLs | 1,100 | 960 | +14.6% |
| New Customers | 110 | 90 | +22.2% |
| CAC (Blended) | $1,018 | $1,098 | -7.3% |
| ROAS (Blended) | 4.17 | 3.87 | +7.8% |

## Channel Performance

- **Paid Search:** $45K spend, 39 customers, $1,154 CAC, 3.68x ROAS
- **Social Media:** $32K spend, 20 customers, $1,600 CAC, 2.66x ROAS
- **Email Marketing:** $12K spend, 13 customers, $923 CAC, 4.60x ROAS
- **Content / SEO:** $8K spend, 31 customers, $258 CAC, 16.47x ROAS
- **Display Ads:** $15K spend, 7 customers, $2,143 CAC, 1.98x ROAS

## Recommendations

1. **Increase Content/SEO budget** - Highest ROAS (16.47x) with lowest CAC ($258)
2. **Optimize Display Ads** - Lowest ROAS (1.98x); consider reallocating $5K to content
3. **Scale Email campaigns** - Strong efficiency; test new nurture sequences
4. **A/B test Social creatives** - CAC trending high; refresh ad creative

## Next Steps

- [ ] Review and approve budget reallocation proposal
- [ ] Launch new email nurture sequence by next week
- [ ] Schedule creative refresh for social campaigns
`;

    return JSON.stringify({
      reportId: 'RPT-' + Date.now(),
      reportType: input.reportType,
      period: { start, end },
      format: 'markdown',
      editable: true,
      content,
      generatedAt: now.toISOString(),
    });
  },
});
