// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://orbit.example.com',
  build: { format: 'directory' },
  devToolbar: { enabled: false },
});
