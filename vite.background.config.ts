import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// Service worker built as a single classic (IIFE) file: dist/background.js
export default defineConfig({
  resolve: { alias: { '@': resolve(root, 'src') } },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    target: 'chrome111',
    lib: {
      entry: resolve(root, 'src/background.ts'),
      formats: ['iife'],
      name: 'BidShitterBackground',
      fileName: () => 'background.js',
    },
    rollupOptions: {
      output: { extend: true },
    },
  },
});
