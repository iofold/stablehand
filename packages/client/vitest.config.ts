import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@stablehand/contracts': new URL('../contracts/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
