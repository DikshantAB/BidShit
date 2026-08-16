import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// Isolated-world content script as a single classic (IIFE) file: dist/content-script.js
export default defineConfig({
  resolve: { alias: { '@': resolve(root, 'src') } },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    target: 'chrome111',
    lib: {
      entry: resolve(root, 'src/content-script.ts'),
      formats: ['iife'],
      name: 'BidShitterContent',
      fileName: () => 'content-script.js',
    },
    rollupOptions: {
      output: { extend: true },
    },
  },
});
