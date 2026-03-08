import { defineTool } from 'ctxmill';
import { z } from 'zod';

export default defineTool({
  name: 'get-order-funnel',
  description: 'Get the order fulfillment funnel showing progression from order placed to delivery',
  input: z.object({
    period: z.enum(['today', 'this-week', 'this-month', 'last-month']).default('this-month').describe('Time period for funnel data'),
  }),
  handler: async (input, _ctx) => {
    const funnelData: Record<string, Array<{ stage: string; count: number; avgTime: string }>> = {
      'today': [
        { stage: 'Orders Placed', count: 342, avgTime: '0h' },
        { stage: 'Payment Confirmed', count: 338, avgTime: '0.2h' },
        { stage: 'Picked & Packed', count: 285, avgTime: '2.1h' },
        { stage: 'Shipped', count: 198, avgTime: '4.5h' },
        { stage: 'In Transit', count: 156, avgTime: '8.3h' },
        { stage: 'Delivered', count: 42, avgTime: '18.7h' },
      ],
      'this-week': [
        { stage: 'Orders Placed', count: 2450, avgTime: '0h' },
        { stage: 'Payment Confirmed', count: 2418, avgTime: '0.3h' },
        { stage: 'Picked & Packed', count: 2340, avgTime: '3.2h' },
        { stage: 'Shipped', count: 2210, avgTime: '6.8h' },
        { stage: 'In Transit', count: 1890, avgTime: '24.5h' },
        { stage: 'Delivered', count: 1654, avgTime: '52.3h' },
      ],
      'this-month': [
        { stage: 'Orders Placed', count: 12840, avgTime: '0h' },
        { stage: 'Payment Confirmed', count: 12650, avgTime: '0.2h' },
        { stage: 'Picked & Packed', count: 12380, avgTime: '2.8h' },
        { stage: 'Shipped', count: 11950, avgTime: '5.4h' },
        { stage: 'In Transit', count: 10200, avgTime: '28.6h' },
        { stage: 'Delivered', count: 9870, avgTime: '56.2h' },
      ],
      'last-month': [
        { stage: 'Orders Placed', count: 11620, avgTime: '0h' },
        { stage: 'Payment Confirmed', count: 11480, avgTime: '0.3h' },
        { stage: 'Picked & Packed', count: 11200, avgTime: '3.1h' },
        { stage: 'Shipped', count: 10850, avgTime: '6.2h' },
        { stage: 'In Transit', count: 10100, avgTime: '32.1h' },
        { stage: 'Delivered', count: 9540, avgTime: '61.8h' },
      ],
    };

    const data = funnelData[input.period];
    const ordered = data[0].count;
    const delivered = data[data.length - 1].count;

    return JSON.stringify({
      period: input.period,
      stages: data,
      fulfillmentRate: parseFloat(((delivered / ordered) * 100).toFixed(1)),
      dropOffRate: parseFloat((((ordered - delivered) / ordered) * 100).toFixed(1)),
      avgOrderToDelivery: data[data.length - 1].avgTime,
    });
  },
});
