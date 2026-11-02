import { defineConfig } from 'vite'

// Node built-ins stay external: the `./node` entry really runs on them, and the browser
// entry must never reach them (DR-002). The explicit "browser bundle contains no node:*"
// build guard is M2 work (#4) — externals here only keep Rolldown from inlining them.
const nodeBuiltin = /^node:/

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    // Not a shipped-minified library yet: readable output keeps the M0 diff reviewable.
    minify: false,
    target: 'es2022',
    lib: {
      // Two entries == the two runtime faces of the package (DR-002, DR-021).
      entry: {
        index: 'src/index.ts',
        node: 'src/node.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: (id: string) => nodeBuiltin.test(id),
    },
  },
})
