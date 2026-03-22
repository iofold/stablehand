import { defineTool } from 'ctxmill';
import { z } from 'zod';

export default defineTool({
  name: 'crash-tool',
  description: 'Deliberately throws an error. For stress testing error propagation.',
  input: z.object({
    message: z.string().default('Intentional crash for stress testing'),
  }),
  async handler({ message }) {
    throw new Error(message);
  },
});
