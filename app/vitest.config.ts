import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: { environment: 'node', setupFiles: ['./src/tests/setup.ts'], include: ['src/tests/**/*.test.ts'], restoreMocks: true },
})
