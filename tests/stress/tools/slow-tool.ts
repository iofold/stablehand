import { defineTool } from 'ctxmill';
import { z } from 'zod';

export default defineTool({
  name: 'slow-tool',
  description: 'Deliberately slow tool that sleeps for the specified duration. For stress testing timeouts.',
  input: z.object({
    durationMs: z.number().min(100).max(30000).describe('Sleep duration in milliseconds'),
    label: z.string().optional().describe('Label to include in the response'),
  }),
  async handler({ durationMs, label }) {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    return `slow-tool completed after ${durationMs}ms${label ? ` (${label})` : ''}`;
  },
});
