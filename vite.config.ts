import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// Pages build: DevTools page + panel React app.
// Copies everything in public/ (manifest.json, icons) to dist/.
// The background, content-script, and page-hook are built as separate
// single-file IIFE bundles by the other vite.*.config.ts files.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(root, 'src') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome111',
    rollupOptions: {
      input: {
        panel: resolve(root, 'index.html'),
        devtools: resolve(root, 'devtools.html'),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
