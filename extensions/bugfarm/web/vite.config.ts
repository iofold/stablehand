import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// The worker serves the built page from dist/web. `pnpm dev:web` proxies the
// board API to a running worker (BUGFARM_DEV_API, default localhost:8095).
export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, '../dist/web'),
    emptyOutDir: true,
    sourcemap: false,
  },
  css: {
    postcss: resolve(__dirname),
  },
  server: {
    port: Number(process.env.BUGFARM_DEV_PORT ?? 5195),
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: process.env.BUGFARM_DEV_API ?? 'http://localhost:8095',
        changeOrigin: true,
      },
    },
  },
});
