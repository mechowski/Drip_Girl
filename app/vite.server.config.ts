import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: { alias: [
    { find: /^@\/domain\/adminSession$/, replacement: fromRoot('./server/repository-store.mjs') },
    { find: '@', replacement: fromRoot('./src') },
  ] },
  plugins: [{
    name: 'server-persistence',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './db' && importer?.includes('/src/persistence/')) {
        return fromRoot('./server/repository-store.mjs')
      }
    },
  }],
  build: {
    ssr: fromRoot('./server/repository-entry.ts'),
    outDir: 'server-dist',
    rollupOptions: { output: { entryFileNames: 'repository.mjs' } },
  },
})
