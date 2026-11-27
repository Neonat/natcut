import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testMatch: 'sprite-review.spec.ts',
  outputDir: '../test-results/sprite-review',
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },
});
