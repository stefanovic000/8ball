import { defineConfig } from 'vite';

// The dev server proxies /ws to the Node game server so the browser only
// ever talks to one origin. In production the same server serves dist/.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:8787',
        ws: true,
      },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
