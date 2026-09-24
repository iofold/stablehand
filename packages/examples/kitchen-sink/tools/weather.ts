import { defineTool } from 'stablehand';
import { z } from 'zod';

export default defineTool({
  name: 'weather',
  description: 'Look up current weather for a city (mock data)',
  input: z.object({
    location: z.string().describe('City or location name'),
    units: z.enum(['celsius', 'fahrenheit']).default('fahrenheit').optional().describe('Temperature units'),
  }),
  handler: async (rawInput) => {
    const input = rawInput as {
      location: string;
      units?: 'celsius' | 'fahrenheit';
    };
    const cities: Record<string, { f: string; c: string }> = {
      'new york': { f: '72°F, Partly Cloudy', c: '22°C, Partly Cloudy' },
      'london': { f: '58°F, Overcast', c: '14°C, Overcast' },
      'tokyo': { f: '68°F, Clear', c: '20°C, Clear' },
      'sydney': { f: '75°F, Sunny', c: '24°C, Sunny' },
    };
    const units = input.units || 'fahrenheit';
    const key = units === 'celsius' ? 'c' : 'f';
    const weather = cities[input.location.toLowerCase()]?.[key] ?? (units === 'celsius' ? '18°C, Fair' : '65°F, Fair');
    return `Weather in ${input.location}: ${weather}`;
  },
});
