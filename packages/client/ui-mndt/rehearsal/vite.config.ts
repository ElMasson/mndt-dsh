/**
 * Build of the rehearsal page (simulated data, never served by the workbench): `rehearsal/dist`.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), base: './', logLevel: 'warn', esbuild: { jsx: 'automatic' }, build: { outDir: fileURLToPath(new URL('./dist', import.meta.url)), emptyOutDir: true } })
