import { fileURLToPath } from 'node:url'

import { federation } from '@module-federation/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import checker from 'vite-plugin-checker'

import packageJson from './package.json' with { type: 'json' }

const here = fileURLToPath(new URL('.', import.meta.url))
const shim = (name: string): string =>
  fileURLToPath(new URL(`src/configpanel/host-shim/${name}`, import.meta.url))

// The configuration panel the admin UI loads in place of the schema form.
export default defineConfig({
  // React comes from the admin UI: a second copy would give the panel's hooks a dispatcher the host never set.
  resolve: {
    alias: [
      { find: /^react\/jsx-(dev-)?runtime$/, replacement: shim('react-jsx-runtime.ts') },
      { find: /^react$/, replacement: shim('react.ts') }
    ]
  },
  plugins: [
    react(),
    federation({
      name: packageJson.name.replace(/[-@/]/g, '_'),
      filename: 'remoteEntry.js',
      exposes: { './PluginConfigurationPanel': './src/configpanel/PluginConfigurationPanel.tsx' },
      shared: {},
      dts: false
    }),
    checker({ typescript: { root: here, tsconfigPath: 'src/configpanel/tsconfig.json' } })
  ],
  publicDir: false,
  build: {
    outDir: 'public',
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    cssCodeSplit: false,
    rolldownOptions: {
      input: './src/configpanel/PluginConfigurationPanel.tsx',
      preserveEntrySignatures: 'exports-only',
      output: {
        format: 'es',
        entryFileNames: 'configpanel-entry.js',
        chunkFileNames: 'chunks/[name]-[hash].js'
      }
    }
  }
})
