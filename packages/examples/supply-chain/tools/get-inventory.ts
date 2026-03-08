import { defineTool } from 'ctxmill';
import { z } from 'zod';

export default defineTool({
  name: 'get-inventory',
  description: 'Get current inventory levels across all warehouses with stock status indicators',
  input: z.object({
    warehouse: z.string().optional().describe('Filter by warehouse ID (e.g., wh-la). Omit for all warehouses.'),
    lowStockOnly: z.boolean().default(false).describe('Show only items below reorder point'),
  }),
  handler: async (input, _ctx) => {
    const inventory = [
      { sku: 'ELC-001', name: 'Circuit Board Assembly A', warehouse: 'wh-la', onHand: 12400, reorderPoint: 5000, inTransit: 3200, dailyDemand: 420, unitCost: 24.50 },
      { sku: 'ELC-002', name: 'Power Supply Unit 500W', warehouse: 'wh-la', onHand: 3200, reorderPoint: 4000, inTransit: 6000, dailyDemand: 310, unitCost: 45.80 },
      { sku: 'ELC-003', name: 'LED Display Module 15"', warehouse: 'wh-la', onHand: 8900, reorderPoint: 3000, inTransit: 0, dailyDemand: 185, unitCost: 78.20 },
      { sku: 'MEC-010', name: 'Aluminum Chassis Frame', warehouse: 'wh-chicago', onHand: 6700, reorderPoint: 4500, inTransit: 2000, dailyDemand: 340, unitCost: 32.10 },
      { sku: 'MEC-011', name: 'Cooling Fan Assembly', warehouse: 'wh-chicago', onHand: 1800, reorderPoint: 3000, inTransit: 5000, dailyDemand: 275, unitCost: 12.40 },
      { sku: 'MEC-012', name: 'Mounting Bracket Kit', warehouse: 'wh-chicago', onHand: 15200, reorderPoint: 5000, inTransit: 0, dailyDemand: 450, unitCost: 8.90 },
      { sku: 'ELC-001', name: 'Circuit Board Assembly A', warehouse: 'wh-rotterdam', onHand: 4200, reorderPoint: 3000, inTransit: 4500, dailyDemand: 210, unitCost: 26.30 },
      { sku: 'ELC-004', name: 'Sensor Array Module', warehouse: 'wh-rotterdam', onHand: 950, reorderPoint: 2000, inTransit: 3000, dailyDemand: 165, unitCost: 56.70 },
      { sku: 'PKG-020', name: 'Packaging Box Large', warehouse: 'wh-rotterdam', onHand: 22000, reorderPoint: 8000, inTransit: 0, dailyDemand: 620, unitCost: 2.80 },
      { sku: 'ELC-001', name: 'Circuit Board Assembly A', warehouse: 'wh-singapore', onHand: 7800, reorderPoint: 4000, inTransit: 2100, dailyDemand: 350, unitCost: 23.90 },
      { sku: 'ELC-005', name: 'Wireless Module BT5.0', warehouse: 'wh-singapore', onHand: 2100, reorderPoint: 2500, inTransit: 4000, dailyDemand: 195, unitCost: 18.50 },
      { sku: 'MEC-013', name: 'Rubber Gasket Set', warehouse: 'wh-singapore', onHand: 34000, reorderPoint: 10000, inTransit: 0, dailyDemand: 800, unitCost: 1.20 },
    ];

    let filtered = inventory;
    if (input.warehouse) {
      filtered = filtered.filter((item) => item.warehouse === input.warehouse);
    }

    const enriched = filtered.map((item) => {
      const daysOfStock = Math.floor(item.onHand / item.dailyDemand);
      const status = item.onHand < item.reorderPoint
        ? 'LOW'
        : item.onHand < item.reorderPoint * 1.5
          ? 'WATCH'
          : 'OK';
      const totalValue = parseFloat((item.onHand * item.unitCost).toFixed(2));
      return { ...item, daysOfStock, status, totalValue };
    });

    if (input.lowStockOnly) {
      return JSON.stringify({
        items: enriched.filter((i) => i.status === 'LOW'),
        alertCount: enriched.filter((i) => i.status === 'LOW').length,
        totalItems: enriched.length,
      });
    }

    return JSON.stringify({
      items: enriched,
      summary: {
        totalItems: enriched.length,
        lowStock: enriched.filter((i) => i.status === 'LOW').length,
        watchList: enriched.filter((i) => i.status === 'WATCH').length,
        healthy: enriched.filter((i) => i.status === 'OK').length,
        totalInventoryValue: parseFloat(enriched.reduce((sum, i) => sum + i.totalValue, 0).toFixed(2)),
      },
    });
  },
});
