import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Artifacts are served under /go/{slug}/ — assets must resolve relatively.
  base: './',
  resolve: {
    alias: {
      '@stablehand/client': new URL('../../client/src/index.ts', import.meta.url).pathname,
      '@stablehand/contracts': new URL('../../contracts/src/index.ts', import.meta.url).pathname,
      '@stablehand/react': new URL('../../react/src/index.ts', import.meta.url).pathname,
      // The chart catalog lives in the ui package and imports via '@/...'.
      '@': new URL('../../ui/src', import.meta.url).pathname,
    },
  },
  server: {
    port: Number(process.env.STABLEHAND_ARTIFACT_CONSOLE_PORT ?? 3310),
  },
});
