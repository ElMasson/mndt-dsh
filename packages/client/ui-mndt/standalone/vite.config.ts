/**
 * Build of the standalone team page: a static `index.html` and its hashed files, React included,
 * nothing from the DSH runtime. The workbench API serves the output (`lib/team/`) and the gateway
 * relays `/` and `/team-assets/*` to it; `team-assets` never meets the owner's DSH `/assets`.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: here,
  base: '/',
  logLevel: 'warn',
  esbuild: { jsx: 'automatic' },
  // The page speaks to the product API of a local bench while developing.
  server: {
    proxy: { '/mndt-api': process.env.MNDT_API ?? 'http://127.0.0.1:8080' },
  },
  build: {
    outDir: fileURLToPath(new URL('../lib/team', import.meta.url)),
    emptyOutDir: true,
    assetsDir: 'team-assets',
    // The logo travels inside the bundle, as in the plugin build.
    assetsInlineLimit: 16384,
    sourcemap: false,
  },
})
