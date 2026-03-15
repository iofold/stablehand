import { defineTool } from 'ctxmill';
import { z } from 'zod';

export default defineTool({
  name: 'calculator',
  description: 'Perform basic arithmetic: add, subtract, multiply, divide',
  input: z.object({
    operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
    a: z.number(),
    b: z.number(),
  }),
  handler: async (input) => {
    const { operation, a, b } = input;
    let result: number;
    switch (operation) {
      case 'add': result = a + b; break;
      case 'subtract': result = a - b; break;
      case 'multiply': result = a * b; break;
      case 'divide':
        if (b === 0) return 'Error: division by zero';
        result = a / b;
        break;
    }
    return `${a} ${operation} ${b} = ${result!}`;
  },
});
