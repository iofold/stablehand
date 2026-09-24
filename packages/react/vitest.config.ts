import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@stablehand/client': new URL('../client/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
