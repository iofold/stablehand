import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@ctxmill/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      '@ctxmill/proto/sandbox/v1': resolve(__dirname, 'packages/proto/gen/ctxmill/sandbox/v1/sandbox_pb.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/ctxmill/**/*.test.ts', 'packages/examples/**/*.test.ts'],
    setupFiles: ['./tests/setup-strict.ts'],
    server: {
      deps: {
        inline: [/@langchain\//],
      },
    },
  },
});
