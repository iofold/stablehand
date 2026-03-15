import { defineTool } from 'ctxmill';
import { z } from 'zod';

export default defineTool({
  name: 'weather',
  description: 'Look up current weather for a city (mock data)',
  input: z.object({
    city: z.string(),
  }),
  handler: async (input) => {
    const cities: Record<string, string> = {
      'new york': '72\u00b0F, Partly Cloudy',
      'london': '58\u00b0F, Overcast',
      'tokyo': '68\u00b0F, Clear',
      'sydney': '75\u00b0F, Sunny',
    };
    const weather = cities[input.city.toLowerCase()] ?? '65\u00b0F, Fair';
    return `Weather in ${input.city}: ${weather}`;
  },
});
