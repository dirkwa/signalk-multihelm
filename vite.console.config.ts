import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import checker from 'vite-plugin-checker'

const here = fileURLToPath(new URL('.', import.meta.url))

// The console web app, served by Signal K from `public/` at /signalk-multihelm/.
// It runs on its own page, so it bundles its own React, unlike the panel.
export default defineConfig({
  root: 'src/console',
  base: './',
  plugins: [
    react(),
    checker({ typescript: { root: here, tsconfigPath: 'src/console/tsconfig.json' } })
  ],
  // The icon the admin UI's Webapps list and the browser tab show.
  publicDir: fileURLToPath(new URL('static', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('public', import.meta.url)),
    // The panel's build has just written its files there.
    emptyOutDir: false,
    target: 'es2022',
    assetsDir: 'console'
  }
})
