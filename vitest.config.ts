import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@ctxmill/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/ctxmill/**/*.test.ts'],
    server: {
      deps: {
        inline: [/@langchain\//],
      },
    },
  },
});
