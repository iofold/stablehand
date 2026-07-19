import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@ctxmill/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      '@ctxmill/client': resolve(__dirname, 'packages/client/src/index.ts'),
      '@ctxmill/contracts/harness': resolve(__dirname, 'packages/contracts/src/harness.ts'),
      '@ctxmill/contracts': resolve(__dirname, 'packages/contracts/src/index.ts'),
      '@ctxmill/manifest/node': resolve(__dirname, 'packages/manifest/src/node.ts'),
      '@ctxmill/manifest': resolve(__dirname, 'packages/manifest/src/index.ts'),
      '@ctxmill/sandbox-daemon/harness/schemas': resolve(__dirname, 'packages/sandbox-daemon/src/harness/schemas.ts'),
      '@ctxmill/sandbox-daemon': resolve(__dirname, 'packages/sandbox-daemon/src/index.ts'),
      '@ctxmill/proto/sandbox/v1': resolve(__dirname, 'packages/proto/gen/ctxmill/sandbox/v1/sandbox_pb.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/ctxmill/**/*.test.ts', 'packages/manifest/**/*.test.ts', 'packages/sandbox-daemon/**/*.test.ts', 'packages/examples/**/*.test.ts'],
    exclude: ['tests/e2e/**', '**/node_modules/**', '**/dist/**'],
    setupFiles: ['./tests/setup-strict.ts'],
    fileParallelism: false,
    teardownTimeout: 5000,
    server: {
      deps: {
        inline: [/@langchain\//],
      },
    },
  },
});
