import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 90 * 60 * 1000,
  expect: { timeout: 10_000 },
  // Each site/device pair owns an isolated browser context, so three workers can
  // run safely without changing coverage or sharing page state.
  fullyParallel: true,
  workers: 3,
  // A full shard can contain hundreds of pages; retry failures at the page/action
  // level in the test instead of rerunning an entire shard from the beginning.
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }]
  ],
  use: {
    ignoreHTTPSErrors: true,
    navigationTimeout: 30_000,
    actionTimeout: 10_000,
    launchOptions: {
      // Reading/scrolling pauses live in the test itself. A small action delay
      // keeps clicks human-like without multiplying a full-site audit by hours.
      slowMo: 120
    },
    screenshot: 'only-on-failure',
    // Text inventories name the exact page/control/resource. Recording every page
    // in a full shard produced multi-gigabyte artifacts and did not add diagnosis.
    trace: 'off',
    video: 'off'
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }
    },
    {
      name: 'mobile-chromium',
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        viewport: { width: 390, height: 844 }
      }
    }
  ]
});
