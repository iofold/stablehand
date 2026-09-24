import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@stablehand/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      '@stablehand/client': resolve(__dirname, 'packages/client/src/index.ts'),
      '@stablehand/contracts/harness': resolve(__dirname, 'packages/contracts/src/harness.ts'),
      '@stablehand/contracts': resolve(__dirname, 'packages/contracts/src/index.ts'),
      '@stablehand/manifest/node': resolve(__dirname, 'packages/manifest/src/node.ts'),
      '@stablehand/manifest': resolve(__dirname, 'packages/manifest/src/index.ts'),
      '@stablehand/sandbox-daemon/harness/model-gateway': resolve(__dirname, 'packages/sandbox-daemon/src/harness/model-gateway.ts'),
      '@stablehand/sandbox-daemon/harness/schemas': resolve(__dirname, 'packages/sandbox-daemon/src/harness/schemas.ts'),
      '@stablehand/sandbox-daemon': resolve(__dirname, 'packages/sandbox-daemon/src/index.ts'),
      '@stablehand/proto/sandbox/v1': resolve(__dirname, 'packages/proto/gen/stablehand/sandbox/v1/sandbox_pb.ts'),
      '@earendil-works/pi-ai': resolve(__dirname, 'packages/sandbox-daemon/node_modules/@earendil-works/pi-ai'),
      '@earendil-works/pi-coding-agent': resolve(
        __dirname,
        'packages/sandbox-daemon/node_modules/@earendil-works/pi-coding-agent',
      ),
    },
  },
  test: {
    include: [
      'tests/**/*.test.ts',
      'packages/stablehand/**/*.test.ts',
      'packages/manifest/**/*.test.ts',
      'packages/sandbox-daemon/**/*.test.ts',
      'packages/examples/**/*.test.ts',
      // Contract/client/react suites used to live outside every CI entry
      // point — passing locally, guarded by nothing.
      'packages/contracts/**/*.test.ts',
      'packages/client/**/*.test.ts',
      'extensions/**/*.test.ts',
    ],
    exclude: ['tests/e2e/**', '**/node_modules/**', '**/dist/**'],
    setupFiles: ['./tests/setup-strict.ts'],
    fileParallelism: false,
    teardownTimeout: 5000,
    server: {
      deps: {
        inline: [/@langchain\//, /@earendil-works\//],
      },
    },
  },
});
