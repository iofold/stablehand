import { defineTool } from 'ctxmill';
import { z } from 'zod';

export default defineTool({
  name: 'draft-report',
  description: 'Generate a supply chain summary report in markdown format for user review and editing',
  input: z.object({
    reportType: z.enum(['weekly', 'monthly', 'quarterly']).default('weekly').describe('Report period type'),
    focusAreas: z.array(z.string()).optional().describe('Specific areas to highlight (e.g., ["inventory", "shipping"])'),
  }),
  handler: async (input, _ctx) => {
    const now = new Date();
    const reportDate = now.toISOString().split('T')[0];

    const report = `# Supply Chain ${input.reportType.charAt(0).toUpperCase() + input.reportType.slice(1)} Report
**Generated:** ${reportDate}
**Period:** ${input.reportType === 'weekly' ? 'Week of ' + reportDate : input.reportType === 'monthly' ? now.toLocaleString('en-US', { month: 'long', year: 'numeric' }) : `Q${Math.ceil((now.getMonth() + 1) / 3)} ${now.getFullYear()}`}

## Executive Summary

Overall supply chain performance remains strong with a **94.2% on-time delivery rate** (up 1.5% from prior period). Throughput across all distribution centers totaled **20,500 pallets**, a 3.2% increase month-over-month.

### Key Metrics
| Metric | Current | Prior Period | Change |
|--------|---------|-------------|--------|
| On-Time Delivery | 94.2% | 92.7% | +1.5% |
| Order Fulfillment Rate | 96.8% | 95.1% | +1.7% |
| Avg Lead Time | 56.2 hrs | 61.8 hrs | -9.1% |
| Inventory Turnover | 8.4x | 7.9x | +6.3% |
| Fill Rate | 97.3% | 96.8% | +0.5% |

## Inventory Highlights

- **3 SKUs below reorder point** requiring immediate attention:
  - ELC-002 (Power Supply Unit 500W) at Los Angeles DC — 3,200 units (reorder: 4,000)
  - MEC-011 (Cooling Fan Assembly) at Chicago DC — 1,800 units (reorder: 3,000)
  - ELC-004 (Sensor Array Module) at Rotterdam DC — 950 units (reorder: 2,000)
- In-transit inventory covers projected shortfalls for ELC-002 and MEC-011
- ELC-004 requires expedited reorder from Munich Precision supplier

## Logistics Performance

- **Los Angeles DC:** Processing 8,800 pallets/month, utilization at 82%
- **Chicago DC:** Processing 6,300 pallets/month, utilization at 71%
- **Rotterdam DC:** Processing 3,400 pallets/month, utilization at 65%
- **Singapore DC:** Processing 4,600 pallets/month, utilization at 74%

## Risk Factors

1. **Port congestion** at Long Beach causing 2-day delays on Asia-Pacific inbound shipments
2. **Carrier capacity** constraints expected during upcoming holiday season
3. **Component shortage** risk for Sensor Array Modules (ELC-004) — single-source supplier

## Recommendations

1. Place expedited reorder for ELC-004 with 20% buffer above standard order quantity
2. Negotiate secondary supplier agreement for Sensor Array Modules to reduce single-source risk
3. Pre-book carrier capacity for Q4 holiday surge (recommend 15% above Q3 levels)
4. Consider route optimization through Dallas hub to reduce transit times for East Coast distribution

---
*This report was auto-generated and should be reviewed before distribution.*`;

    return JSON.stringify({
      format: 'markdown',
      content: report,
      reportType: input.reportType,
      generatedAt: now.toISOString(),
      editable: true,
    });
  },
});
