import { defineTool } from 'stablehand';
import { z } from 'zod';

export default defineTool({
  name: 'large-output-tool',
  description: 'Returns a large payload to stress test streaming. Generates repeated data of the specified size.',
  input: z.object({
    sizeKb: z.number().min(1).max(512).describe('Approximate output size in kilobytes'),
  }),
  async handler({ sizeKb }) {
    const chunk = 'STRESS_DATA_BLOCK_' + '='.repeat(80) + '\n';
    const repeats = Math.ceil((sizeKb * 1024) / chunk.length);
    return chunk.repeat(repeats);
  },
});
