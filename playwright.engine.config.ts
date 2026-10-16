import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './qa-regression', timeout: 120000, fullyParallel: true, workers: 2,
  reporter: [['list']], outputDir: 'test-results/engine',
  use: { serviceWorkers: 'block' },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['iPhone 13'], browserName: 'chromium' } }
  ]
});
