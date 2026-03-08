import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      ctxmill: resolve(__dirname, '../../ctxmill/src/index.ts'),
    },
  },
});
