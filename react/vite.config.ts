import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.ORBIT_STAGING_URL || 'https://orbit-staging.example.workers.dev';

export default defineConfig({
  root: '.',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true, secure: true },
      '/__orbit': { target, changeOrigin: true, secure: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
