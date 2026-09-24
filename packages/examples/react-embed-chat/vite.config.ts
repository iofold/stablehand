import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@stablehand/client': new URL('../../client/src/index.ts', import.meta.url).pathname,
      '@stablehand/react': new URL('../../react/src/index.ts', import.meta.url).pathname,
    },
  },
  server: {
    port: Number(process.env.STABLEHAND_EMBED_EXAMPLE_PORT ?? 3300),
    proxy: {
      '/api': {
        target: process.env.STABLEHAND_API_PROXY_TARGET ?? 'http://localhost:3002',
        changeOrigin: true,
      },
    },
  },
});
