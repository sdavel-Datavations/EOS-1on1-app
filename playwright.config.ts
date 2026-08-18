import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'tests',
  // Removes the accounts each run creates. SKIP_TEST_CLEANUP=1 to keep them for
  // debugging a failure.
  globalTeardown: './tests/global-teardown.ts',
  timeout: 30_000,
  expect: { timeout: 5000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.DEPLOY_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    headless: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
})
