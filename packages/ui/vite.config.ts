import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@ctxmill/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    port: parseInt(process.env.CTXMILL_UI_PORT || '3200', 10),
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: process.env.CTXMILL_API_ORIGIN || 'http://orchestrator:3001',
        changeOrigin: true,
      },
    },
  },
});
