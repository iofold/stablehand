import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@ctxmill/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // ctx-0zk: strict console gate fails the test on any unexpected
    // console.error/warn unless allowConsoleErrors() is called.
    setupFiles: ['./src/test-setup-strict.ts'],
  },
});
