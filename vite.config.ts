import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import checker from 'vite-plugin-checker'

// An absolute project root, so the type check does not depend on the cwd the
// build runs from.
const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  build: {
    // A Node build: dependencies stay external and no browser shims are added.
    ssr: 'src/index.ts',
    outDir: 'plugin',
    target: 'node22',
    sourcemap: true,
    rolldownOptions: {
      output: { format: 'es', entryFileNames: 'index.js' }
    }
  },
  // Vite only transpiles; the checker fails the build on any type error.
  plugins: [checker({ typescript: { root: here, tsconfigPath: 'tsconfig.json' } })]
})
