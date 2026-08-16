import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// MAIN-world page hook as a single classic (IIFE) file: dist/page-hook.js
// Must be self-contained (no ES imports left) so it runs as a classic content script.
export default defineConfig({
  resolve: { alias: { '@': resolve(root, 'src') } },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    target: 'chrome111',
    lib: {
      entry: resolve(root, 'src/page-hook.ts'),
      formats: ['iife'],
      name: 'BidShitterHook',
      fileName: () => 'page-hook.js',
    },
    rollupOptions: {
      output: { extend: true },
    },
  },
});
