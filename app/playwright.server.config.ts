import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'server-storage.spec.ts',
  workers: 1,
  timeout: 90_000,
  use: { trace: 'retain-on-failure' },
})
