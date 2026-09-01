import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against a stack that is already up
 * (`docker compose up` or `pnpm dev`). They exercise the demo path the README
 * promises: create research, watch the pipeline execute, review, export.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  // CI uploads apps/web/playwright-report on failure, so CI has to actually
  // produce one: the list reporter writes to stdout and leaves no files behind.
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // CI images and dev containers often ship a Chromium already. Point at it
    // with PLAYWRIGHT_CHROMIUM_PATH instead of downloading a second copy.
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
      : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
