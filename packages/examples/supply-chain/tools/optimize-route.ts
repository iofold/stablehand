import { defineTool } from 'ctxmill';
import { z } from 'zod';

export default defineTool({
  name: 'optimize-route',
  description: 'Propose an optimized shipping route. Requires user approval before implementation.',
  requiresApproval: true,
  input: z.object({
    origin: z.string().describe('Origin warehouse or supplier ID'),
    destination: z.string().describe('Destination distributor or retailer ID'),
    priority: z.enum(['cost', 'speed', 'balanced']).default('balanced').describe('Optimization priority'),
    shipmentSize: z.number().positive().describe('Number of pallets to ship'),
  }),
  handler: async (input, _ctx) => {
    const hubs: Record<string, { name: string; lat: number; lng: number }> = {
      'wh-la': { name: 'Los Angeles DC', lat: 33.94, lng: -118.41 },
      'wh-chicago': { name: 'Chicago DC', lat: 41.88, lng: -87.63 },
      'wh-rotterdam': { name: 'Rotterdam DC', lat: 51.92, lng: 4.48 },
      'wh-singapore': { name: 'Singapore DC', lat: 1.35, lng: 103.82 },
      'dist-west': { name: 'West Coast Dist.', lat: 37.77, lng: -122.42 },
      'dist-east': { name: 'East Coast Dist.', lat: 40.71, lng: -74.01 },
      'dist-eu': { name: 'EU Distribution', lat: 50.11, lng: 8.68 },
      'dist-apac': { name: 'APAC Distribution', lat: 22.32, lng: 114.17 },
    };

    const originHub = hubs[input.origin] ?? { name: input.origin, lat: 40, lng: -90 };
    const destHub = hubs[input.destination] ?? { name: input.destination, lat: 42, lng: -88 };

    const baseDistance = Math.abs(originHub.lat - destHub.lat) * 111 + Math.abs(originHub.lng - destHub.lng) * 85;
    const baseCostPerPallet = 12.50 + baseDistance * 0.008;
    const baseTransitDays = Math.max(1, Math.round(baseDistance / 800));

    const currentRoute = {
      path: [originHub.name, destHub.name],
      distance: Math.round(baseDistance),
      costPerPallet: parseFloat(baseCostPerPallet.toFixed(2)),
      totalCost: parseFloat((baseCostPerPallet * input.shipmentSize).toFixed(2)),
      transitDays: baseTransitDays,
      co2Kg: parseFloat((baseDistance * 0.05 * input.shipmentSize * 0.001).toFixed(1)),
    };

    // Optimized route with intermediate hub
    const savings = input.priority === 'cost' ? 0.18 : input.priority === 'speed' ? 0.08 : 0.13;
    const speedUp = input.priority === 'speed' ? 0.30 : input.priority === 'cost' ? 0.05 : 0.15;

    const optimizedCostPerPallet = parseFloat((baseCostPerPallet * (1 - savings)).toFixed(2));
    const optimizedTransitDays = Math.max(1, Math.round(baseTransitDays * (1 - speedUp)));

    const optimizedRoute = {
      path: [originHub.name, 'Dallas Consolidation Hub', destHub.name],
      distance: Math.round(baseDistance * 0.95),
      costPerPallet: optimizedCostPerPallet,
      totalCost: parseFloat((optimizedCostPerPallet * input.shipmentSize).toFixed(2)),
      transitDays: optimizedTransitDays,
      co2Kg: parseFloat((baseDistance * 0.95 * 0.04 * input.shipmentSize * 0.001).toFixed(1)),
    };

    return JSON.stringify({
      optimizationId: 'OPT-' + Date.now(),
      status: 'proposed',
      priority: input.priority,
      shipmentSize: input.shipmentSize,
      currentRoute,
      optimizedRoute,
      savings: {
        costSavings: parseFloat((currentRoute.totalCost - optimizedRoute.totalCost).toFixed(2)),
        costSavingsPercent: parseFloat((savings * 100).toFixed(1)),
        transitDaysSaved: currentRoute.transitDays - optimizedRoute.transitDays,
        co2Reduction: parseFloat((currentRoute.co2Kg - optimizedRoute.co2Kg).toFixed(1)),
      },
      timestamp: new Date().toISOString(),
    });
  },
});
