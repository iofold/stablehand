import { z } from 'zod';

export function parseHarnessConfig<T>(schema: z.ZodType<T>, configJson: string): T {
  return schema.parse(JSON.parse(z.string().parse(configJson)));
}
