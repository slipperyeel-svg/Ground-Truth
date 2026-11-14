import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths, so the built app works from any folder (e.g. GitHub Pages).
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { host: true },
});
