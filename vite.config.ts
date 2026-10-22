import { defineConfig } from 'vite';

export default defineConfig({
  root: 'frontend',
  server: { port: 3030, proxy: { '/api': 'http://127.0.0.1:8000' } },
  build: { outDir: '../src/kuro/static', emptyOutDir: true, sourcemap: false },
});